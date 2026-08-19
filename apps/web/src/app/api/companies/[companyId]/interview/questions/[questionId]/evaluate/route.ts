// ACBP-API-013 (ACBP-FE-008) — classify an answer: POST /api/companies/{companyId}/interview/questions/{id}/evaluate.
//
// ⚠️ **THIS ROUTE SPENDS MONEY PER CALL.** It reaches `evaluateAnswer`, which calls the model gateway to decide
// whether an answer is clear, vague or contradictory (DISC-003/004), and on `clear` stores it as a typed memory
// item. Treated as a metered surface throughout: the per-company ceiling is consumed in the request layer, after
// an authorization gate and never before it (CDR-092 §15).
//
// ⚠️ THE METERED GATE HERE IS MEMBER-LEVEL, NOT OWNER-ONLY, AND THAT IS DELIBERATE. The four generate routes use
// `authorizeMeteredGenerate`, which is closed to four OWNER-ONLY actions so a viewer cannot spend the company's
// tokens. Answering an interview question is not owner-only — `evaluateAnswer` inherits `interview:read` and
// `memory:write`, both owner+viewer — so routing it through that gate would refuse every viewer mid-interview.
// It uses `authorizeMeteredParticipate` (`interview:participate`, an action that already existed) instead, which
// keeps §15's actual guarantee: the bucket is debited only after an authorization check passes.
//
// NO AUTHORIZATION CHECK LIVES HERE (CDR-087 §1). The gate above is a pre-debit consultation; core still decides.
//
// State-changing, so the CSRF origin gate in apps/web/src/proxy.ts refuses a cross-site unsafe-method request
// BEFORE the session is established (ACBP-P7-014); `check:csrf-origin-gate` proves the coverage.
//
// THE SESSION IS NOT A PARAMETER. It is resolved from the company's open interview, exactly as the non-metered
// answer route does — a caller-supplied session id would be a second, forgeable source for a fact the server owns.
import { evaluateAnswerForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest, parseEvaluateAnswerBody } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ⚠️ PROVISIONAL AND UNMEASURED, copied from the four generate routes rather than chosen (CDR-092 §3; CDR-091
 * §2.1–2.2). 90s must stay ABOVE the provider deadline so the route does not cut off a call that is still
 * running and would otherwise have been billed for nothing. No live interview evaluation has ever completed from
 * this repository, so this number is inherited, not calibrated.
 */
export const maxDuration = 90;

export async function POST(request: Request, context: { params: Promise<{ companyId: string; questionId: string }> }): Promise<Response> {
  const { companyId, questionId } = await context.params;
  // The SHARED bounded parser, not a bare `request.json()`. There is no global body cap in apps/web, so a bare
  // parse lets an unauthenticated caller make the server buffer an arbitrary payload in front of a paid route.
  const parsed = await parseEvaluateAnswerBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => evaluateAnswerForRequest(companyId, questionId, parsed.input.answerText));
}
