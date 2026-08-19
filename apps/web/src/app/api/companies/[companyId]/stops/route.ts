// ACBP-API-011 — the emergency stop: GET/POST /api/companies/{companyId}/stops (ADMIN-001; CDR-072).
//
// GET is a company-member read (`stop:read`); POST is OWNER-ONLY (`stop:activate`). BOTH are enforced in
// @acbp/core and NO AUTHORIZATION CHECK LIVES HERE (CDR-087 §1) — a viewer's refusal comes back from the domain
// and is mapped like any other, deliberately indistinguishable from a non-member's.
//
// POST is state-changing, so the CSRF origin gate in apps/web/src/proxy.ts refuses a cross-site unsafe-method
// request BEFORE the session is established (ACBP-P7-014). That gate covers a route added later without being
// edited, so this file carries no CSRF logic of its own and `check:csrf-origin-gate` proves the coverage.
//
// ⚠️ THE BODY IS PARSED, NEVER VALIDATED, AND THAT MATTERS MORE HERE THAN ANYWHERE ELSE ON THIS SURFACE. Seven
// scopes are named and only five are enforceable; `activateStop` refuses `capability` and `integration` BY NAME
// (CDR-072 §1-G10) because the tool registry carries no identity for either. If this boundary pre-filtered the
// scope list, an operator asking for one of those two would get a generic 400 instead of the domain's specific
// refusal — and the whole point of refusing by name is that "this scope halts nothing" reaches a human.
import { getStopStateForRequest, activateStopForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest, parseActivateStopBody } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function bounded(status: number): Response {
  return new Response(JSON.stringify(genericErrorBody(status)), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * No supported query parameters. An unsupported one is REFUSED rather than ignored, on the approvals-inbox rule:
 * an operator who believes they are seeing a filtered view of what is halted, while actually seeing something
 * else, is a worse failure than an error — and on this surface it is CDR-072 §0's failure exactly.
 */
const ALLOWED_PARAMS = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return bounded(400);
  }
  return respondToCompaniesRequest(() => getStopStateForRequest(companyId));
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  // The SHARED bounded parser, not a bare `request.json()`. There is no global body cap in apps/web, so a bare
  // parse lets an unauthenticated caller make the server buffer an arbitrarily large payload — and this is the
  // route that halts the platform.
  const parsed = await parseActivateStopBody(request);
  if (!parsed.ok) return bounded(parsed.status);
  return respondToCompaniesRequest(() => activateStopForRequest(companyId, parsed.input));
}
