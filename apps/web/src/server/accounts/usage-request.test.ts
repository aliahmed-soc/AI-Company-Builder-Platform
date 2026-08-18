/*
 * ACBP-API-011 — the account usage rollup surface (ACBP-P6-009; CDR-073; trust-critical #14).
 *
 * THE AUTHORIZATION IS NOT TESTED HERE, because it does not live here: `usage:read` is checked inside
 * `readAccountUsageRollup`, resolved from the caller's ACCOUNT membership, and the binding evidence is
 * `usage-rollup-service.integration.test.ts` against real PostgreSQL. What this layer is held to is that it adds no
 * second authority, cannot widen what core disclosed, and cannot turn "never measured" into a number.
 */
import { describe, expect, it, vi } from 'vitest';
import { getAccountUsageForRequest, type UsageOps, type UsageRequestDeps } from './usage-request.js';
import { toUsageResponse } from './usage-http.js';

const FIGURES = { eventCount: 12, inputTokens: 3400, outputTokens: 900, estimatedCostMicros: 45_000 } as const;

function deps(readResult: unknown, spy?: (params: unknown) => void): UsageRequestDeps {
  const usage: UsageOps = {
    checkRequestLimit: () => Promise.resolve({ kind: 'allowed' } as const),
    ensurePersonalAccount: () => Promise.resolve({ accountId: 'acct_session', created: false } as never),
    readAccountUsageRollup: (params) => {
      spy?.(params);
      return Promise.resolve(readResult as never);
    },
  };
  return {
    usage,
    // `ResolveInternalUserDeps` WRAPS the identity boundary under its own `identity` key and takes a separate
    // `resolve`. Getting this nesting wrong does not fail loudly — it silently resolves `session_unavailable`, so
    // every assertion below turns red for a reason that has nothing to do with what it tests. Spelled out rather
    // than cast, so the shape is checked by the compiler.
    identity: {
      identity: {
        getUserId: () => Promise.resolve('clerk_1'),
        getSessionId: () => Promise.resolve('sess_test'),
        // REQUIRED, never defaulted — a limiter that defaults to allowed is the P6-007 stop-port defect.
        checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
        getBackendUser: () =>
          Promise.resolve({
            id: 'clerk_1',
            primaryEmailAddressId: 'e1',
            emailAddresses: [{ id: 'e1', emailAddress: 'me@example.com', verification: { status: 'verified' } }],
            firstName: null,
            lastName: null,
          }),
      },
      // The PROVIDER id is `clerk_1`; the INTERNAL id is `usr_internal`. They are deliberately different here so
      // the assertions below can tell which one core actually receives — a surface that forwarded the provider id
      // would still look plausible if both were spelled the same.
      resolve: () => Promise.resolve({ status: 'active', userId: 'usr_internal' } as never),
    },
  };
}

describe('"never computed" is never rendered as a number', () => {
  it('not_computed is a 200 carrying NULL, not a 404 and not zeroes', async () => {
    /*
     * THE ROW THIS SUITE EXISTS FOR. Core distinguishes "computed and zero" from "never computed" deliberately —
     * only the first is safe to show as a total. A 404 would assert the period does not exist (false, and an error
     * page on a normal first visit); a zeroed body would report a measurement nobody took.
     */
    const res = toUsageResponse({ status: 'not_computed', periodStart: '2026-08-01' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['usage']).toBeNull();
    expect(body['periodStart']).toBe('2026-08-01');
    // Explicitly NOT a zeroed figure set — the assertion that would have caught a "helpful" default.
    expect(JSON.stringify(body)).not.toContain('eventCount');
  });

  it('a period whose figures ARE zero is a real reading, and looks different', async () => {
    const zero = { status: 'ok', periodStart: '2026-08-01', figures: { eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 }, computedAt: new Date('2026-08-19T00:00:00Z') };
    const r = await getAccountUsageForRequest('2026-08-01', deps(zero));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.usage.eventCount).toBe(0);
  });
});

