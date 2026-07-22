// ACBP-P1-010 — safe HTTP mapping + bounded body parsing for the companies routes (apps/web).
//
// Keeps Next types out of the domain and never leaks internals. Bodies are size-capped and JSON-typed; only
// the expected keys survive parsing. Field-level validation is the domain's job (@acbp/core). A denial is the
// same opaque 403 regardless of cause (not a member vs not allowed) — no oracle.
import { isJsonContentType, genericErrorBody } from '../webhooks/http.js';
import { readLimitedRawBody, type RawBodyRequest } from '../webhooks/raw-body.js';
import type { CompaniesRequestResult } from './companies-request.js';

export const MAX_COMPANIES_BODY_BYTES = 16 * 1024;

type Parsed<T> = { readonly ok: true; readonly input: T } | { readonly ok: false; readonly status: number };
type HttpRequest = RawBodyRequest & { readonly headers: Pick<Headers, 'get'> };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function readJsonObject(request: HttpRequest): Promise<{ ok: true; obj: Record<string, unknown> } | { ok: false; status: number }> {
  if (!isJsonContentType(request.headers.get('content-type'))) return { ok: false, status: 415 };
  const body = await readLimitedRawBody(request, MAX_COMPANIES_BODY_BYTES);
  if (!body.ok) return { ok: false, status: body.reason === 'too_large' ? 413 : 400 };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
  } catch {
    return { ok: false, status: 400 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400 };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, status: 400 };
  return { ok: true, obj: parsed as Record<string, unknown> };
}

/** Parse a create-company body → { creationMode, name, description } (raw values; the domain validates). */
export async function parseCreateCompanyBody(request: HttpRequest): Promise<Parsed<{ creationMode: unknown; name: unknown; description: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { creationMode: r.obj['creationMode'], name: r.obj['name'], description: r.obj['description'] } };
}

/** Parse a rename/profile-edit body → { name, description } (raw values; the domain validates). */
export async function parseRenameCompanyBody(request: HttpRequest): Promise<Parsed<{ name: unknown; description: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { name: r.obj['name'], description: r.obj['description'] } };
}

/** Map a bounded companies result to a safe HTTP response. */
export function toCompaniesResponse(result: CompaniesRequestResult): Response {
  switch (result.status) {
    case 'created':
      return jsonResponse(201, { company: { companyId: result.companyId, status: result.companyStatus, creationMode: result.creationMode } });
    case 'company':
      return jsonResponse(200, { company: result.company });
    case 'renamed':
      return jsonResponse(200, result.version !== undefined ? { changed: result.changed, version: result.version } : { changed: result.changed });
    case 'transitioned':
      return jsonResponse(200, { status: result.companyStatus });
    case 'validation':
      return jsonResponse(400, { error: result.error });
    case 'activity':
      return jsonResponse(200, { items: result.page.items, nextCursor: result.page.nextCursor, asOf: result.page.asOf });
    case 'invalid_transition':
      return jsonResponse(409, { error: 'invalid_transition', from: result.from });
    case 'conflict':
      return jsonResponse(409, { error: 'conflict' });
    case 'invalid_cursor':
      return jsonResponse(400, { error: 'invalid_cursor' });
    case 'forbidden':
      return jsonResponse(403, { error: 'forbidden' });
    case 'not_found':
      return jsonResponse(404, { error: 'not_found' });
    case 'unavailable':
      return jsonResponse(503, { error: 'unavailable' });
    case 'email_unverified':
      return jsonResponse(403, { error: 'email_unverified' });
    case 'unauthenticated':
      return jsonResponse(401, genericErrorBody(401));
  }
}
