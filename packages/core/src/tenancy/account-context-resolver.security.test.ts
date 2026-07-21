// @acbp/core — SECURITY invariants for the account-context resolver (ACBP-P1-005; CDR-012). These make
// the trust-critical negatives explicit: the resolver's ONLY inputs are the SERVER-VERIFIED userId and the
// REQUESTED accountId — it has no header/cookie/route parameter it could trust, and a requested account is
// never honoured without an ACTIVE membership. "caller-controlled header/cookie" and "route/body mismatch"
// all reduce to: an arbitrary requested account id is validated against membership, deny-by-default.
import { describe, it, expect } from 'vitest';
import { isResolvedAccountContext, isDeniedAccountContext } from '@acbp/contracts';
import { resolveAccountContextWithStore, type AccountMembershipStore } from './account-context-resolver.js';

function storeWith(active: (accountId: string, userId: string) => boolean): AccountMembershipStore {
  return { hasActiveMembership: (accountId, userId) => Promise.resolve(active(accountId, userId)) };
}

describe('account-context resolver — security invariants (ACBP-P1-005; CDR-012)', () => {
  it('a caller-controlled / forged account id (as if from a header, cookie, or URL) grants nothing without an active membership', async () => {
    const store = storeWith(() => false); // the caller has NO active membership anywhere
    for (const forged of ['acc_admin', 'acc_other_tenant', '../../etc', '00000000-0000-0000-0000-000000000000', "'; drop table memberships;--"]) {
      const r = await resolveAccountContextWithStore(store, { userId: 'attacker', requestedAccountId: forged });
      expect(isDeniedAccountContext(r) && r.reason).toBe('membership_not_active');
    }
  });

  it('a route/body account MISMATCH is validated against the SUPPLIED account — never substituted from another membership', async () => {
    // The caller is a member of acc_true only. A request naming acc_claimed is validated against
    // acc_claimed (and denied); the resolver never silently resolves acc_true instead.
    const store = storeWith((accountId) => accountId === 'acc_true');
    expect(isDeniedAccountContext(await resolveAccountContextWithStore(store, { userId: 'u', requestedAccountId: 'acc_claimed' }))).toBe(true);
    expect(isResolvedAccountContext(await resolveAccountContextWithStore(store, { userId: 'u', requestedAccountId: 'acc_true' }))).toBe(true);
  });

  it('the resolved actor is ALWAYS the server-verified user id, never a request-supplied value', async () => {
    const store = storeWith(() => true);
    const r = await resolveAccountContextWithStore(store, { userId: 'server_verified_user', requestedAccountId: 'acc_1' });
    expect(isResolvedAccountContext(r) && r.context.actorId).toBe('server_verified_user');
  });

  it('membership is re-checked on EVERY resolution (no caching) — a flip to inactive denies the next call', async () => {
    let active = true;
    const store: AccountMembershipStore = { hasActiveMembership: () => Promise.resolve(active) };
    expect(isResolvedAccountContext(await resolveAccountContextWithStore(store, { userId: 'u', requestedAccountId: 'a' }))).toBe(true);
    active = false; // e.g. the membership was revoked between requests
    expect(isDeniedAccountContext(await resolveAccountContextWithStore(store, { userId: 'u', requestedAccountId: 'a' }))).toBe(true);
  });

  it('missing account context fails closed (blank account or user) without a membership lookup', async () => {
    let consulted = false;
    const store: AccountMembershipStore = {
      hasActiveMembership: () => {
        consulted = true;
        return Promise.resolve(true);
      },
    };
    expect(isDeniedAccountContext(await resolveAccountContextWithStore(store, { userId: 'u', requestedAccountId: '' }))).toBe(true);
    expect(isDeniedAccountContext(await resolveAccountContextWithStore(store, { userId: '', requestedAccountId: 'a' }))).toBe(true);
    expect(consulted).toBe(false);
  });
});
