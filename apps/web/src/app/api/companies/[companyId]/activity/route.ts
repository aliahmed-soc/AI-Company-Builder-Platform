// ACBP-P1-010/P1-009 — company activity feed route: GET /api/companies/{companyId}/activity.
//
// Authenticated, company-member (owner|viewer) read, enforced in @acbp/core (activity:read). The companyId is a
// membership-validated selector; `cursor`/`limit` come from the query string (the domain validates + clamps). A
// malformed cursor → 400; a non-member → coarse 403 (no oracle). Read-only; no mutation. Other methods → 405.
import { getCompanyActivityForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The ONLY supported query parameters. Anything else is rejected (no arbitrary filters/search/export). */
const ALLOWED_PARAMS = new Set(['cursor', 'limit']);

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  const cursor = params.get('cursor') ?? undefined;
  const limit = params.get('limit') ?? undefined;
  return respondToCompaniesRequest(() => getCompanyActivityForRequest(companyId, { ...(cursor !== undefined ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) }));
}
