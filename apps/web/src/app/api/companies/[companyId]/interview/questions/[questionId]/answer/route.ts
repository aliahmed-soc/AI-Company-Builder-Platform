// ACBP-P2-002 — record/revise an answer: POST /api/companies/{companyId}/interview/questions/{questionId}/answer.
//
// Records an answer or a skip ("I don't know") for a question in the company's OPEN interview session
// (participate = any active company member, enforced in @acbp/core). Body: { status: 'answered'|'skipped',
// content?: string } — the domain validates (answered needs content; skipped forbids it); resubmitting the
// identical current answer is an idempotent no-op (created: false). Append-only: a genuine change is a NEW
// revision. NO query parameters (any present → generic 400). Unknown question / no open session → 404;
// validation → 400; denial → one opaque 403. Unexpected throws become the BOUNDED generic 500. Other methods → 405.
import { recordAnswerForRequest } from '@/server/companies/companies-request';
import { parseAnswerBody, respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ companyId: string; questionId: string }> }): Promise<Response> {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  const { companyId, questionId } = await context.params;
  const parsed = await parseAnswerBody(request);
  if (!parsed.ok) return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  return respondToCompaniesRequest(() => recordAnswerForRequest(companyId, questionId, parsed.input));
}
