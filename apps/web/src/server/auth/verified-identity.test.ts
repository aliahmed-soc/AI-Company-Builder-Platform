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
});
