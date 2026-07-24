// ACBP-P2-001 — interview session route: GET + POST /api/companies/{companyId}/interview.
//
// GET returns the company's current (open) interview session (participate/read = any active company member,
// enforced in @acbp/core from the fresh company role). POST STARTS the session (not_started→in_progress),
// idempotently — an existing open session is returned, and a fresh start requires the company be active and
// emits interview.started in the same transaction. NO query parameters (any present → generic 400) and NO
// request body is accepted or parsed (the action is the whole payload; mirrors the pause/resume routes).
// Fail-closed; unexpected throws become the BOUNDED generic 500 envelope. Other methods → 405.
import { getInterviewForRequest, startInterviewForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rejectQuery(request: Request): Response | null {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const bad = rejectQuery(request);
  if (bad !== null) return bad;
  const { companyId } = await context.params;
  return respondToCompaniesRequest(() => getInterviewForRequest(companyId));
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const bad = rejectQuery(request);
  if (bad !== null) return bad;
  const { companyId } = await context.params;
  return respondToCompaniesRequest(() => startInterviewForRequest(companyId));
}
