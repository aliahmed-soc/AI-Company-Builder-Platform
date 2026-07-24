// ACBP-P2-002 — interview Q&A read route: GET /api/companies/{companyId}/interview/qa.
//
// Returns the company's OPEN interview session's questions (in order), each with its current answer, full
// revision history, and derived lifecycle (read = any active company member, enforced in @acbp/core). NO query
// parameters (any present → generic 400) and NO request body. No open session → 404. Fail-closed; unexpected
// throws become the BOUNDED generic 500 envelope. Other methods → 405.
import { getQaForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const { companyId } = await context.params;
  return respondToCompaniesRequest(() => getQaForRequest(companyId));
}
