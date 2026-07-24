// ACBP-P1-010 — company resume route: POST /api/companies/{companyId}/resume.
//
// Owner-only (enforced in @acbp/core from the company role). Transitions paused→active; an out-of-state
// transition returns 409 invalid_transition. Optional { reason }. Fail-closed. Other methods → 405.
import { resumeCompanyForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// No request body: the transition fact is the whole payload; no caller-supplied reason is accepted or stored.
export async function POST(_request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  return respondToCompaniesRequest(() => resumeCompanyForRequest(companyId));
}
