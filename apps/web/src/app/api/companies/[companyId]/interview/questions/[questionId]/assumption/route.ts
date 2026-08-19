// ACBP-API-013 (ACBP-FE-008) — the "I don't know" path:
// POST /api/companies/{companyId}/interview/questions/{questionId}/assumption.
//
// ⚠️ **THIS ROUTE SPENDS MONEY PER CALL.** It reaches `suggestAssumptionForSkip`, which asks the model to propose
// a labelled assumption for a question the founder skipped (DISC-005) and stores it as an `ai_assumption` memory
// item — never a `user_fact`, because the platform assuming something is a different kind of claim from the
// founder stating it, and the memory type is what keeps the two distinguishable downstream.
//
// Metered exactly as the sibling `evaluate` route is, through the same MEMBER-level pre-debit gate
// (`interview:participate`) rather than the owner-only generate gate — see that file for why the two are split.
//
// NO BODY. The question is named by the path and the session is resolved from the company's open interview, so
// there is nothing for a caller to supply; a body would be a second source for facts the server already owns.
// Unknown query parameters are refused rather than ignored.
//
// State-changing, so the CSRF origin gate (ACBP-P7-014) covers it without any code here.
import { suggestAssumptionForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ⚠️ PROVISIONAL AND UNMEASURED — inherited from the generate routes, not calibrated (CDR-092 §3). */
export const maxDuration = 90;

const ALLOWED_PARAMS = new Set<string>();

export async function POST(request: Request, context: { params: Promise<{ companyId: string; questionId: string }> }): Promise<Response> {
  const { companyId, questionId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  return respondToCompaniesRequest(() => suggestAssumptionForRequest(companyId, questionId));
}
