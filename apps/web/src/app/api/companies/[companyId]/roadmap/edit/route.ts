// ACBP-API-002 (CDR-088) — revise the current roadmap: POST /api/companies/{companyId}/roadmap/edit.
//
// Authenticated and OWNER-ONLY, enforced in @acbp/core (ROAD-002). NO ROLE CHECK LIVES HERE (CDR-088 §1); a
// viewer's refusal comes back from the domain and is deliberately indistinguishable from a non-member's.
//
// THE ONLY STATE-CHANGING ROUTE IN SLICE 2. The CSRF origin gate in apps/web/src/proxy.ts therefore refuses a
// cross-site unsafe-method request BEFORE the session is established (ACBP-P7-014), and `check:csrf-origin-gate`
// proves that coverage without this file carrying any CSRF logic of its own.
//
// THE BODY IS PARSED, NOT VALIDATED. `plan` is a string the domain's deny-by-default parser judges, and `reason`
// is typed `unknown` in the contract precisely so the domain rules on it — re-checking either here would create
// the second authority §1 forbids and would drift from core the first time the parser changes.
//
// `expectedRoadmapId` is the VERSION GUARD: core refuses with `stale_version` (409) when it is not the company's
// current roadmap, so a concurrent edit cannot silently overwrite a plan the owner never saw.
import { editRoadmapForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = { readonly expectedRoadmapId: string; readonly plan: string; readonly reason: unknown };
type Parsed = { readonly ok: true; readonly body: Body } | { readonly ok: false; readonly status: number };

/**
 * Turn the body into the forwarded shape, or refuse with a bounded 400.
 *
 * Only the two identifiers are shape-checked, and only as non-empty strings — the minimum needed to forward at
 * all. Whether the plan parses, and whether the reason is usable, are the domain's rulings and come back as
 * `invalid`.
 */
async function parseBody(request: Request): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // Unparseable bytes never reach the domain, and nothing is echoed: the body may contain anything.
    return { ok: false, status: 400 };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, status: 400 };
  const { expectedRoadmapId, plan, reason } = raw as { expectedRoadmapId?: unknown; plan?: unknown; reason?: unknown };
  if (typeof expectedRoadmapId !== 'string' || expectedRoadmapId.trim() === '') return { ok: false, status: 400 };
  if (typeof plan !== 'string' || plan.trim() === '') return { ok: false, status: 400 };
  return { ok: true, body: { expectedRoadmapId, plan, reason } };
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const parsed = await parseBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => editRoadmapForRequest(companyId, parsed.body));
}
