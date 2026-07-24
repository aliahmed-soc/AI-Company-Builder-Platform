// ACBP-P1-010/P1-011 — companies collection route: POST (create) + GET (portfolio) /api/companies.
//
// Protected server-side (fail-closed): resolves the SERVER-VERIFIED session identity → internal user → the
// caller's OWN account. POST creates a company (owner-only, enforced in @acbp/core from the account role). GET
// returns the caller's MEMBERSHIP-FILTERED company portfolio (ACBP-P1-011; CDR-017) — active account member,
// rows filtered to the actor's active company memberships; `cursor`/`limit` from the query string (the domain
// validates — invalid limit → 400, not clamped). All domain access goes through @acbp/core. Other methods → 405.
import { createCompanyForRequest, getPortfolioForRequest } from '@/server/companies/companies-request';
import { parseCreateCompanyBody, respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The ONLY supported GET query parameters (no arbitrary filters/search/export — CDR-017 §9). */
const ALLOWED_PORTFOLIO_PARAMS = new Set(['cursor', 'limit']);

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseCreateCompanyBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => createCompanyForRequest(parsed.input));
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PORTFOLIO_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  const cursor = params.get('cursor') ?? undefined;
  const limit = params.get('limit') ?? undefined;
  return respondToCompaniesRequest(() => getPortfolioForRequest({ ...(cursor !== undefined ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) }));
}
