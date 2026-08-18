// @acbp/core — RequestLimitService unit coverage (ACBP-API-008; CDR-092 §2, §6.3).
//
// WHY THIS FILE EXISTS. Before ACBP-API-008 this service had NO unit test. Its only coverage was the real-PG
// bucket suite (which exercises the SQL, not this function's branching) and a stubbed seam in
// `verified-identity.test.ts` (which replaces this function entirely). So the fail-closed branch — CDR-092 §6.3,
// one of the four named money guards — had nothing that could fail if it were inverted. That was found while
// trying to mutation-test it: the mutation had nothing to kill it, which is a coverage gap, not a passing guard.
//
// `consumeBucket` is the seam. These tests never touch a database; the real-PG behaviour is proven separately in
// `packages/database/src/integration/rate-limit-buckets.integration.test.ts`.
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { REQUEST_LIMIT_DEFAULTS } from '@acbp/config';

const consumeBucket = vi.hoisted(() => vi.fn());
vi.mock('@acbp/database', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  consumeBucket,
}));

const { checkRequestLimit } = await import('./request-limit-service.js');

/** The service only reaches `.kysely`, and the mock ignores it. */
const client = { kysely: {} } as never;

describe('checkRequestLimit — ACBP-API-008 / CDR-092 §2', () => {
  // Per test, not per file: the empty-key case asserts the seam was NOT reached, and a counter carried over from
  // an earlier test would make that assertion pass or fail for reasons having nothing to do with the empty key.
  beforeEach(() => {
    consumeBucket.mockReset();
  });

  test('an allowed consumption is reported allowed', async () => {
    consumeBucket.mockResolvedValueOnce({ allowed: true, remainingMilli: 5_000 });
    expect(await checkRequestLimit(client, 'company', 'company_a')).toEqual({ kind: 'allowed' });
  });

  test('a refused consumption is throttled AND names the scope that refused', async () => {
    consumeBucket.mockResolvedValueOnce({ allowed: false, remainingMilli: 0 });
    const outcome = await checkRequestLimit(client, 'company', 'company_a');
    expect(outcome.kind).toBe('throttled');
    // Without the scope a throttled founder cannot tell "I am clicking too fast" from "my company is busy".
    if (outcome.kind !== 'throttled') throw new Error('unreachable');
    expect(outcome.scope).toBe('company');
    expect(outcome.retryAfterSeconds).toBeGreaterThan(0);
  });

  // ── CDR-092 §6.3 — THE FAIL-CLOSED GUARD ───────────────────────────────────────────────────────────────────
  test('a bucket that cannot be consulted is UNAVAILABLE — never allowed', async () => {
    consumeBucket.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    // If the bucket cannot be read, nothing is bounded — admitting would be unbounded by definition, and a
    // limiter that fails open fails open exactly during the database trouble a traffic flood causes.
    expect(await checkRequestLimit(client, 'company', 'company_a')).toEqual({ kind: 'unavailable' });
  });

  test('unavailable is reported as unavailable, NOT as throttled', async () => {
    consumeBucket.mockRejectedValueOnce(new Error('boom'));
    const outcome = await checkRequestLimit(client, 'company', 'company_a');
    // Telling a caller "you are sending too many requests" when the truth is "we could not tell" is the same
    // class of lie as reporting 0 when the meaning is "we could not count" (CDR-076).
    expect(outcome.kind).not.toBe('throttled');
    expect(outcome.kind).toBe('unavailable');
  });

  test('SECURITY: the failure path never carries the provider exception text or the scope KEY', async () => {
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    consumeBucket.mockRejectedValueOnce(new Error('password authentication failed for user "acbp_app"'));
    await checkRequestLimit(client, 'company', 'company_SENSITIVE_ID', { logger: logger as never });
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain('password authentication failed');
    // A rate-limit log line is the highest-volume place an identifier could accumulate at scale.
    expect(logged).not.toContain('company_SENSITIVE_ID');
    expect(logged).toContain('company');
  });

  test('an empty key is unavailable, not a shared bucket', async () => {
    // Metering everything with an absent key under ONE bucket would let any caller throttle every other caller.
    expect(await checkRequestLimit(client, 'company', '')).toEqual({ kind: 'unavailable' });
    expect(consumeBucket).not.toHaveBeenCalled();
  });

  // ── THE COMPANY RULE IS THE COMPANY RULE ───────────────────────────────────────────────────────────────────
  test('the company scope consumes against companyPerMinute — NOT the read-sized account ceiling', async () => {
    consumeBucket.mockResolvedValueOnce({ allowed: true, remainingMilli: 1 });
    await checkRequestLimit(client, 'company', 'company_a');

    const passed = consumeBucket.mock.calls[0]?.[1] as { capacityMilli: number; scopeKind: string };
    expect(passed.scopeKind).toBe('company');
    // 5/min with no burst → capacity equals the rate. Pinned as a NUMBER because the whole point of the ceiling
    // is that it is two orders of magnitude below `accountPerMinute` (300); wiring it to the wrong default would
    // leave every test above green while permitting 60x the intended spend rate.
    expect(REQUEST_LIMIT_DEFAULTS.companyPerMinute).toBe(5);
    expect(passed.capacityMilli).toBe(REQUEST_LIMIT_DEFAULTS.companyPerMinute * 1000);
    expect(passed.capacityMilli).not.toBe(REQUEST_LIMIT_DEFAULTS.accountPerMinute * 1000);
  });

  test('each scope kind consumes against its own rule', async () => {
    for (const [kind, perMinute] of [
      ['session', REQUEST_LIMIT_DEFAULTS.sessionBurst],
      ['account', REQUEST_LIMIT_DEFAULTS.accountPerMinute],
      ['company', REQUEST_LIMIT_DEFAULTS.companyPerMinute],
    ] as const) {
      consumeBucket.mockClear();
      consumeBucket.mockResolvedValueOnce({ allowed: true, remainingMilli: 1 });
      await checkRequestLimit(client, kind, 'k');
      const passed = consumeBucket.mock.calls[0]?.[1] as { capacityMilli: number };
      expect(passed.capacityMilli).toBe(perMinute * 1000);
    }
  });
});
