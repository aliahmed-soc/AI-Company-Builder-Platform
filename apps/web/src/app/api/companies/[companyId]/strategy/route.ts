// ACBP-API-001 (CDR-087) — the company's latest strategy generation: GET /api/companies/{companyId}/strategy.
//
// Authenticated, company-member read, enforced in @acbp/core (`strategy:read` → owner + viewer). The companyId is
// a membership-validated selector, never trusted on its own. NO AUTHORIZATION CHECK LIVES HERE (CDR-087 §1): core
// decides from the company role, and a second place answering the same question is the defect ACBP-P6-002 paid to
// remove when the caller-injectable approval port was deleted.
//
// AN ABSENT GENERATION IS A SUCCESS, NOT A NOT-FOUND (CDR-087 §5.0 G9). `LatestStrategyResult` has two arms only,
// and its `generation` is nullable: the company exists and the caller may read it, there is simply nothing
// generated yet. That is the honest first-visit empty state, and mapping it to a 404 is how a UI ends up showing
// an error page on a normal first visit.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply to it — safe methods are unaffected by design.
// Other methods → 405 from the framework.
import { getStrategyForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * There are NO supported query parameters. The read returns the company's current generation and its options as
 * one object; there is nothing to page, filter or select. An unknown parameter is refused rather than ignored, so
 * a caller cannot believe a filter was applied when it was silently dropped.
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
  return respondToCompaniesRequest(() => getStrategyForRequest(companyId));
}
