// ACBP-P1-010 — companies collection route: POST (create) /api/companies.
//
// Protected server-side (fail-closed): resolves the SERVER-VERIFIED session identity → internal user → the
// caller's OWN account, then creates a company. Owner-only (enforced in @acbp/core from the account role). All
// domain access goes through @acbp/core. Other methods → 405.
import { createCompanyForRequest } from '@/server/companies/companies-request';
import { parseCreateCompanyBody, toCompaniesResponse } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const parsed = await parseCreateCompanyBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return toCompaniesResponse(await createCompanyForRequest(parsed.input));
}
