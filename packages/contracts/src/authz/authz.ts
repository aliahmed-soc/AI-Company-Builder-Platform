// @acbp/contracts — provider-neutral authorization decision contract (ACBP-P1-007; ADR-022; ADR-006;
// SECURITY-ARCHITECTURE §1).
//
// The transport- and provider-neutral currency for the INTERNAL ROLE-CHECK step of the mandatory ADR-022
// authorization flow (`… → internal role check → tenant-scoped DB authorization → …`). This module is a
// PURE decision over an ALREADY-RESOLVED internal role:
//   - it performs NO IO and consults NO Clerk org/role claim, header, cookie, or UI state;
//   - it is NOT tenant isolation — which account/company a caller may touch is decided by AccountContext
//     (ACBP-P1-005) and enforced by row-level security (ACBP-P1-006); this only answers "may THIS role
//     perform THIS action?" once the account is already resolved;
//   - it mints no scope and selects no database connection.
// Deny-by-default at every branch. Zero-dependency, like the rest of @acbp/contracts.
import { platformError, ErrorCodes, type PublicErrorEnvelope } from '../errors.js';

/**
 * MVP internal membership roles (PRD §13; mirrors `MemberRole` in @acbp/core `members/roles.ts`). The union
 * is duplicated here — not imported — because @acbp/contracts is zero-dependency and sits BELOW @acbp/core
 * in the dependency graph. The two unions are intentionally identical so a core `MemberRole` is assignable
 * where an `AuthzRole` is expected without any mapping.
 */
export type AuthzRole = 'owner' | 'viewer';

/**
 * The CLOSED set of role-gated protected actions (the ADR-022 flow runs the role check on each). Naming is
 * `resource:verb`; the resource is implicit in the action name. Anything NOT listed here is an unknown
 * action and is DENIED — adding an action is a deliberate, reviewed change to the policy surface.
 *
 * Excluded by design (NOT role-gated actions): invite acceptance and personal-account provisioning are
 * pre-context self-service/bootstrap operations (no active-membership role exists yet), and the Clerk
 * webhook is signature-authenticated only — none pass through this role check.
 */
export const AUTHZ_ACTIONS = [
  'member:invite',
  'member:revoke',
  'member:list',
  'member:read_invited_email',
  'profile:read',
  'profile:update',
  // Company lifecycle (ACBP-P1-010; CDR-015). `company:create` is checked against the caller's ACCOUNT-membership
  // role (an account owner creates a company); the rest are checked against the caller's COMPANY-membership role
  // (resolved from company_memberships). Both use the same owner|viewer enum, so the single matrix suffices.
  'company:create',
  'company:read',
  'company:rename',
  'company:pause',
  'company:resume',
  'company:status',
  // Company activity feed (ACBP-P1-009; CDR-016). Checked against the caller's COMPANY-membership role.
  'activity:read',
  // Company portfolio (ACBP-P1-011; CDR-017 §7). An ACCOUNT-level action: checked against the caller's active
  // ACCOUNT-membership role (owner|viewer). It gates only the API CALL; result rows stay filtered by active
  // COMPANY membership (an account role never grants a portfolio row by itself). There is deliberately NO
  // `company:switch` action — switching is stateless URL-only re-resolution, not a role-gated operation.
  'portfolio:read',
  // Workspace provisioning (ACBP-P1-012; CDR-018 §11). Checked against the caller's COMPANY-membership role:
  // any active company member may READ provisioning status; only a company OWNER may RESUME. There is
  // deliberately NO start/retry/acknowledge/cancel action — resume is the single mutation surface.
  'provisioning:read',
  'provisioning:resume',
] as const;
export type AuthzAction = (typeof AUTHZ_ACTIONS)[number];

/** Runtime type guard for an action value arriving from untrusted input (deny-by-default at the boundary). */
export function isAuthzAction(value: unknown): value is AuthzAction {
  return typeof value === 'string' && (AUTHZ_ACTIONS as readonly string[]).includes(value);
}

