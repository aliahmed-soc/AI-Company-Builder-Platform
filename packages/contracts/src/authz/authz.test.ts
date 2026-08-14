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
  // PM RULING 2026-08-14 (ACBP-API-004): NARROWED to owner-only. A viewer reads; destroying planning work is an
  // owner action. Restated here as a SECOND decision — this file does not import the matrix, so narrowing five
  // grants required changing them in two places deliberately. That is the property, not friction.
  'task:delete': ['owner'],
  // Task-run reads (ACBP-API-003; CDR-089 §1): owner|viewer, matching task:read. Restated here INDEPENDENTLY of
  // the matrix — this file deliberately does not import it, so a new action cannot be granted without a second,
  // separate decision. That is why adding `run:read` broke collection until this line was written.
  'run:read': ['owner', 'viewer'],
  // PM RULING 2026-08-14 (ACBP-API-004): metered GENERATION is owner-only — each call spends account budget.
  // READ stays owner|viewer: narrowing who may commission work does not narrow who may see it.
  'strategy:generate': ['owner'],
  'strategy:read': ['owner', 'viewer'],
  'strategy:recommend': ['owner'],
  // Owner strategy decision (ACBP-P3-004; CDR-037): owner-only.
  'strategy:select': ['owner'],
  // Immutable decision record (ACBP-P3-005; CDR-038; STRAT-006): owner-only.
  'decision:record': ['owner'],
  // Revision requests (ACBP-P5-012; CDR-064 G5): owner-only, per API-CONTRACTS.md:55 "Member (read), owner (revise)".
  'artifact:revise': ['owner'],
  // Planning (ACBP-P4-001; CDR-039; ROAD-001/002): generate/read are member actions; the versioned EDIT is owner-only.
  // PM RULING 2026-08-14 (ACBP-API-004): roadmap GENERATION narrowed to owner-only; read and edit unchanged.
  'roadmap:generate': ['owner'],
  'roadmap:read': ['owner', 'viewer'],
  'roadmap:edit': ['owner'],
  // PM RULING 2026-08-14 (ACBP-API-004): narrowed to owner-only. "They are only drafts" was the strongest case
  // for keeping viewers here, and it still loses — a draft costs the same metered generation call.
  'task:generate': ['owner'],
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
  // ACBP-P6-001c / CDR-066 §6-G17: owner-only. Setting the policy decides what the AI may do unsupervised.
  'policy:manage': ['owner'],
  // ACBP-P6-003c / CDR-068. Requesting rides the execution path; DECIDING is the authority chain's hinge and is
  // owner-only (invariant 5's role layer, orthogonal to the actor-TYPE restriction the contract and a database CHECK
  // enforce); reading the inbox is open to viewers, because seeing that a human is needed is not authority to be one.
  'approval:request': ['owner'],
  'approval:decide': ['owner'],
  // Revoking sits at the SAME level as deciding (ACBP-P6-004): whoever can grant an authorization can take it back,
  // which is what makes an approval retractable rather than a one-way door.
  'approval:revoke': ['owner'],
  'approval:read': ['owner', 'viewer'],
  // Emergency stop (ACBP-P6-007; CDR-072 §1-G9). Activate and clear are owner-only and DELIBERATELY separate, so a
  // later role model can widen who may halt without also widening who may un-halt. Viewers may READ what is halted
  // — a team wondering why nothing is running must be able to find out — but cannot lift it.
  'stop:activate': ['owner'],
  'stop:clear': ['owner'],
  'stop:read': ['owner', 'viewer'],
  // Account usage (ACBP-P6-009; CDR-073). Owner-only on BOTH, per API-CONTRACTS' "account rollup = account owner".
  // Note this is the first read action since `profile:read` that a viewer does NOT get: it discloses account-wide
  // spend, unlike the halted-work and pending-approval reads that were deliberately widened to viewer.
  'usage:read': ['owner'],
  'usage:correct': ['owner'],
  // Decision Room entry (ACBP-P6-008; CDR-076 §3-G2). Owner|viewer — identical to `activity:read`, because the
  // room composes reads the member already has. Entering it grants nothing: the owner-only surfaces inside keep
  // their own actions and render `restricted` to a viewer.
  'decision_room:read': ['owner', 'viewer'],
  // Export of owned data (ACBP-P7-001; CDR-078; API-CONTRACTS `:77`). OWNER ONLY, and deliberately narrower than
  // the reads it composes: a viewer who may READ the understanding in-product is not thereby entitled to walk out
  // with an archive of everything the company owns. "Can see" and "can take" are different powers here.
  'export:create': ['owner'],
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
