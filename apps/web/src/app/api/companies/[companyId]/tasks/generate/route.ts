// ACBP-API-008 slice 3b (CDR-092) — generate the task plan for the approved phase:
// POST /api/companies/{companyId}/tasks/generate.
//
// ⚠️ THIS ROUTE SPENDS REAL MONEY. Owner-only (`task:generate`, narrowed by the ACBP-API-004 ruling and enforced
// in @acbp/core), metered by the per-company ceiling before the use case runs, and covered by the CSRF origin
// gate as a state-changing method. No role check, no rate-limit logic and no CSRF logic in this file (CDR-088 §1).
//
// A PARTIAL PLAN IS A SUCCESS THAT SAYS SO. The 200 body carries `partial` plus three counters — tasks with no
// type, tasks with no rationale, and milestones the prompt budget could not fit. PLAN-001 wants a type on every
// task and ADR-019/TASK-002 forbid inventing one, so a shortfall is reported rather than absorbed. A client that
// renders the tasks and drops the counters re-creates precisely the fabricated completeness the domain refuses
// to produce.
//
// No body, no query parameters: the domain reads the decision and the roadmap it plans against.
//
// ⚠️ `maxDuration` IS PROVISIONAL AND UNMEASURED — see CDR-092 §3 and the note in the strategy/generate route.
import { generateTasksForRequest } from '@/server/companies/companies-request';
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
  return respondToCompaniesRequest(() => generateTasksForRequest(companyId));
}