/**
 * Coarse, SERVER-SIDE-ONLY denial reasons (for audit only; NEVER mapped into public output — a denial must
 * not reveal the caller's role, membership state, or whether an action exists). `not_a_member` = null role
 * (no active membership); `insufficient_role` = a valid role that lacks the action; `unknown_action` = an
 * action outside the closed set (defensive).
 */
export type AuthzDenialReason = 'not_a_member' | 'insufficient_role' | 'unknown_action';

/** Explicit allow/deny union. A deny carries the coarse server-side reason (audit only). */
export type AuthzDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: AuthzDenialReason };

export const ALLOW: AuthzDecision = { kind: 'allow' };
export function deny(reason: AuthzDenialReason): AuthzDecision {
  return { kind: 'deny', reason };
}
export function isAllowed(decision: AuthzDecision): boolean {
  return decision.kind === 'allow';
}

/**
 * Role→action policy matrix. Deny-by-default: each action lists EXACTLY the roles allowed to perform it; a
 * role absent from the list is denied. Owner ⊇ viewer is NOT assumed — every allowance is explicit, so a
 * new action defaults to owner-only-if-listed rather than silently inheriting broad access.
 */
const POLICY: Record<AuthzAction, readonly AuthzRole[]> = {
  'member:invite': ['owner'],
  'member:revoke': ['owner'],
  'member:list': ['owner', 'viewer'],
  'member:read_invited_email': ['owner'],
  'profile:read': ['owner'],
  'profile:update': ['owner'],
  // Company lifecycle: owner-only mutations; owner+viewer may read/see status (CDR-015; WORKFLOW §1 "owner"
  // transitions; API-CONTRACTS "Member (read), owner (lifecycle)").
  'company:create': ['owner'],
  'company:read': ['owner', 'viewer'],
  'company:rename': ['owner'],
  'company:pause': ['owner'],
  'company:resume': ['owner'],
  'company:status': ['owner', 'viewer'],
  // Company activity feed read (ACBP-P1-009): any active company member (owner|viewer) — API-CONTRACTS
  // "Activity … Company member (read)". Account membership alone is insufficient (the company role governs).
  'activity:read': ['owner', 'viewer'],
  // Company portfolio read (ACBP-P1-011; CDR-017 §7): any active ACCOUNT member (owner|viewer). This role check
  // authorizes the API call only; the listing itself is intersected with the caller's active company memberships.
  'portfolio:read': ['owner', 'viewer'],
  // Workspace provisioning (ACBP-P1-012; CDR-018 §11): status read = any active company member; resume = company
  // owner only (a lifecycle-mutation-class operation — it can ultimately activate the company).
  'provisioning:read': ['owner', 'viewer'],
  'provisioning:resume': ['owner'],
};

/**
 * Pure authorization decision for the internal role-check step. `role` is the caller's SERVER-RESOLVED
 * active-membership role (`null` = no active membership). Deny-by-default at every branch:
 *   - `null` role → deny(`not_a_member`);
 *   - action outside the closed policy set → deny(`unknown_action`);
 *   - role not in the action's allow-list → deny(`insufficient_role`).
 */
export function authorize(role: AuthzRole | null, action: AuthzAction): AuthzDecision {
  if (role === null) return deny('not_a_member');
  // Defensive: tolerate an action forced past the type boundary (e.g. via a cast at an untrusted seam).
  const allowed = POLICY[action] as readonly AuthzRole[] | undefined;
  if (allowed === undefined) return deny('unknown_action');
  return allowed.includes(role) ? ALLOW : deny('insufficient_role');
}

/**
 * Safe, client-facing envelope for ANY authorization denial — ALWAYS the same opaque `authz` /
 * `AUTHORIZATION_DENIED` (403) envelope regardless of the private reason, so a denial never becomes a
 * role/membership/existence oracle. The reason stays server-side (audit only).
 */
export function authorizationDeniedEnvelope(correlationId?: string): PublicErrorEnvelope {
  return platformError('authz', {
    code: ErrorCodes.AUTHORIZATION_DENIED,
    ...(correlationId !== undefined ? { correlationId } : {}),
  }).toPublic();
}
