// ACBP-API-002 (CDR-088) — approvals awaiting a human: GET /api/companies/{companyId}/approvals.
//
// Authenticated, company-member read, enforced in @acbp/core. NO AUTHORIZATION CHECK LIVES HERE (CDR-088 §1).
//
// THE ONLY SLICE-2 ROUTE WHOSE CORE RESULT IS A RAW DATABASE ROW. `listApprovalInbox` returns
// `ApprovalRequestRow` (= `Selectable<ApprovalRequestsTable>`), i.e. every column of the table including any
// column added to it later. `listApprovalInboxForRequest` maps that to an ALLOWLISTED `ApprovalInboxItem` before
// it can reach this layer — notably dropping `data` (the raw tool payload), the tenant ids, `run_id` and the
// policy version pins. That mapper is the control; this route must never be pointed at the row directly.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply — safe methods are unaffected by design.
import { listApprovalInboxForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * No supported query parameters yet. Filtering an inbox by risk class or scope is a plausible future need, but an
 * unsupported filter is REFUSED rather than ignored: an approver who believes they are seeing only high-risk
 * items, while actually seeing everything, is a worse failure than an error.
 */
const ALLOWED_PARAMS = new Set<string>();

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  return respondToCompaniesRequest(() => listApprovalInboxForRequest(companyId));
}
