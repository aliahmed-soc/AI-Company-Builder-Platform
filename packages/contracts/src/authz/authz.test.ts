// @acbp/contracts — authorization decision contract tests (ACBP-P1-007). Exhaustive role×action matrix
// plus deny-by-default and opaque-envelope guarantees.
import { describe, test, expect } from 'vitest';
import {
  AUTHZ_ACTIONS,
  authorize,
  isAuthzAction,
  isAllowed,
  deny,
  ALLOW,
  authorizationDeniedEnvelope,
  type AuthzAction,
  type AuthzRole,
} from './authz.js';

// The single source of truth for EXPECTED behaviour, written independently of the module's internal POLICY
// so the test genuinely pins the matrix rather than mirroring the implementation.
const EXPECTED: Record<AuthzAction, readonly AuthzRole[]> = {
  'member:invite': ['owner'],
  'member:revoke': ['owner'],
  'member:list': ['owner', 'viewer'],
  'member:read_invited_email': ['owner'],
  'profile:read': ['owner'],
  'profile:update': ['owner'],
};

const ALL_ROLES: readonly AuthzRole[] = ['owner', 'viewer'];

describe('authorize — exhaustive role×action matrix', () => {
  for (const action of AUTHZ_ACTIONS) {
    for (const role of ALL_ROLES) {
      const shouldAllow = EXPECTED[action].includes(role);
      test(`${role} ${shouldAllow ? 'MAY' : 'may NOT'} ${action}`, () => {
        const decision = authorize(role, action);
        expect(isAllowed(decision)).toBe(shouldAllow);
        if (!shouldAllow) {
          expect(decision).toEqual(deny('insufficient_role'));
        } else {
          expect(decision).toEqual(ALLOW);
        }
      });
    }
  }

  test('every declared action is covered by the EXPECTED matrix (no drift)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...AUTHZ_ACTIONS].sort());
  });
});

describe('authorize — deny-by-default', () => {
  test('a null role (no active membership) denies every action with not_a_member', () => {
    for (const action of AUTHZ_ACTIONS) {
      expect(authorize(null, action)).toEqual(deny('not_a_member'));
    }
  });

  test('an action outside the closed set denies with unknown_action (even for an owner)', () => {
    const forged = 'member:delete_account' as AuthzAction; // forced past the type boundary
    expect(authorize('owner', forged)).toEqual(deny('unknown_action'));
    expect(authorize('viewer', forged)).toEqual(deny('unknown_action'));
  });

  test('null role is checked before the action — a null role with an unknown action still denies not_a_member', () => {
    const forged = 'nonsense:action' as AuthzAction;
    expect(authorize(null, forged)).toEqual(deny('not_a_member'));
  });
});

describe('isAuthzAction', () => {
  test('accepts every declared action', () => {
    for (const action of AUTHZ_ACTIONS) expect(isAuthzAction(action)).toBe(true);
  });
  test('rejects unknown strings and non-strings (deny-by-default at the boundary)', () => {
    for (const bad of ['member:delete', '', 'owner', 'PROFILE:READ', undefined, null, 42, {}, ['member:list']]) {
      expect(isAuthzAction(bad)).toBe(false);
    }
  });
});

describe('authorizationDeniedEnvelope', () => {
  test('is always the same opaque authz/403 envelope regardless of reason (no role/existence oracle)', () => {
    const env = authorizationDeniedEnvelope();
    expect(env.category).toBe('authz');
    expect(env.code).toBe('AUTHORIZATION_DENIED');
    expect(env.retryable).toBe(false);
    // The envelope must never carry a role, action, membership state, or reason.
    expect(JSON.stringify(env)).not.toContain('insufficient_role');
    expect(JSON.stringify(env)).not.toContain('not_a_member');
    expect(JSON.stringify(env)).not.toContain('owner');
    expect(JSON.stringify(env)).not.toContain('viewer');
  });

  test('carries a correlation id only when provided', () => {
    expect(authorizationDeniedEnvelope().correlationId).toBeUndefined();
    expect(authorizationDeniedEnvelope('corr-1').correlationId).toBe('corr-1');
  });
});
