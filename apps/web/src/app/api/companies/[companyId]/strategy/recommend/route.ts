// ACBP-API-008 slice 3b (CDR-092) — recommend one option from a generation:
// POST /api/companies/{companyId}/strategy/recommend.
//
// ⚠️ THIS ROUTE SPENDS REAL MONEY. Owner-only (`strategy:recommend`, narrowed by the ACBP-API-004 ruling and
// enforced in @acbp/core), metered by the per-company ceiling before the use case runs, and covered by the CSRF
// origin gate as a state-changing method. No role check and no rate-limit logic here (CDR-088 §1).
//
// THE ONLY ONE OF THE FOUR THAT TAKES A BODY, and it carries exactly one field: which generation to recommend
// from. It is a SELECTOR, not an authorization input — core resolves it under the caller's company scope, so a
// generation belonging to another company is `not_found`, indistinguishable from one that never existed.
//
// A NULL RECOMMENDATION IS A 200. The model may decline to single an option out, and that is an answer, not an
// absence — mapping it to 404 would tell the caller the generation does not exist, which is false.
// THE BODY IS READ THROUGH THE SHARED BOUNDED PARSER, not a local `request.json()`. The four sibling write
// routes each roll their own, with no size cap and no content-type check; there is no global body cap in
// `apps/web` behind them, so an unauthenticated caller can make the server buffer an arbitrarily large payload.
// That is a defect to stop repeating rather than a convention to follow, and least of all here, on the one
// metered route of the four that accepts input at all. `parseRecommendBody` owns the cap, the 415 and the shape.
import { recommendStrategyForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest, parseRecommendBody } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const parsed = await parseRecommendBody(request);
  if (!parsed.ok) {
    // Nothing is echoed back — the body may contain anything, and the status alone says what to fix.
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => recommendStrategyForRequest(companyId, { generationId: parsed.input.generationId }));
}
