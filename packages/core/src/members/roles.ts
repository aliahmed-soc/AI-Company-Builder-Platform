// @acbp/core — membership role model (ACBP-P1-004; CDR-011). MVP roles: owner, viewer.
//
// Roles are internal and server-authoritative: a role is resolved ONLY from an active membership row,
// never from a Clerk org/role claim or any client-supplied value (ADR-022 / SECURITY-ARCHITECTURE §1).

/** MVP membership roles. */
export type MemberRole = 'owner' | 'viewer';

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'viewer'];

/** Type guard for a role value arriving from untrusted input. */
export function isMemberRole(value: unknown): value is MemberRole {
  return value === 'owner' || value === 'viewer';
}

// Role→action authorization is decided centrally by `authorize(role, action)` (@acbp/contracts authz) and
// enforced via `checkAuthorization` (ACBP-P1-007) — the single source of truth for what a role may do. The
// former ad-hoc `isOwner`/`isMember` predicates were removed to avoid a second, matrix-bypassing gate.
