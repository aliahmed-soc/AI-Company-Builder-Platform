// ACBP-P6-009 / CDR-073 — the input guards, proven WITHOUT a database.
//
// WHY THIS FILE EXISTS. Everything else this ticket adds to `@acbp/core` is a `describe.skipIf(!hasTestDatabase)`
// suite, and there is no local PostgreSQL — so those suites SKIP, and a skipped run is never green. That is the
// accepted arrangement for anything needing real RLS. But `readThreshold`, `readDeltas` and `readReason` need no
// database at all: they run BEFORE any scope is established, and an independent review found that deleting the
// NaN branch from `readThreshold` left `pnpm test` entirely green locally. A guard whose only witness is a
// suite that does not run is a guard nobody is watching.
//
// THE STUB CLIENT IS PART OF THE ASSERTION, NOT SCAFFOLDING. Every property access on it throws, so these tests
// pass ONLY if the refusal happens before the database is touched. That is the actual claim — "refused BEFORE any
// scope is established or any row written" — and it is otherwise the kind of thing a comment asserts and nothing
// checks. If a validator were moved inside the transaction, these tests fail loudly rather than quietly passing.
import { describe, test, expect } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { reconcileAccountUsageRollup, rebuildAccountUsageRollup, readAccountUsageRollup } from './usage-rollup-service.js';
import { recordUsageCorrection } from './usage-correction-service.js';

