// ACBP-P1-002 Slice 3 — Clerk authoritative read-through reader tests. Deterministic + OFFLINE via an
// injected fetchUser seam; no network, no real secret. Fake identities only.
import { describe, test, expect } from 'vitest';
import { loadTestClerkConfig } from '@acbp/config';
import { ClerkAuthoritativeIdentityReader, type ClerkBackendUserFetch, type ClerkBackendUserView } from './read-through.js';

const QUERY = { provider: 'clerk', providerInstanceId: 'ins_expected', providerUserId: 'user_1' } as const;

function backendUser(over: Partial<ClerkBackendUserView> = {}): ClerkBackendUserView {
  return {
    id: 'user_1',
    primaryEmailAddressId: 'ema_1',
    emailAddresses: [{ id: 'ema_1', emailAddress: 'Person@Example.com', verification: { status: 'verified' } }],
    createdAt: 1699990000000,
    updatedAt: 1700000000000,
    ...over,
  };
}
function reader(fetchUser: ClerkBackendUserFetch, expectedInstanceId = 'ins_expected') {
  return new ClerkAuthoritativeIdentityReader({ config: loadTestClerkConfig(), expectedInstanceId, fetchUser });
}

describe('ClerkAuthoritativeIdentityReader — found', () => {
  test('normalizes a found user into a neutral snapshot (email lowercased, verified, dates, instance)', async () => {
    const r = await reader(() => Promise.resolve(backendUser())).read(QUERY);
    expect(r.status).toBe('found');
    if (r.status !== 'found') throw new Error('unreachable');
    expect(r.snapshot).toEqual({
      provider: 'clerk',
      providerInstanceId: 'ins_expected', // authoritative instance, not from the query beyond provider
      providerUserId: 'user_1',
      primaryEmail: 'person@example.com',
      emailVerified: true,
      providerCreatedAt: new Date(1699990000000),
      providerUpdatedAt: new Date(1700000000000),
    });
  });

  test('an unverified primary email is stored as false', async () => {
    const user = backendUser({ emailAddresses: [{ id: 'ema_1', emailAddress: 'p@example.com', verification: { status: 'unverified' } }] });
    const r = await reader(() => Promise.resolve(user)).read(QUERY);
    if (r.status !== 'found') throw new Error('unreachable');
    expect(r.snapshot.emailVerified).toBe(false);
  });

  test('a verified NON-primary email does not set the primary verified', async () => {
    const user = backendUser({
      primaryEmailAddressId: 'ema_primary',
      emailAddresses: [
        { id: 'ema_primary', emailAddress: 'primary@example.com', verification: { status: 'unverified' } },
        { id: 'ema_other', emailAddress: 'other@example.com', verification: { status: 'verified' } },
      ],
    });
    const r = await reader(() => Promise.resolve(user)).read(QUERY);
    if (r.status !== 'found') throw new Error('unreachable');
    expect(r.snapshot.primaryEmail).toBe('primary@example.com');
    expect(r.snapshot.emailVerified).toBe(false);
  });

  test('a missing primary email maps to null / false', async () => {
    const r = await reader(() => Promise.resolve(backendUser({ primaryEmailAddressId: null, emailAddresses: [] }))).read(QUERY);
    if (r.status !== 'found') throw new Error('unreachable');
    expect(r.snapshot.primaryEmail).toBeNull();
    expect(r.snapshot.emailVerified).toBe(false);
  });

  test('a missing provider created time maps to null', async () => {
    const r = await reader(() => Promise.resolve(backendUser({ createdAt: Number.NaN }))).read(QUERY);
    if (r.status !== 'found') throw new Error('unreachable');
    expect(r.snapshot.providerCreatedAt).toBeNull();
  });
});

describe('ClerkAuthoritativeIdentityReader — not_found / unavailable / config', () => {
  test('a 404 provider error → not_found (create nothing)', async () => {
    const r = await reader(() => Promise.reject(Object.assign(new Error('not found'), { status: 404 }))).read(QUERY);
    expect(r.status).toBe('not_found');
  });

  test('a network/unknown provider error → sanitized unavailable (no raw detail leaks)', async () => {
    const leaky = Object.assign(new Error('ECONNRESET whsec_leak person@example.com'), { status: 503 });
    const r = await reader(() => Promise.reject(leaky)).read(QUERY);
    expect(r.status).toBe('unavailable');
    if (r.status !== 'unavailable') throw new Error('unreachable');
    expect(r.error.retryable).toBe(true); // provider_unavailable is retryable
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/whsec_|person@example\.com|ECONNRESET/i);
    expect(Object.keys(r.error).every((k) => ['category', 'code', 'message', 'retryable', 'correlationId'].includes(k))).toBe(true);
  });

  test('a missing required expected instance id fails safely as unavailable (no throw)', async () => {
    let called = false;
    const r = await reader(() => {
      called = true;
      return Promise.resolve(backendUser());
    }, '').read(QUERY);
    expect(r.status).toBe('unavailable');
    expect(called).toBe(false); // never contacts the provider when misconfigured
  });

  test('a malformed provider user (no id) → unavailable', async () => {
    const r = await reader(() => Promise.resolve(backendUser({ id: '' }))).read(QUERY);
    expect(r.status).toBe('unavailable');
  });

  test('no raw provider object escapes: the result contains only neutral snapshot fields', async () => {
    const r = await reader(() => Promise.resolve(backendUser())).read(QUERY);
    if (r.status !== 'found') throw new Error('unreachable');
    expect(Object.keys(r.snapshot).sort()).toEqual(
      ['emailVerified', 'primaryEmail', 'provider', 'providerCreatedAt', 'providerInstanceId', 'providerUpdatedAt', 'providerUserId'].sort(),
    );
  });
});
