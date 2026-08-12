// ACBP-API-002 (CDR-088) — an artifact's lineage: GET /api/companies/{companyId}/artifacts/{artifactId}/lineage.
//
// Authenticated, company-member read, enforced in @acbp/core. NO AUTHORIZATION CHECK LIVES HERE (CDR-088 §1).
//
// `readArtifactLineage` IS tagged, unlike its two neighbours in the same area, so it is mapped by `status` like
// every other route here and keeps `not_found` distinct from `forbidden` (§5). The inconsistency between the
// three artifact use cases belongs to core; §2.1a records the decision to adapt rather than normalize it.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply.
import { readArtifactLineageForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_PARAMS = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ companyId: string; artifactId: string }> }): Promise<Response> {
  const { companyId, artifactId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  return respondToCompaniesRequest(() => readArtifactLineageForRequest(companyId, artifactId));
}