describe('the figures are an allowlist', () => {
  it('publishes exactly the five named fields — a lane added to core does not publish itself', async () => {
    const withExtra = { status: 'ok', periodStart: '2026-08-01', figures: { ...FIGURES, unbilledSecretLane: 999 }, computedAt: new Date('2026-08-19T00:00:00Z') };
    const r = await getAccountUsageForRequest('2026-08-01', deps(withExtra));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(Object.keys(r.usage).sort()).toEqual(['computedAt', 'estimatedCostMicros', 'eventCount', 'inputTokens', 'outputTokens', 'periodStart']);
      expect(JSON.stringify(r.usage)).not.toContain('999');
    }
  });

  it('computedAt becomes an ISO string, because a Date does not survive JSON', async () => {
    const r = await getAccountUsageForRequest('2026-08-01', deps({ status: 'ok', periodStart: '2026-08-01', figures: FIGURES, computedAt: new Date('2026-08-19T00:00:00Z') }));
    if (r.status === 'ok') expect(r.usage.computedAt).toBe('2026-08-19T00:00:00.000Z');
  });

  it('an UNREADABLE computedAt does not throw — the whole screen must not 500 over one column', async () => {
    const r = await getAccountUsageForRequest('2026-08-01', deps({ status: 'ok', periodStart: '2026-08-01', figures: FIGURES, computedAt: 'not-a-date' }));
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.usage.computedAt).toBe('not-a-date');
  });
});

describe('the account is the session\'s, and the period is the caller\'s', () => {
  it('the accountId sent to core comes from the SESSION, never from the request', async () => {
    // There is no account selector on this surface at all, which makes "read another account's spend"
    // unexpressible rather than merely refused. This pins that the id core receives is the provisioned one.
    const seen = vi.fn();
    await getAccountUsageForRequest('2026-08-01', deps({ status: 'not_computed', periodStart: '2026-08-01' }, seen));
    // `usr_internal`, NOT `clerk_1`: core must receive the INTERNAL user id, never the provider's. Passing the
    // provider id would authorize against an identity the database does not own.
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct_session', userId: 'usr_internal' }));
  });

  it('periodStart is forwarded RAW, including garbage — refusing it is core\'s ruling', async () => {
    const seen = vi.fn();
    await getAccountUsageForRequest({ nested: 'object' }, deps({ status: 'invalid_period' }, seen));
    // Re-validating the YYYY-MM-01 shape here would be a second authority that drifts from `isUsagePeriodStart`.
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ periodStart: { nested: 'object' } }));
  });

  it('an absent periodStart reaches core as undefined and comes back invalid — never defaulted to "this month"', async () => {
    const seen = vi.fn();
    const r = await getAccountUsageForRequest(undefined, deps({ status: 'invalid_period' }, seen));
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ periodStart: undefined }));
    // A server-chosen default would hand a client plausible figures for a period it never named.
    expect(r.status).toBe('invalid_period');
    expect(toUsageResponse(r).status).toBe(400);
  });
});

describe('a denial discloses nothing about why', () => {
  it('the AccountAccessDenialReason is dropped, not echoed', async () => {
    const r = await getAccountUsageForRequest('2026-08-01', deps({ status: 'denied', reason: 'no_active_membership' }));
    expect(r).toEqual({ status: 'forbidden' });
    // The reason would let a caller enumerate account state. "Not allowed" and "not a member" answer alike.
    expect(JSON.stringify(r)).not.toContain('membership');
  });

  it('forbidden and denied are indistinguishable on the wire', async () => {
    const a = toUsageResponse(await getAccountUsageForRequest('2026-08-01', deps({ status: 'denied', reason: 'account_not_found' })));
    const b = toUsageResponse(await getAccountUsageForRequest('2026-08-01', deps({ status: 'forbidden' })));
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });
});
