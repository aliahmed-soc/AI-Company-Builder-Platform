// ACBP-API-001 (CDR-087) — record a strategy decision: POST /api/companies/{companyId}/strategy/selection.
//
// Authenticated and OWNER-ONLY, enforced in @acbp/core (`strategy:select`). NO ROLE CHECK LIVES HERE (CDR-087 §1);
// a viewer's refusal comes back from the domain and is mapped like any other, and it is deliberately
// indistinguishable from a non-member's — distinguishing them would be an oracle (§1-G2).
//
// State-changing, so the CSRF origin gate in apps/web/src/proxy.ts refuses a cross-site unsafe-method request
// BEFORE the session is established (ACBP-P7-014). That gate covers a route added later without being edited, so
// this file carries no CSRF logic of its own and `check:csrf-origin-gate` proves the coverage.
//
// THE BODY IS PARSED, NOT VALIDATED. The route's job is to turn bytes into the shape the request layer forwards;
// whether the decision is well-formed is the domain's ruling, which comes back as `invalid` → 400. `request` is
// therefore passed through untouched — see the note on the cast below.
import type { RecordStrategyDecisionParams } from '@acbp/core';
import { recordStrategySelectionForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = Pick<RecordStrategyDecisionParams, 'generationId' | 'request'>;
type Parsed = { readonly ok: true; readonly body: Body } | { readonly ok: false; readonly status: number };

/**
 * Turn the request body into the forwarded shape, or refuse with a bounded 400.
 *
 * Only `generationId` is checked here, and only for the shape the route must supply to forward at all: a
 * non-empty string. Everything about the decision itself — mode, ordinal, phase scope, whether the option exists
 * in that generation — is the domain's, and re-checking it here would create the second authority CDR-087 §1
 * forbids for authorization and the same drift risk for validation.
 */
async function parseBody(request: Request): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // Unparseable bytes never reach the domain. No detail is echoed: the body may contain anything.
    return { ok: false, status: 400 };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, status: 400 };
  const { generationId, request: decisionRequest } = raw as { generationId?: unknown; request?: unknown };
  if (typeof generationId !== 'string' || generationId.trim() === '') return { ok: false, status: 400 };
  if (typeof decisionRequest !== 'object' || decisionRequest === null) return { ok: false, status: 400 };
  // CAST, NOT VALIDATION, AND DELIBERATELY SO: `StrategyDecisionRequest` is a domain contract with per-mode rules
  // this boundary must not re-implement. `recordStrategyDecision` validates it and answers `invalid`, which maps
  // to a bounded 400 with nothing persisted.
  return { ok: true, body: { generationId, request: decisionRequest as Body['request'] } };
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const parsed = await parseBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => recordStrategySelectionForRequest(companyId, parsed.body));
}
