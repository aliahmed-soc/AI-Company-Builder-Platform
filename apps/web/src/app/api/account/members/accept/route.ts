// ACBP-P1-004 — invite acceptance route: POST /api/account/members/accept.
//
// The accepting user must be a SERVER-VERIFIED identity whose verified primary email matches the
// invited email (enforced in @acbp/core). Scoped to the invite's account (from the single-use token),
// not the caller's own account. Fail-closed. Other methods → 405.
import { acceptInviteForRequest } from '@/server/members/members-request';
import { parseAcceptBody, respondToMembersRequest } from '@/server/members/members-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseAcceptBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToMembersRequest(() => acceptInviteForRequest(parsed.input));
}
