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

/** Owner-gated operations (invite/revoke/manage). Viewer is read-only. */
export function isOwner(role: MemberRole | null): boolean {
  return role === 'owner';
}

/** Any active member (owner or viewer) may perform member-gated read operations. */
export function isMember(role: MemberRole | null): boolean {
  return role !== null;
}
