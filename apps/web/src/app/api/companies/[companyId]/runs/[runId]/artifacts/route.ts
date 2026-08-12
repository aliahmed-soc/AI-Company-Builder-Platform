// ACBP-API-002 (CDR-088) — every artifact one run produced:
// GET /api/companies/{companyId}/runs/{runId}/artifacts.
//
// THE runId IS A SELECTOR, NOT A RUN READ. This route does not read a run and does not imply one can be read —
// there is no run-read use case in @acbp/core, and adding one is ACBP-API-003 (CDR-088 §0.2). A path containing
// `runs` is exactly where a future reader would assume otherwise, so the absence is stated rather than left to
// look like an oversight.
//
// AN UNKNOWN RUN AND AN EMPTY RUN ARE THE SAME ANSWER. `listRunArtifacts` has no `not_found` arm and resolves to
// `readonly ArtifactDTO[] | 'forbidden'`, so both cases are an empty array with a 200 (§2.1a). That is
// oracle-safe by construction — a caller learns nothing about whether a foreign run exists — and this route does
// NOT invent a 404 that core never made.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply.
import { listRunArtifactsForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_PARAMS = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ companyId: string; runId: string }> }): Promise<Response> {
  const { companyId, runId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  return respondToCompaniesRequest(() => listRunArtifactsForRequest(companyId, runId));
}
