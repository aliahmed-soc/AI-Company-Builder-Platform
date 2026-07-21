// ACBP-P1-004 — members collection route: GET (list) / POST (invite) /api/account/members.
//
// Protected server-side (fail-closed): resolves the SERVER-VERIFIED session identity → internal user →
// the caller's OWN account, then lists or invites. Role authorization (owner-only invite) is enforced
// in @acbp/core from the membership row. All domain access goes through @acbp/core. Other methods → 405.
import { listMembersForRequest, inviteMemberForRequest } from '@/server/members/members-request';
import { parseInviteBody, toMembersResponse } from '@/server/members/members-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return toMembersResponse(await listMembersForRequest());
}

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseInviteBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return toMembersResponse(await inviteMemberForRequest(parsed.input));
}
