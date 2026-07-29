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
  'company:create': ['owner'],
  'company:read': ['owner', 'viewer'],
  'company:rename': ['owner'],
  'company:pause': ['owner'],
  'company:resume': ['owner'],
  'company:status': ['owner', 'viewer'],
  'activity:read': ['owner', 'viewer'],
  'portfolio:read': ['owner', 'viewer'],
  'provisioning:read': ['owner', 'viewer'],
  'provisioning:resume': ['owner'],
  // Platform-admin access (ACBP-P1-013; CDR-019): NO membership role may ever perform it via the matrix —
  // tenant owner/viewer are structurally denied; the separate platform_admins gate is the only path.
  'admin:tenant_read': [],
  // Interview sessions (ACBP-P2-001; CDR-022 §6): read + participate = any active company member.
  'interview:read': ['owner', 'viewer'],
  'interview:participate': ['owner', 'viewer'],
  // Typed memory (ACBP-P2-006; CDR-024 §3): read + write = any active company member.
  'memory:read': ['owner', 'viewer'],
  'memory:write': ['owner', 'viewer'],
  // Memory browser (ACBP-P2-010; CDR-025): editing (versioned correction) + deleting (soft delete) are OWNER-only.
  'memory:edit': ['owner'],
  'memory:delete': ['owner'],
  // Understanding generation (ACBP-P2-008; CDR-029): generate + read = any active company member.
  'understanding:generate': ['owner', 'viewer'],
  'understanding:read': ['owner', 'viewer'],
  // Understanding review + confirmation (ACBP-P2-009; CDR-030): both OWNER-only.
  'understanding:review': ['owner'],
  'understanding:confirm': ['owner'],
  // Task model (ACBP-P4-002; CDR-033): create/plan + read = any active company member.
  'task:create': ['owner', 'viewer'],
  'task:read': ['owner', 'viewer'],
  // Task deletion (ACBP-P4-005; CDR-043): owner|viewer, matching create — canon says company-scoped, not owner-only.
  'task:delete': ['owner', 'viewer'],
  // Strategy option generation (ACBP-P3-001; CDR-034): generate/request-another + read = any active company member.
  'strategy:generate': ['owner', 'viewer'],
  'strategy:read': ['owner', 'viewer'],
  // Advisory AI recommendation (ACBP-P3-003; CDR-036): owner|viewer (advisory; owner-only selection is P3-004).
  'strategy:recommend': ['owner', 'viewer'],
  // Owner strategy decision (ACBP-P3-004; CDR-037): owner-only.
  'strategy:select': ['owner'],
  // Immutable decision record (ACBP-P3-005; CDR-038; STRAT-006): owner-only.
  'decision:record': ['owner'],
  // Revision requests (ACBP-P5-012; CDR-064 G5): owner-only, per API-CONTRACTS.md:55 "Member (read), owner (revise)".
  'artifact:revise': ['owner'],
  // Planning (ACBP-P4-001; CDR-039; ROAD-001/002): generate/read are member actions; the versioned EDIT is owner-only.
  'roadmap:generate': ['owner', 'viewer'],
  'roadmap:read': ['owner', 'viewer'],
  'roadmap:edit': ['owner'],
  // Task planning (ACBP-P4-003; CDR-040; PLAN-001/002): generate-class member action; drafts are not board work.
  'task:generate': ['owner', 'viewer'],
  // Durable job enqueue (ACBP-P5-001a; CDR-049): OWNER-only, the deliberately tighter of the two readings.
  'job:enqueue': ['owner'],
  // Step execution (ACBP-P5-001b; CDR-050): owner-only, same reading as enqueue.
  'job:execute': ['owner'],
  // Task runs (ACBP-P5-002; CDR-053): execute is the worker's, cancel is the owner's. Both owner-only today.
  'run:execute': ['owner'],
  // The credit ledger read (ACBP-P5-014; CDR-058 section 2). ACCOUNT-OWNER ONLY: the ledger spans the account's
  // companies, so a company-scoped operator reading it would learn what the OTHER companies have been spending.
  // RLS cannot prevent that - it is keyed on the account by design - so this action is the control.
  'billing:read': ['owner'],
  'run:cancel': ['owner'],
  // Worker pause/disable (ACBP-P5-004; CDR-056; WORK-006): OWNER-only - canon calls it an emergency control.
  'worker:control': ['owner'],
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
