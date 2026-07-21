// @acbp/core — central authorization check tests (ACBP-P1-007). Decision parity with the contract matrix,
// plus the denial-audit guarantee (non-PII) and the allow-is-silent guarantee.
import { describe, test, expect } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import { checkAuthorization, isAuthorized } from './authz-service.js';

describe('checkAuthorization — decision parity + audit', () => {
  test('an allow returns allow and emits NO audit event (allows are silent)', () => {
    const { logger, records } = createTestLogger({ component: 'authz' });
    const decision = checkAuthorization('owner', 'member:invite', { accountId: 'acc_1', actorId: 'u_1' }, { logger });
    expect(decision).toEqual({ kind: 'allow' });
    expect(records).toHaveLength(0);
  });

  test('an insufficient-role denial returns deny and audits a non-PII authz.denied event', () => {
    const { logger, records } = createTestLogger({ component: 'authz' });
    const decision = checkAuthorization('viewer', 'member:invite', { accountId: 'acc_1', actorId: 'u_v' }, { logger });
    expect(decision).toEqual({ kind: 'deny', reason: 'insufficient_role' });
    const ev = records.filter((r) => r.event === 'authz.denied');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.metadata).toEqual({ action: 'member:invite', reason: 'insufficient_role', accountId: 'acc_1', actorId: 'u_v' });
  });

  test('a null role (no active membership) denies with not_a_member and audits', () => {
    const { logger, records } = createTestLogger({ component: 'authz' });
    const decision = checkAuthorization(null, 'member:list', { accountId: 'acc_2', actorId: 'stranger' }, { logger });
    expect(decision).toEqual({ kind: 'deny', reason: 'not_a_member' });
    expect(records.filter((r) => r.event === 'authz.denied')).toHaveLength(1);
  });

  test('the audit event carries no email, token, or Clerk identifier — only opaque ids + coarse reason', () => {
    const { logger, records } = createTestLogger({ component: 'authz' });
    checkAuthorization('viewer', 'member:read_invited_email', { accountId: 'acc_1', actorId: 'u_v' }, { logger });
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('@'); // no email
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('clerk');
  });

  test('viewer MAY list members (allow, silent)', () => {
    const { logger, records } = createTestLogger({ component: 'authz' });
    expect(checkAuthorization('viewer', 'member:list', { accountId: 'a', actorId: 'u' }, { logger })).toEqual({ kind: 'allow' });
    expect(records).toHaveLength(0);
  });

  test('does not throw when no logger is supplied (audit is best-effort)', () => {
    expect(() => checkAuthorization('viewer', 'member:invite', { accountId: 'a', actorId: 'u' })).not.toThrow();
    expect(checkAuthorization('viewer', 'member:invite', { accountId: 'a', actorId: 'u' })).toEqual({ kind: 'deny', reason: 'insufficient_role' });
  });
});

describe('isAuthorized — boolean parity', () => {
  test('owner-gated actions: true for owner, false for viewer/null', () => {
    const ctx = { accountId: 'a', actorId: 'u' };
    expect(isAuthorized('owner', 'member:revoke', ctx)).toBe(true);
    expect(isAuthorized('viewer', 'member:revoke', ctx)).toBe(false);
    expect(isAuthorized(null, 'member:revoke', ctx)).toBe(false);
  });

  test('member-gated action (list): true for owner and viewer, false for null', () => {
    const ctx = { accountId: 'a', actorId: 'u' };
    expect(isAuthorized('owner', 'member:list', ctx)).toBe(true);
    expect(isAuthorized('viewer', 'member:list', ctx)).toBe(true);
    expect(isAuthorized(null, 'member:list', ctx)).toBe(false);
  });
});
