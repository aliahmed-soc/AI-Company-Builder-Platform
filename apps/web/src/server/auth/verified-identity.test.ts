// ACBP-P1-001 — server request-boundary tests. The Clerk Next.js server helpers are injected via
// VerifiedIdentityDeps, so these run offline with no live instance, no network, and no credentials.
// Mocks return plain resolved/rejected promises (no `async` without `await`).
import { describe, test, expect } from 'vitest';
import { resolveVerifiedIdentity } from './verified-identity.js';
import type { VerifiedIdentityDeps } from './verified-identity.js';

type BackendUser = Awaited<ReturnType<VerifiedIdentityDeps['getBackendUser']>>;

function user(overrides: Partial<BackendUser> = {}): BackendUser {
  return {
    id: 'user_123',
    primaryEmailAddressId: 'ema_1',
    emailAddresses: [
      { id: 'ema_1', emailAddress: 'person@example.com', verification: { status: 'verified' } },
    ],
    firstName: 'Ada',
    lastName: 'Lovelace',
    ...overrides,
  };
}

function deps(over: Partial<VerifiedIdentityDeps> = {}): VerifiedIdentityDeps {
  return {
    getUserId: () => Promise.resolve('user_123'),
    // ACBP-P7-013: both REQUIRED, never defaulted — a limiter that defaults to allowed is the
    // P6-007 stop-port defect (CDR-072 section 1-G1). A test that wants to be admitted says so.
    getSessionId: () => Promise.resolve('sess_test'),
    checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
    getBackendUser: () => Promise.resolve(user()),
    ...over,
  };
}

