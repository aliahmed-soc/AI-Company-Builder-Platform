// ACBP-API-008 slice 3b (CDR-092) — generate the strategy option set:
// POST /api/companies/{companyId}/strategy/generate.
//
// ⚠️ THIS ROUTE SPENDS REAL MONEY. It is one of four in this application that cause a paid provider call, and
// the only reason that is safe to expose is the stack of controls BELOW it, none of which lives in this file:
//
//   • OWNER ONLY — `strategy:generate`, narrowed from owner|viewer by the ACBP-API-004 ruling and enforced
//     inside @acbp/core from the company role. NO ROLE CHECK LIVES HERE (CDR-088 §1); a viewer's refusal comes
//     back from the domain and is deliberately indistinguishable from a non-member's.
//   • THE PER-COMPANY CEILING — consumed in `generateStrategyForRequest` before the use case is invoked, on top
//     of the existing session and account ceilings (CDR-092 §2).
//   • THE CSRF ORIGIN GATE — this is a state-changing method, so apps/web/src/proxy.ts refuses a cross-site
//     unsafe request before the session is even established (ACBP-P7-014), and `check:csrf-origin-gate` proves
//     that coverage without this file carrying CSRF logic of its own.
//
// NO REQUEST BODY AND NO QUERY PARAMETERS. Everything the generation needs — the confirmed understanding, the
// approved phase — the domain reads for itself. A body here would be a second, forgeable source for facts the
// server already holds authoritatively.
//
// ⚠️ `maxDuration` IS PROVISIONAL AND UNMEASURED (CDR-092 §3; CDR-091 §2.1–2.2). 90s must stay ABOVE the 60s
// provider deadline plus the surrounding work, or the route is killed while a legitimate paid call is still
// running — billing for a generation the founder never receives. No live model call has ever completed from
// this repository, so both numbers are a shape, not a measurement. If the deployment platform caps below 90s,
// that must be stated rather than silently accepted.
import { generateStrategyForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => generateStrategyForRequest(companyId));
}
