// @acbp/core — unit tests for the membership-backed account-context resolver (ACBP-P1-005; CDR-012).
import { describe, it, expect } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import { isResolvedAccountContext, isDeniedAccountContext } from '@acbp/contracts';
import { resolveAccountContextWithStore, type AccountMembershipStore } from './account-context-resolver.js';

/** A fake store that records every membership lookup and answers from a predicate. */
function storeWith(active: (accountId: string, userId: string) => boolean): AccountMembershipStore & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    hasActiveMembership(accountId, userId) {
      calls.push([accountId, userId]);
      return Promise.resolve(active(accountId, userId));
    },
  };
}

describe('resolveAccountContextWithStore', () => {
  it('resolves an account context when the caller has an active membership', async () => {
    const store = storeWith(() => true);
    const r = await resolveAccountContextWithStore(store, { userId: 'usr_1', requestedAccountId: 'acc_1' });
    expect(isResolvedAccountContext(r)).toBe(true);
    if (!isResolvedAccountContext(r)) throw new Error('expected resolved');
    expect(r.context).toEqual({ accountId: 'acc_1', actorId: 'usr_1' });
  });

  it('denies (membership_not_active) when there is no active membership', async () => {
    const store = storeWith(() => false);
    const r = await resolveAccountContextWithStore(store, { userId: 'usr_1', requestedAccountId: 'acc_1' });
    expect(isDeniedAccountContext(r)).toBe(true);
    if (!isDeniedAccountContext(r)) throw new Error('expected denied');
    expect(r.reason).toBe('membership_not_active');
  });

  it('treats the requested account id ONLY as a request — authority is the store lookup', async () => {
    // The user is active in acc_A but requests acc_B → the store is consulted for acc_B and denies.
    const store = storeWith((accountId) => accountId === 'acc_A');
    const r = await resolveAccountContextWithStore(store, { userId: 'usr_1', requestedAccountId: 'acc_B' });
    expect(isDeniedAccountContext(r)).toBe(true);
    expect(store.calls).toEqual([['acc_B', 'usr_1']]); // validated against the REQUESTED account
  });

  it('is deterministic under multiple memberships — keyed to the explicit requested account', async () => {
    const store = storeWith((accountId) => accountId === 'acc_A' || accountId === 'acc_B');
    const rA = await resolveAccountContextWithStore(store, { userId: 'usr_1', requestedAccountId: 'acc_A' });
    const rB = await resolveAccountContextWithStore(store, { userId: 'usr_1', requestedAccountId: 'acc_B' });
    expect(isResolvedAccountContext(rA) && rA.context.accountId).toBe('acc_A');
    expect(isResolvedAccountContext(rB) && rB.context.accountId).toBe('acc_B');
  });

  it('denies (account_not_specified) for a blank account id WITHOUT consulting the store', async () => {
    const store = storeWith(() => true);
    const r = await resolveAccountContextWithStore(store, { userId: 'usr_1', requestedAccountId: '   ' });
    expect(isDeniedAccountContext(r) && r.reason).toBe('account_not_specified');
    expect(store.calls).toEqual([]); // never queried — no existence signal from a blank request
  });

  it('denies (account_not_specified) for a blank user id WITHOUT consulting the store', async () => {
    const store = storeWith(() => true);
    const r = await resolveAccountContextWithStore(store, { userId: '', requestedAccountId: 'acc_1' });
    expect(isDeniedAccountContext(r) && r.reason).toBe('account_not_specified');
    expect(store.calls).toEqual([]);
  });

  it('trims surrounding whitespace on ids before lookup and in the resolved context', async () => {
    const store = storeWith(() => true);
    const r = await resolveAccountContextWithStore(store, { userId: '  usr_1  ', requestedAccountId: '  acc_1  ' });
    expect(isResolvedAccountContext(r) && r.context).toEqual({ accountId: 'acc_1', actorId: 'usr_1' });
    expect(store.calls).toEqual([['acc_1', 'usr_1']]);
  });

  it('emits a non-PII tenant.context_denied audit event on denial and nothing on success', async () => {
    const denyStore = storeWith(() => false);
    const okStore = storeWith(() => true);

    const t1 = createTestLogger({ component: 'tenancy' });
    await resolveAccountContextWithStore(denyStore, { userId: 'usr_9', requestedAccountId: 'acc_9' }, { logger: t1.logger });
    const denied = t1.records.filter((r) => r.event === 'tenant.context_denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.level).toBe('warn');
    expect(denied[0]?.metadata).toMatchObject({ reason: 'membership_not_active', accountId: 'acc_9', actorId: 'usr_9' });

    const t2 = createTestLogger({ component: 'tenancy' });
    await resolveAccountContextWithStore(okStore, { userId: 'usr_9', requestedAccountId: 'acc_9' }, { logger: t2.logger });
    expect(t2.records.filter((r) => r.event === 'tenant.context_denied')).toHaveLength(0);
  });

  it('denial audit carries no email/token/PII — only opaque ids + a coarse reason', async () => {
    const t = createTestLogger({ component: 'tenancy' });
    await resolveAccountContextWithStore(storeWith(() => false), { userId: 'usr_x', requestedAccountId: 'acc_x' }, { logger: t.logger });
    const serialized = JSON.stringify(t.records);
    expect(serialized).not.toMatch(/@|token|secret|password|email/i);
  });
});
