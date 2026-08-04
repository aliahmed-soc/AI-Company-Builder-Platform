// ACBP-P6-008 — the Decision Room: GET /api/companies/{companyId}/decision-room (DEC-001).
//
// Authenticated, company-member read (`decision_room:read`, owner|viewer), enforced in @acbp/core. The
// companyId is a membership-validated selector; a non-member gets the same coarse 403 every other company
// route gives, with no oracle. Read-only; other methods → 405 (Next's default for an unexported verb).
//
// NO QUERY PARAMETERS AT ALL. Not a filter, not a cursor, not a section selector. The room's claim is that the
// ten queues arrive together with their own statuses; a caller able to request four of them could render
// something that looks like a complete room and is not.
import { getDecisionRoomForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => getDecisionRoomForRequest(companyId));
}
