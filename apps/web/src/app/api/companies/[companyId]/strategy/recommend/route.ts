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
import { recommendStrategyForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

type Parsed = { readonly ok: true; readonly generationId: string } | { readonly ok: false };

/**
 * Shape-check the one field, and nothing more.
 *
 * A non-empty string is the minimum needed to forward at all. Whether that id names a generation the caller may
 * reach is core's ruling and comes back as `not_found` — re-deciding it here would be the second authority
 * CDR-088 §1 forbids, and would drift from core the first time the lookup changes.
 */
async function parseBody(request: Request): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // Unparseable bytes never reach the domain, and nothing is echoed back: the body may contain anything.
    return { ok: false };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false };
  const { generationId } = raw as { generationId?: unknown };
  if (typeof generationId !== 'string' || generationId.trim() === '') return { ok: false };
  return { ok: true, generationId };
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const parsed = await parseBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => recommendStrategyForRequest(companyId, { generationId: parsed.generationId }));
}
