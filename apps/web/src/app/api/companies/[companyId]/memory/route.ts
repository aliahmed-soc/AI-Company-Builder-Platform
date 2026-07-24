// ACBP-P2-006 — typed memory routes: GET + POST /api/companies/{companyId}/memory.
//
// GET lists the company's typed memory items (read = any active company member), redacted, newest-first,
// bounded. POST creates a typed item (write = any active company member): body { type, content, sourceType,
// sourceRef, confidence? } — the domain validates (known type + known source_type + type-by-source-path so a
// generated claim can never be a user_fact + resolvable source_ref), and audits memory.item_created in the same
// transaction. NO query parameters on either verb (any present → generic 400; filtering is P2-010's browser).
// Fail-closed; unexpected throws → the BOUNDED generic 500. Denial → one opaque 403; validation → 400. Other
// methods → 405.
import { createMemoryForRequest, listMemoryForRequest } from '@/server/companies/companies-request';
import { parseCreateMemoryBody, respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function rejectQuery(request: Request): Response | null {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const bad = rejectQuery(request);
  if (bad) return bad;
  const { companyId } = await context.params;
  return respondToCompaniesRequest(() => listMemoryForRequest(companyId));
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const bad = rejectQuery(request);
  if (bad) return bad;
  const { companyId } = await context.params;
  const parsed = await parseCreateMemoryBody(request);
  if (!parsed.ok) return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  return respondToCompaniesRequest(() => createMemoryForRequest(companyId, parsed.input));
}