describe('resolveVerifiedIdentity (server request boundary)', () => {
  test('rejects an unauthenticated request (no session user id)', async () => {
    const r = await resolveVerifiedIdentity(deps({ getUserId: () => Promise.resolve(null) }));
    expect(r.status).toBe('unauthenticated');
  });

  test('rejects an empty-string user id (fail-closed)', async () => {
    const r = await resolveVerifiedIdentity(deps({ getUserId: () => Promise.resolve('') }));
    expect(r.status).toBe('unauthenticated');
  });

  test('accepts an authenticated request with a verified primary email', async () => {
    const r = await resolveVerifiedIdentity(deps({}));
    expect(r.status).toBe('authenticated');
    if (r.status !== 'authenticated') throw new Error('unreachable');
    expect(r.identity.providerUserId).toBe('user_123');
    expect(r.identity.email).toBe('person@example.com');
    expect(r.identity.emailVerified).toBe(true);
    expect(r.identity.displayName).toBe('Ada Lovelace');
  });

  test('rejects when the primary email is not verified', async () => {
    const r = await resolveVerifiedIdentity(
      deps({
        // ACBP-P7-013: both REQUIRED, never defaulted — a limiter that defaults to allowed is the
        // P6-007 stop-port defect (CDR-072 section 1-G1). A test that wants to be admitted says so.
        getSessionId: () => Promise.resolve('sess_test'),
        checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
        getBackendUser: () =>
          Promise.resolve(
            user({
              emailAddresses: [
                { id: 'ema_1', emailAddress: 'person@example.com', verification: { status: 'unverified' } },
              ],
            }),
          ),
      }),
    );
    expect(r.status).toBe('email_unverified');
  });

  test('rejects when there is no primary email address (fail-closed)', async () => {
    const r = await resolveVerifiedIdentity(
      deps({ getBackendUser: () => Promise.resolve(user({ primaryEmailAddressId: null })) }),
    );
    expect(r.status).toBe('email_unverified');
  });

  test('rejects when a non-primary email is verified but the primary is not present', async () => {
    const r = await resolveVerifiedIdentity(
      deps({
        // ACBP-P7-013: both REQUIRED, never defaulted — a limiter that defaults to allowed is the
        // P6-007 stop-port defect (CDR-072 section 1-G1). A test that wants to be admitted says so.
        getSessionId: () => Promise.resolve('sess_test'),
        checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
        getBackendUser: () =>
          Promise.resolve(
            user({
              primaryEmailAddressId: 'ema_primary',
              emailAddresses: [
                { id: 'ema_other', emailAddress: 'other@example.com', verification: { status: 'verified' } },
              ],
            }),
          ),
      }),
    );
    expect(r.status).toBe('email_unverified');
  });

  test('treats a session-resolution failure as provider-unavailable, never authenticated', async () => {
    const r = await resolveVerifiedIdentity(
      deps({ getUserId: () => Promise.reject(new Error('clerk down')) }),
    );
    expect(r.status).toBe('unavailable');
  });

  test('treats a Backend User fetch failure as provider-unavailable (fail-closed)', async () => {
    const r = await resolveVerifiedIdentity(
      deps({ getBackendUser: () => Promise.reject(new Error('network')) }),
    );
    expect(r.status).toBe('unavailable');
  });

  test('derives identity only from the trusted server session + Backend User, ignoring extra claims', async () => {
    // Even if the Backend User object carries extra provider fields, only neutral identity is exposed.
    const r = await resolveVerifiedIdentity(
      deps({
        // ACBP-P7-013: both REQUIRED, never defaulted — a limiter that defaults to allowed is the
        // P6-007 stop-port defect (CDR-072 section 1-G1). A test that wants to be admitted says so.
        getSessionId: () => Promise.resolve('sess_test'),
        checkSessionLimit: () => Promise.resolve({ kind: 'allowed' } as const),
        getBackendUser: () =>
          Promise.resolve({
            ...user(),
            // Non-neutral fields that must never leak into NormalizedIdentity:
            publicMetadata: { role: 'admin', orgId: 'org_evil' },
          } as unknown as BackendUser),
      }),
    );
    expect(r.status).toBe('authenticated');
    if (r.status !== 'authenticated') throw new Error('unreachable');
    expect(Object.keys(r.identity).sort()).toEqual(['displayName', 'email', 'emailVerified', 'providerUserId']);
  });

  // ── ACBP-P7-013 / CDR-081: the per-session request ceiling is ENFORCED HERE ─────────────────────────────
  //
  // These are the assertions that make this a control rather than a function that exists. ACBP-P7-002 found a
  // gate whose predicate had zero production callers, and ACBP-P6-010 shipped a ceiling no caller passes; the
  // only difference between those and this one is whether a test drives the real path. Every case below goes
  // through `resolveVerifiedIdentity` itself — the function all five protected surfaces call.
  describe('the per-session rate limit (ACBP-P7-013; CDR-008 section 8)', () => {
    test('a throttled session is refused, and the refusal carries retry advice', async () => {
      const r = await resolveVerifiedIdentity(
        deps({ checkSessionLimit: () => Promise.resolve({ kind: 'throttled', scope: 'session', retryAfterSeconds: 7 } as const) }),
      );
      expect(r.status).toBe('rate_limited');
      if (r.status !== 'rate_limited') throw new Error('unreachable');
      expect(r.retryAfterSeconds).toBe(7);
    });

    test('THE ORDERING: a throttled request never reaches the Clerk Backend API', async () => {
      // The assertion that justifies where the check sits (CDR-081 §3.3). `getBackendUser` is a NETWORK
      // call on every protected request; limiting after it would leave the most expensive per-request
      // dependency unbounded. If this ever goes green with the call counted, the limiter has been moved behind
      // the thing it exists to protect.
      let backendCalls = 0;
      const r = await resolveVerifiedIdentity(
        deps({
          checkSessionLimit: () => Promise.resolve({ kind: 'throttled', scope: 'session', retryAfterSeconds: 1 } as const),
          getBackendUser: () => {
            backendCalls += 1;
            return Promise.resolve(user());
          },
        }),
      );
      expect(r.status).toBe('rate_limited');
      expect(backendCalls).toBe(0);
    });

    test('the limiter is keyed on the SESSION id, not the user id', async () => {
      // CDR-008 section 8 rules a per-SESSION ceiling. Collapsing it onto the user would silently make the
      // limit stricter than the accepted decision, which is still a departure from it.
      const seen: string[] = [];
      await resolveVerifiedIdentity(
        deps({
          getUserId: () => Promise.resolve('user_123'),
          getSessionId: () => Promise.resolve('sess_abc'),
          checkSessionLimit: (sessionId) => {
            seen.push(sessionId);
            return Promise.resolve({ kind: 'allowed' } as const);
          },
        }),
      );
      expect(seen).toEqual(['sess_abc']);
    });

    test('an unreadable limit reports UNAVAILABLE, never throttled', async () => {
      // Telling a caller "you are sending too many requests" when the truth is "we could not tell" is the
      // same class of lie as reporting 0 when the count failed (CDR-076). Different statuses, different meanings.
      const r = await resolveVerifiedIdentity(deps({ checkSessionLimit: () => Promise.resolve({ kind: 'unavailable' } as const) }));
      expect(r.status).toBe('unavailable');
    });

    test('a session with no id FAILS CLOSED rather than sharing one unmeterable bucket', async () => {
      // Metering every keyless request under one shared bucket would let any caller throttle every other
      // caller — a protection turned into a denial-of-service primitive.
      let limitCalls = 0;
      const r = await resolveVerifiedIdentity(
        deps({
          getSessionId: () => Promise.resolve(null),
          checkSessionLimit: () => {
            limitCalls += 1;
            return Promise.resolve({ kind: 'allowed' } as const);
          },
        }),
      );
      expect(r.status).toBe('unavailable');
      expect(limitCalls).toBe(0);
    });

    test('an UNAUTHENTICATED request is not metered — it has no verified key to meter', async () => {
      // CDR-081 section 6.1 states this as a LIMITATION rather than a feature: unauthenticated traffic is
      // bounded by nothing in this repository. This test pins the stated behaviour so the gap cannot close by
      // accident and go unrecorded, nor widen into a shared bucket.
      let limitCalls = 0;
      const r = await resolveVerifiedIdentity(
        deps({
          getUserId: () => Promise.resolve(null),
          checkSessionLimit: () => {
            limitCalls += 1;
            return Promise.resolve({ kind: 'allowed' } as const);
          },
        }),
      );
      expect(r.status).toBe('unauthenticated');
      expect(limitCalls).toBe(0);
    });

    test('an admitted request proceeds normally — the limiter does not refuse everything', async () => {
      // The mandatory control: without it, "correctly refuses a throttled session" and "refuses everything"
      // are indistinguishable (the ACBP-P6-005 lesson).
      const r = await resolveVerifiedIdentity(deps());
      expect(r.status).toBe('authenticated');
    });
  });
});