/** A client that cannot be used. Touching ANY property throws, so reaching the database fails the test. */
const NO_DATABASE = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the database was touched (property ${String(property)}) — this input should have been refused first`);
    },
  },
) as unknown as DatabaseClient;

const USER = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const EVENT = '44444444-4444-4444-8444-444444444444';
const VALID_THRESHOLD = { eventCount: 0, inputTokens: 10, outputTokens: 10, estimatedCostMicros: 100 };

describe('reconcileAccountUsageRollup — the threshold guard (launch gate 7)', () => {
  const reconcile = (threshold: unknown, periodStart: unknown = '2026-08-01') =>
    reconcileAccountUsageRollup(NO_DATABASE, { userId: USER, accountId: ACCOUNT, periodStart, threshold });

  // ⚠️ THE ONE THAT MATTERS. `Math.abs(x) > NaN` is false for every x, so an unrefused NaN does not alert and
  // does not throw — it silently switches OFF drift alerting for that lane, in the single mechanism launch gate 7
  // relies on to notice a wrong number. NaN reaches a threshold easily: `Number(undefined)`, `Number('')` from an
  // unset config value, or `parseInt` of a malformed setting.
  test('a NaN tolerance in ANY lane is refused', async () => {
    for (const lane of ['eventCount', 'inputTokens', 'outputTokens', 'estimatedCostMicros'] as const) {
      const threshold = { ...VALID_THRESHOLD, [lane]: NaN };
      const result = await reconcile(threshold);
      expect(result.status, `NaN in lane ${lane} must be refused`).toBe('invalid_threshold');
    }
  });

  test('a non-finite, fractional, negative or non-numeric tolerance is refused', async () => {
    for (const bad of [
      undefined,
      null,
      42,
      'zero',
      {},
      [],
      { eventCount: 0, inputTokens: 0, outputTokens: 0 }, // a lane missing entirely
      { ...VALID_THRESHOLD, inputTokens: -1 },
      { ...VALID_THRESHOLD, inputTokens: 1.5 },
      { ...VALID_THRESHOLD, inputTokens: Infinity },
      { ...VALID_THRESHOLD, inputTokens: -Infinity },
      { ...VALID_THRESHOLD, inputTokens: '10' }, // a string that would coerce in a comparison
    ]) {
      const result = await reconcile(bad);
      expect(result.status, `threshold ${JSON.stringify(bad)} must be refused`).toBe('invalid_threshold');
    }
  });

  // THE CONTROL. Without it, "refuses bad thresholds" and "refuses every threshold" are the same test — and a
  // validator that rejected everything would pass every assertion above.
  test('a VALID tolerance is NOT refused — it proceeds far enough to touch the database', async () => {
    await expect(reconcile(VALID_THRESHOLD)).rejects.toThrow(/the database was touched/);
  });

  test('the period is refused before the threshold is even considered', async () => {
    // A malformed period with a VALID threshold: still refused, still without a database.
    for (const bad of ['2026-08-17', 'not-a-date', '', '2026-13-01', '0000-01-01']) {
      const result = await reconcile(VALID_THRESHOLD, bad);
      expect(result.status, `period ${JSON.stringify(bad)} must be refused`).toBe('invalid_period');
    }
  });
});

describe('the period guard, on every use case that takes one', () => {
  // `'0000-01-01'` matches a naive `\d{4}` year pattern but is not a date PostgreSQL accepts, so before it was
  // excluded it passed this guard, established a scope, and raised 22008 deep in the aggregation.
  const BAD_PERIODS = ['2026-08-17', 'not-a-date', '', '2026-13-01', '2026-00-01', '0000-01-01'];

  test('rebuildAccountUsageRollup refuses a malformed period without a database', async () => {
    for (const bad of BAD_PERIODS) {
      const result = await rebuildAccountUsageRollup(NO_DATABASE, { userId: USER, accountId: ACCOUNT, periodStart: bad });
      expect(result.status, `period ${JSON.stringify(bad)}`).toBe('invalid_period');
    }
  });

  test('readAccountUsageRollup refuses a malformed period without a database', async () => {
    for (const bad of BAD_PERIODS) {
      const result = await readAccountUsageRollup(NO_DATABASE, { userId: USER, accountId: ACCOUNT, periodStart: bad });
      expect(result.status, `period ${JSON.stringify(bad)}`).toBe('invalid_period');
    }
  });

  test('a WELL-FORMED period is accepted by both — the control', async () => {
    await expect(rebuildAccountUsageRollup(NO_DATABASE, { userId: USER, accountId: ACCOUNT, periodStart: '2026-08-01' })).rejects.toThrow(/the database was touched/);
    await expect(readAccountUsageRollup(NO_DATABASE, { userId: USER, accountId: ACCOUNT, periodStart: '2026-08-01' })).rejects.toThrow(/the database was touched/);
  });
});

describe('recordUsageCorrection — the delta and reason guards (trust-critical #13)', () => {
  const base = {
    userId: USER,
    accountId: ACCOUNT,
    companyId: COMPANY,
    correctsUsageEventId: EVENT,
    eventCountDelta: 0,
    inputTokensDelta: -10,
    outputTokensDelta: 0,
    estimatedCostMicrosDelta: -100,
    reason: 'duplicate provider charge',
  };
  const correct = (over: Record<string, unknown> = {}) => recordUsageCorrection(NO_DATABASE, { ...base, ...over });

  test('a POSITIVE delta in any lane is refused — usage can only ever be reduced (§1-G10a)', async () => {
    for (const lane of ['eventCountDelta', 'inputTokensDelta', 'outputTokensDelta', 'estimatedCostMicrosDelta'] as const) {
      const result = await correct({ [lane]: 1 });
      expect(result.status, `positive ${lane} must be refused`).toBe('invalid_delta');
    }
  });

  test('a non-integer, NaN or non-finite delta is refused', async () => {
    for (const bad of [-1.5, NaN, Infinity, -Infinity, '-10', null, undefined, {}]) {
      const result = await correct({ inputTokensDelta: bad });
      expect(result.status, `delta ${JSON.stringify(bad)} must be refused`).toBe('invalid_delta');
    }
  });

  // The columns are int4. Below its floor PostgreSQL rejects the BIND with 22003, which happens before the
  // magnitude trigger and is not a code `classifyCorrectionFailure` recognises — so the caller would get a thrown
  // internal error instead of the typed refusal that is the honest answer.
  test('a delta below the int4 floor is refused rather than left to the driver', async () => {
    expect((await correct({ inputTokensDelta: -2_147_483_649 })).status).toBe('invalid_delta');
    expect((await correct({ inputTokensDelta: -3_000_000_000 })).status).toBe('invalid_delta');
  });

  test('an ALL-ZERO correction is refused — it would consume the event\'s one correction slot for nothing', async () => {
    const result = await correct({ eventCountDelta: 0, inputTokensDelta: 0, outputTokensDelta: 0, estimatedCostMicrosDelta: 0 });
    expect(result.status).toBe('invalid_delta');
  });

  test('a blank, missing, non-string or over-long reason is refused', async () => {
    for (const bad of ['', '   ', '\t\n', null, undefined, 42, 'x'.repeat(501)]) {
      const result = await correct({ reason: bad });
      expect(result.status, `reason ${JSON.stringify(bad)} must be refused`).toBe('invalid_reason');
    }
  });

  test('the delta guard runs BEFORE the reason guard, and both before any database access', async () => {
    // Both invalid: the delta refusal wins, and neither reaches a scope.
    expect((await correct({ inputTokensDelta: 5, reason: '' })).status).toBe('invalid_delta');
  });

  // THE CONTROL, for the same reason as above: a validator that refused everything would satisfy every
  // assertion in this block.
  test('a VALID correction is NOT refused — it proceeds far enough to touch the database', async () => {
    await expect(correct()).rejects.toThrow(/the database was touched/);
  });

  test('the int4 floor itself is ACCEPTED — the bound is inclusive, not off by one', async () => {
    await expect(correct({ inputTokensDelta: -2_147_483_648 })).rejects.toThrow(/the database was touched/);
  });

  test('a maximum-length reason is ACCEPTED — the bound is inclusive', async () => {
    await expect(correct({ reason: 'x'.repeat(500) })).rejects.toThrow(/the database was touched/);
  });
});
