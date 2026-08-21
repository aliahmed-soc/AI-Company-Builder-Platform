// ACBP-P2-010 — a single memory item: GET + PATCH + DELETE /api/companies/{companyId}/memory/{memoryItemId}.
//
// GET returns the item (read = any active company member). PATCH edits it — a versioned SUPERSEDE (OWNER-only,
// enforced in @acbp/core): body { type, content, confidence? }; the domain inserts a new user_edit version + points
// the old row's superseded_by at it, version-guarded (already-superseded → 409 conflict). DELETE is the OWNER-only
// SOFT delete shipped by CDR-025 §0 — described on its handler below. NO query parameter on ANY of the three verbs
// (any present → generic 400). Denial → one opaque 403; validation → 400; unknown item → 404; unexpected throw →
// the BOUNDED generic 500. No PATCH-of-content-in-place, and no HARD delete (there is no DELETE grant). 405 otherwise.
import { getMemoryForRequest, editMemoryForRequest, deleteMemoryForRequest } from '@/server/companies/companies-request';
import { parseEditMemoryBody, respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const badRequest = () => new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
const hasQuery = (request: Request) => [...new URL(request.url).searchParams.keys()].length > 0;

export async function GET(request: Request, context: { params: Promise<{ companyId: string; memoryItemId: string }> }): Promise<Response> {
  if (hasQuery(request)) return badRequest();
  const { companyId, memoryItemId } = await context.params;
  return respondToCompaniesRequest(() => getMemoryForRequest(companyId, memoryItemId));
}

export async function PATCH(request: Request, context: { params: Promise<{ companyId: string; memoryItemId: string }> }): Promise<Response> {
  if (hasQuery(request)) return badRequest();
  const { companyId, memoryItemId } = await context.params;
  const parsed = await parseEditMemoryBody(request);
  if (!parsed.ok) return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  return respondToCompaniesRequest(() => editMemoryForRequest(companyId, memoryItemId, parsed.input));
}

// DELETE = the owner-only SOFT delete (CDR-025 §0). No request body; unknown query params → 400. The item is
// marked deleted (row survives for history/audit) and omitted from the browser thereafter. Already-deleted or
// superseded → 409; unknown/foreign → 404/403; unexpected throw → the BOUNDED generic 500.
export async function DELETE(request: Request, context: { params: Promise<{ companyId: string; memoryItemId: string }> }): Promise<Response> {
  if (hasQuery(request)) return badRequest();
  const { companyId, memoryItemId } = await context.params;
  return respondToCompaniesRequest(() => deleteMemoryForRequest(companyId, memoryItemId));
}
