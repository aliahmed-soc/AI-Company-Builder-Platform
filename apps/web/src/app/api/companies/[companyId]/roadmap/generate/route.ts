// ACBP-API-008 slice 3b (CDR-092) — generate the roadmap from the recorded decision:
// POST /api/companies/{companyId}/roadmap/generate.
//
// ⚠️ THIS ROUTE SPENDS REAL MONEY. Owner-only (`roadmap:generate`, enforced in @acbp/core), metered by the
// per-company ceiling before the use case is invoked, and covered by the CSRF origin gate as a state-changing
// method. None of those three controls lives in this file, and none of them may be re-implemented here
// (CDR-088 §1) — a second authority drifts from the first the moment either changes.
//
// GENERATION IS GATED ON A POSITIVE DECISION. A company whose latest decision REJECTED the strategy gets
// `decision_rejected` (409), the same gate the roadmap EDIT route honours (CDR-039 §7-G1); otherwise a
// rejection could be side-stepped by generating around it.
//
// No body, no query parameters: the domain reads the decision it plans from.
//
// ⚠️ `maxDuration` IS PROVISIONAL AND UNMEASURED — see CDR-092 §3 and the note in the strategy/generate route.
import { generateRoadmapForRequest } from '@/server/companies/companies-request';
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
  return respondToCompaniesRequest(() => generateRoadmapForRequest(companyId));
}
