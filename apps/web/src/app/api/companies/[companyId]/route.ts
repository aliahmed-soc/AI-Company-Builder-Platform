// ACBP-P1-010 — company item route: GET (read) / PATCH (rename/profile edit) /api/companies/{companyId}.
//
// Protected server-side (fail-closed). The companyId is a REQUEST selector validated in @acbp/core against an
// active company membership; a company in another account (or with no membership) resolves to a coarse
// forbidden/not_found (no oracle). Read is owner|viewer; rename is owner-only (enforced in @acbp/core). Other
// methods → 405.
import { getCompanyForRequest, renameCompanyForRequest } from '@/server/companies/companies-request';
import { parseRenameCompanyBody, respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  return respondToCompaniesRequest(() => getCompanyForRequest(companyId));
}

export async function PATCH(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const parsed = await parseRenameCompanyBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => renameCompanyForRequest(companyId, parsed.input));
}
