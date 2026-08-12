// ACBP-API-002 (CDR-088) — the company's task board: GET /api/companies/{companyId}/tasks.
//
// Authenticated, company-member read, enforced in @acbp/core (`task:read`). The companyId is a
// membership-validated selector, never trusted on its own. NO AUTHORIZATION CHECK LIVES HERE (CDR-088 §1).
//
// AN EMPTY BOARD IS STILL A BOARD. `GetTaskBoardResult` carries a non-nullable `TaskBoardDTO`, so unlike the
// roadmap read there is no absent-carrying-null case here — a company with no tasks gets a 200 with an empty
// board, which is the honest first-visit state either way.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply — safe methods are unaffected by design.
import { getTaskBoardForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * NO supported query parameters yet. Filtering the board (by status, assignee, phase) is a real future need, but
 * an unsupported filter must be REFUSED rather than ignored — a caller silently getting an unfiltered board back
 * is worse than an error, because it looks like it worked.
 */
const ALLOWED_PARAMS = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  return respondToCompaniesRequest(() => getTaskBoardForRequest(companyId));
}
