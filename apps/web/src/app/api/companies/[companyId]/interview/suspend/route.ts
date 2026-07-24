// ACBP-P2-001 — interview suspend route: POST /api/companies/{companyId}/interview/suspend.
//
// Transitions the company's open interview session in_progress→waiting_for_user (participate = any active
// company member, enforced in @acbp/core). NO query parameters (any present → generic 400) and NO request body.
// An out-of-state suspend returns 409 invalid_transition; no open session returns 404. Fail-closed; unexpected
// throws become the BOUNDED generic 500 envelope. Other methods → 405.
import { suspendInterviewForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const { companyId } = await context.params;
  return respondToCompaniesRequest(() => suspendInterviewForRequest(companyId));
}
