// ACBP-API-003 (CDR-089) — one run's detail: GET /api/companies/{companyId}/runs/{runId}.
//
// Authenticated, company-member read, enforced in @acbp/core (`run:read` → owner + viewer). NO AUTHORIZATION
// CHECK LIVES HERE (CDR-088 §1, inherited by CDR-089).
//
// THIS ROUTE COMPLETES A PATH THAT ALREADY EXISTED. `runs/{runId}/artifacts` shipped in CDR-088 as a sub-route
// with no parent, because at the time there was no run-read use case in core — CDR-088 §0.2 recorded that and
// deferred it here rather than inventing one under a "pure exposure" ticket. The parent now exists.
//
// A RUN IS ALWAYS A RUN OF A TASK (the table is `task_runs`), but it IS addressable by its own id: the repository
// exposes `findById` as well as `listForTask`. That is what makes this path honest rather than a convenience.
//
// `not_found` is DISTINCT from `forbidden` (company-level vs run-level). Within each granularity a foreign id and
// an unknown one are indistinguishable — enforced by RLS, not by a decision here.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply — safe methods are unaffected by design.
import { getTaskRunForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** No supported query parameters — the detail is one object. An unknown parameter is refused, never ignored. */
const ALLOWED_PARAMS = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ companyId: string; runId: string }> }): Promise<Response> {
  const { companyId, runId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  return respondToCompaniesRequest(() => getTaskRunForRequest(companyId, runId));
}
