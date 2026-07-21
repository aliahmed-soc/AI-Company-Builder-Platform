// @acbp/contracts — tests for the provider-neutral account-context contract (ACBP-P1-005; CDR-012).
import { describe, it, expect } from 'vitest';
import {
  resolvedAccountContext,
  deniedAccountContext,
  isResolvedAccountContext,
  isDeniedAccountContext,
  accountAccessDeniedEnvelope,
  type AccountContext,
} from './account-context.js';

describe('account-context contract', () => {
  it('builds a resolved resolution carrying the account context', () => {
    const ctx: AccountContext = { accountId: 'acc_1', actorId: 'usr_1' };
    const r = resolvedAccountContext(ctx);
    expect(r).toEqual({ kind: 'resolved', context: { accountId: 'acc_1', actorId: 'usr_1' } });
    expect(isResolvedAccountContext(r)).toBe(true);
    expect(isDeniedAccountContext(r)).toBe(false);
  });

  it('supports an account context with no actor', () => {
    const r = resolvedAccountContext({ accountId: 'acc_2' });
    if (!isResolvedAccountContext(r)) throw new Error('expected resolved');
    expect(r.context.accountId).toBe('acc_2');
    expect(r.context.actorId).toBeUndefined();
  });

  it('never carries a company identifier on the account context', () => {
    const ctx: AccountContext = { accountId: 'acc_3', actorId: 'usr_3' };
    expect(Object.keys(ctx).sort()).toEqual(['accountId', 'actorId']);
    expect('companyId' in ctx).toBe(false);
  });

  it('builds denied resolutions for each stable reason', () => {
    const a = deniedAccountContext('membership_not_active');
    const b = deniedAccountContext('account_not_specified');
    expect(isDeniedAccountContext(a)).toBe(true);
    expect(isResolvedAccountContext(a)).toBe(false);
    if (!isDeniedAccountContext(a) || !isDeniedAccountContext(b)) throw new Error('expected denied');
    expect(a.reason).toBe('membership_not_active');
    expect(b.reason).toBe('account_not_specified');
  });

  it('maps ANY denial to one opaque authz envelope (no existence/state oracle)', () => {
    const e1 = accountAccessDeniedEnvelope();
    const e2 = accountAccessDeniedEnvelope();
    expect(e1.category).toBe('authz');
    expect(e1.code).toBe('AUTHORIZATION_DENIED');
    expect(e1.retryable).toBe(false);
    // Identical regardless of the (private) reason — a denial reveals nothing about why.
    expect(e1).toEqual(e2);
    // The public envelope leaks no reason, account id, or membership state.
    expect(JSON.stringify(e1)).not.toMatch(/membership|account|invited|revoked|reason/i);
  });

  it('passes through a correlation id when provided', () => {
    const e = accountAccessDeniedEnvelope('corr-123');
    expect(e.correlationId).toBe('corr-123');
  });
});
