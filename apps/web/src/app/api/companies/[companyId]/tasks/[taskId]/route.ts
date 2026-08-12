// ACBP-API-002 (CDR-088) — one task's detail: GET /api/companies/{companyId}/tasks/{taskId}.
//
// Authenticated, company-member read, enforced in @acbp/core (`task:read`). NO AUTHORIZATION CHECK LIVES HERE
// (CDR-088 §1). Both ids are membership-validated selectors, never trusted on their own.
//
// THE FIRST SLICE-2 ROUTE WITH A SUB-RESOURCE, so it is the first with a `not_found` distinct from `forbidden`
// (CDR-088 §5). They answer at different granularities — `forbidden` is the company-level refusal, `not_found` is
// the task-level one — and collapsing them would discard the difference between "not yours" and "not there".
//
// Neither refusal is an oracle: within each granularity, a FOREIGN id and an UNKNOWN one are indistinguishable,
// because RLS makes another company's row invisible rather than denied. The adversarial matrix asserts that at
// BOTH levels; a refusal uniform at one level and revealing at the other would still leak.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply — safe methods are unaffected by design.
import { getTaskDetailForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No supported query parameters — the detail is one object. An unknown parameter is refused, never ignored. */
const ALLOWED_PARAMS = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ companyId: string; taskId: string }> }): Promise<Response> {
  const { companyId, taskId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  return respondToCompaniesRequest(() => getTaskDetailForRequest(companyId, taskId));
}
