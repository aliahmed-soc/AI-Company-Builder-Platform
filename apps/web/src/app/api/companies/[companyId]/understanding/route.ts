// ACBP-API-013 (ACBP-FE-009) — the understanding document: GET /api/companies/{companyId}/understanding.
//
// Authenticated, company-member read (`understanding:read` → owner + viewer), enforced in @acbp/core. NO
// AUTHORIZATION CHECK LIVES HERE (CDR-087 §1); a refusal comes back from the domain and is mapped like any other.
//
// ⚠️ THIS ROUTE IS THE REASON ACBP-FE-009 WAS BLOCKED, AND THE READ BEHIND IT DID NOT EXIST UNTIL NOW. The
// understanding module shipped four writes and the strategy-unlock gate; nothing returned the document. Adding
// `readCurrentUnderstanding` to core was a DOMAIN ADDITION authorized by the owner on 2026-08-19 — the same shape
// that was refused on ACBP-API-011 for held work, which is why the difference is written down rather than assumed.
//
// NOT METERED. This reads stored rows; no model is called. The two interview routes beside it do spend money.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply — safe methods are unaffected by design.
import { getUnderstandingForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * No supported query parameters. An unsupported one is REFUSED rather than ignored, on the approvals-inbox rule:
 * a founder who believes they are reading a filtered or historical view of their understanding, while actually
 * reading the current one, is a worse failure than an error. Version selection is deliberately not offered —
 * this route answers "what does the platform currently understand about my company".
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
  return respondToCompaniesRequest(() => getUnderstandingForRequest(companyId));
}
