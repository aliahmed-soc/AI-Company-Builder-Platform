// ACBP-API-002 (CDR-088) — one artifact: GET /api/companies/{companyId}/artifacts/{artifactId}.
//
// Authenticated, company-member read, enforced in @acbp/core. NO AUTHORIZATION CHECK LIVES HERE (CDR-088 §1).
//
// `getArtifact` returns a BARE union — `ArtifactDTO | 'forbidden' | 'not_found'` — not the tagged shape the rest
// of this programme uses (§2.1a). The string check lives in `getArtifactForRequest` and runs BEFORE the value is
// treated as a DTO, because a missed check would serialize the literal 'forbidden' into a 200 body as though it
// were the artifact. This route stays thin and does not re-implement that discrimination.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply — safe methods are unaffected by design.
import { getArtifactForRequest } from '@/server/companies/companies-request';
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
  return respondToCompaniesRequest(() => getArtifactForRequest(companyId, artifactId));
}
