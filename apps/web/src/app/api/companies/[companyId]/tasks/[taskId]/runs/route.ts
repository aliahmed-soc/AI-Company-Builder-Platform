// ACBP-API-003 (CDR-089) — every run of one task: GET /api/companies/{companyId}/tasks/{taskId}/runs.
//
// Authenticated, company-member read, enforced in @acbp/core (`run:read` → owner + viewer). NO AUTHORIZATION
// CHECK LIVES HERE (CDR-088 §1, inherited by CDR-089).
//
// AN UNKNOWN TASK AND A TASK WITH NO RUNS ARE THE SAME ANSWER, and that is CDR-089 §3 rather than an oversight.
// `listForTask` cannot distinguish them — both are an empty list — so this route does NOT invent a 404 core never
// made. It is also oracle-safe by construction: a caller learns nothing about whether a foreign task exists. A
// caller who genuinely needs that difference reads the task itself, which has its own `not_found`.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply — safe methods are unaffected by design.
import { listTaskRunsForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * No supported query parameters yet. Filtering runs by state or attempt is a plausible future need, but an
 * unsupported filter is REFUSED rather than ignored: a caller who believes they are seeing only failed runs,
 * while actually seeing all of them, is a worse failure than an error.
 */
const ALLOWED_PARAMS = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ companyId: string; taskId: string }> }): Promise<Response> {
  const { companyId, taskId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  return respondToCompaniesRequest(() => listTaskRunsForRequest(companyId, taskId));
}
