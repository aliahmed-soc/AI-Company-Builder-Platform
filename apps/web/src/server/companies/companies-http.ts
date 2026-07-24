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

/**
 * Run a companies request use case and map it, converting ANY unexpected throw into the BOUNDED generic 500
 * envelope (ACBP-P1-014 Class R restoration).
 *
 * Why: the accepted platform invariant is that every cross-boundary/HTTP error is bounded and sanitized. The
 * P1-012/P1-013 routes already wrap their handlers, but the older company routes let a thrown PlatformError
 * escape the handler — e.g. a malformed `companyId` reaches the resolver's uuid cast and raises 22P02. The
 * framework would then produce its own 500, outside our envelope contract. This restores the invariant
 * without changing any success or denial semantics: statuses and bodies for every already-mapped outcome are
 * untouched; only the previously-unmapped throw path becomes `{"error":"internal_error"}` with status 500.
 */
export async function respondToCompaniesRequest(run: () => Promise<CompaniesRequestResult>): Promise<Response> {
  try {
    return toCompaniesResponse(await run());
  } catch {
    return jsonResponse(500, genericErrorBody(500));
  }
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
      // The typed page: redacted items + honest metadata (projectionMode/asOf/sourceThrough/lagSeconds). Never a
      // raw activity/audit row serialization.
      return jsonResponse(200, {
        items: result.page.items,
        nextCursor: result.page.nextCursor,
        projectionMode: result.page.projectionMode,
        asOf: result.page.asOf,
        sourceThrough: result.page.sourceThrough,
        lagSeconds: result.page.lagSeconds,
      });
    case 'portfolio':
      // The typed portfolio page: redacted items {companyId,name,status,role,createdAt} + the opaque nextCursor.
      // No accountId, actor ids, totals, metrics or aggregates (CDR-017 §9).
      return jsonResponse(200, { items: result.page.items, nextCursor: result.page.nextCursor });
    case 'provisioning':
      // The redacted ordered six-step status (ACBP-P1-012; CDR-018 §12): approved fields only — no accountId,
      // actor/membership ids, free-text failure messages, or internal error detail.
      return jsonResponse(200, {
        companyId: result.provisioning.companyId,
        companyStatus: result.provisioning.companyStatus,
        steps: result.provisioning.steps,
        nextIncompleteStep: result.provisioning.nextIncompleteStep,
        resumable: result.provisioning.resumable,
        exhausted: result.provisioning.exhausted,
        completed: result.provisioning.completed,
      });
    case 'invalid_transition':
      return jsonResponse(409, { error: 'invalid_transition', from: result.from });
    case 'conflict':
      return jsonResponse(409, { error: 'conflict' });
    case 'invalid_cursor':
      return jsonResponse(400, { error: 'invalid_cursor' });
    case 'invalid_limit':
      return jsonResponse(400, { error: 'invalid_limit' });
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
