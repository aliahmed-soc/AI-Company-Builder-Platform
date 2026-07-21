// ACBP-P1-004 — member revocation route: DELETE /api/account/members/{membershipId}.
//
// Owner-only, enforced in @acbp/core from the caller's membership role; scoped to the caller's OWN
// account (a membership id from another account resolves to not_found). Revocation is immediate; the
// last owner cannot be removed (409). Fail-closed. Other methods → 405.
import { revokeMemberForRequest } from '@/server/members/members-request';
import { toMembersResponse } from '@/server/members/members-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_request: Request, context: { params: Promise<{ membershipId: string }> }): Promise<Response> {
  const { membershipId } = await context.params;
  return toMembersResponse(await revokeMemberForRequest(membershipId));
}
