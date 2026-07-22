// ACBP-P1-010 — company resume route: POST /api/companies/{companyId}/resume.
//
// Owner-only (enforced in @acbp/core from the company role). Transitions paused→active; an out-of-state
// transition returns 409 invalid_transition. Optional { reason }. Fail-closed. Other methods → 405.
import { resumeCompanyForRequest } from '@/server/companies/companies-request';
import { parseReasonBody, toCompaniesResponse } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const parsed = await parseReasonBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return toCompaniesResponse(await resumeCompanyForRequest(companyId, parsed.input));
}
