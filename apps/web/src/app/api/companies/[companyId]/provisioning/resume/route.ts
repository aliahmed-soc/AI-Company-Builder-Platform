// ACBP-P1-012 — workspace-provisioning resume route: POST /api/companies/{companyId}/provisioning/resume.
//
// Owner-only (enforced in @acbp/core from the fresh company role via provisioning:resume). Idempotent: resumes
// pending or retryable-failed work from the first incomplete checkpoint and returns the ordered status after
// processing; completed provisioning returns success without mutation; an exhausted step returns a safe 409.
// NO query parameters (any present → generic 400) and NO request body is accepted or parsed (mirrors the
// pause/resume lifecycle routes — the request itself is the whole payload). This is the ONLY provisioning
// mutation surface: no start/retry/acknowledge/cancel route exists. Fail-closed. Other methods → 405.
import { resumeProvisioningForRequest } from '@/server/companies/companies-request';
import { toCompaniesResponse } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const { companyId } = await context.params;
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  try {
    return toCompaniesResponse(await resumeProvisioningForRequest(companyId));
  } catch {
    // An unexpected mid-step error (e.g. a transient DB failure) rolled the step back; the durable checkpoints
    // are untouched and a later resume continues. Return the BOUNDED generic envelope — never framework detail.
    return new Response(JSON.stringify(genericErrorBody(500)), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
}
