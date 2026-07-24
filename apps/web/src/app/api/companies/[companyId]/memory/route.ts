// ACBP-P2-006 (create/list) + ACBP-P2-010 (browser filter) — GET + POST /api/companies/{companyId}/memory.
//
// GET lists the company's typed memory items (read = any active company member), redacted, newest-first, bounded.
// It accepts ONLY the browser filter params `type` (a memory type) and `currentOnly` (`true` = live items only);
// any OTHER query param → generic 400. POST creates a typed item (write = any active company member): body
// { type, content, sourceType, sourceRef, confidence? }; the domain validates (type-by-source-path). POST takes
// NO query param. Fail-closed; unexpected throws → the BOUNDED generic 500. Other methods → 405.
import { createMemoryForRequest, listMemoryForRequest } from '@/server/companies/companies-request';
import { parseCreateMemoryBody, respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const badRequest = () => new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });

export async function GET(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // Strict allowlist: only `type` + `currentOnly` are recognized browser filters.
  for (const key of params.keys()) if (key !== 'type' && key !== 'currentOnly') return badRequest();
  const filter: { type?: unknown; currentOnly?: boolean } = {};
  if (params.has('type')) filter.type = params.get('type');
  if (params.get('currentOnly') === 'true') filter.currentOnly = true;
  const { companyId } = await context.params;
  return respondToCompaniesRequest(() => listMemoryForRequest(companyId, filter));
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string }> }): Promise<Response> {
  if ([...new URL(request.url).searchParams.keys()].length > 0) return badRequest();
  const { companyId } = await context.params;
  const parsed = await parseCreateMemoryBody(request);
  if (!parsed.ok) return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  return respondToCompaniesRequest(() => createMemoryForRequest(companyId, parsed.input));
}
