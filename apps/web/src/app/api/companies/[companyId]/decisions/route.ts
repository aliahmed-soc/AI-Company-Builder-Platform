// ACBP-API-001 (CDR-087) — record the decision that hardens a selection: POST /api/companies/{companyId}/decisions.
//
// Authenticated and OWNER-ONLY, enforced in @acbp/core (`decision:record`). NO ROLE CHECK LIVES HERE (CDR-087 §1).
// State-changing, so the CSRF origin gate in apps/web/src/proxy.ts covers it without this file carrying any CSRF
// logic (ACBP-P7-014), and `check:csrf-origin-gate` proves that coverage.
//
// `rationale` IS OPTIONAL AND ITS ABSENCE IS NOT AN ERROR (CDR-038 §6-G2): a missing "why" never blocks the
// record. It is therefore forwarded only when present — an explicit `undefined` key is not the same thing as the
// key being absent, and the request layer spreads it conditionally for exactly that reason.
import type { RecordDecisionParams } from '@acbp/core';
import { recordDecisionForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = Pick<RecordDecisionParams, 'generationId' | 'selectionId' | 'rationale'>;
type Parsed = { readonly ok: true; readonly body: Body } | { readonly ok: false; readonly status: number };

/**
 * Turn the body into the forwarded shape, or refuse with a bounded 400.
 *
 * Only the two identifiers are shape-checked, and only as non-empty strings — the minimum needed to forward at
 * all. Whether the selection belongs to that generation, and whether the rationale is usable, are the domain's
 * rulings; both come back as `not_found` or `invalid`. `rationale` is typed `unknown` in the contract precisely so
 * the domain can judge it, so this boundary passes it through without inspecting it.
 */
async function parseBody(request: Request): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, status: 400 };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, status: 400 };
  const { generationId, selectionId, rationale } = raw as { generationId?: unknown; selectionId?: unknown; rationale?: unknown };
  if (typeof generationId !== 'string' || generationId.trim() === '') return { ok: false, status: 400 };
  if (typeof selectionId !== 'string' || selectionId.trim() === '') return { ok: false, status: 400 };
  return { ok: true, body: { generationId, selectionId, ...(rationale !== undefined ? { rationale } : {}) } };
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const parsed = await parseBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => recordDecisionForRequest(companyId, parsed.body));
}
