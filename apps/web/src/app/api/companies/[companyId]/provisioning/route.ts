// ACBP-P1-012 — workspace-provisioning status route: GET /api/companies/{companyId}/provisioning.
//
// Authenticated, company-member (owner|viewer) read, enforced in @acbp/core (provisioning:read). The companyId
// is a membership-validated selector. NO query parameters are supported — any present parameter is rejected
// with a generic 400 (no filters, no pagination, no step selection; CDR-018 §12). Read-only. Other methods → 405.
import { getProvisioningForRequest } from '@/server/companies/companies-request';
import { toCompaniesResponse } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    // ANY query parameter is unsupported on this route.
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  try {
    return toCompaniesResponse(await getProvisioningForRequest(companyId));
  } catch {
    return new Response(JSON.stringify(genericErrorBody(500)), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
}
