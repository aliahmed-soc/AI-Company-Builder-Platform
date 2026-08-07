// ACBP-P1-013 — strict body parsing + safe HTTP mapping for the admin route (apps/web; CDR-019 §16/§17).
//
// STRICTER than the tenant surfaces by design: the body must be EXACTLY `{ reason }` (any unknown property is
// rejected, not dropped), every query parameter is rejected, and the reason is validated (verbatim; >=1
// non-whitespace char; <=512 code points; NUL forbidden) BEFORE any identity/database work — a parse failure
// never reaches the domain. ALL malformed-input causes collapse to ONE generic 400 (content type, size, JSON
// shape, unknown key, invalid reason — no malformed-cause oracle) and every denial to ONE generic 403. The
// response carries ONLY the four approved fields; the reason is never echoed anywhere. No cache, no redirect.
import { rateLimitedResponse } from '../companies/companies-http.js';
import { isJsonContentType, genericErrorBody } from '../webhooks/http.js';
import { readLimitedRawBody, type RawBodyRequest } from '../webhooks/raw-body.js';
import { validateAdminReason } from '@acbp/contracts';
import { readCompanyOverviewForRequest, type AdminRequestResult, type AdminRequestDeps } from './admin-request.js';

// Generous for a <=512-code-point reason (<=2 KiB UTF-8) plus JSON overhead; tiny versus the webhook cap.
export const MAX_ADMIN_BODY_BYTES = 8 * 1024;

type HttpRequest = RawBodyRequest & { readonly headers: Pick<Headers, 'get'> };

function jsonResponse(status: number, body: unknown): Response {
  // no-store on EVERY admin response: cross-tenant admin data (and its denials) must never be cached by any
  // intermediary — belt-and-braces on top of POST semantics + the route's force-dynamic.
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/**
 * Parse the admin read body: EXACTLY `{ reason }` with a valid reason, or one indistinct failure.
 * Returns the VERBATIM validated reason (never trimmed/normalized).
 */
export async function parseAdminReadBody(request: HttpRequest): Promise<{ readonly ok: true; readonly reason: string } | { readonly ok: false }> {
  if (!isJsonContentType(request.headers.get('content-type'))) return { ok: false };
  const body = await readLimitedRawBody(request, MAX_ADMIN_BODY_BYTES);
  if (!body.ok) return { ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.bytes));
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
  const obj = parsed as Record<string, unknown>;
  // EXACT shape: the single key `reason` — an unknown/extra property is a REJECTION here, never dropped.
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== 'reason') return { ok: false };
  const validated = validateAdminReason(obj['reason']);
  if (!validated.ok) return { ok: false };
  return { ok: true, reason: validated.reason };
}

/** Map the bounded admin result to a safe response: 200 (four fields), 401, 503, or ONE coarse 400/403. */
export function toAdminReadResponse(result: AdminRequestResult): Response {
  switch (result.status) {
    case 'ok':
      // EXACTLY the four approved fields (CDR-019 §16) — no accountId, actor ids, reason echo, profile,
      // member, provisioning or audit data.
      return jsonResponse(200, { companyId: result.company.companyId, status: result.company.status, creationMode: result.company.creationMode, createdAt: result.company.createdAt });
    case 'rate_limited':
      // CDR-008 section 8's request ceiling (ACBP-P7-013; CDR-082). Shared helper so every surface throttles
      // identically — same status, same opaque body, same Retry-After.
      return rateLimitedResponse(result.retryAfterSeconds);
    case 'invalid_reason':
      return jsonResponse(400, genericErrorBody(400));
    case 'forbidden':
    case 'email_unverified':
      // ONE opaque 403 for every denial cause (non-admin, revoked, unknown/mismatched target, unverified
      // email, unmapped user) — the generic body, not a named error (no denial-class oracle).
      return jsonResponse(403, { error: 'forbidden' });
    case 'unauthenticated':
      return jsonResponse(401, genericErrorBody(401));
    case 'unavailable':
      return jsonResponse(503, { error: 'unavailable' });
  }
}

/**
 * The complete POST handler (the route file stays thin): query-parameter rejection → strict body parse →
 * the narrow admin use case → safe mapping; an unexpected fault returns the BOUNDED generic 500 (the domain
 * already rolled back — audit-or-nothing). Parse failures return before ANY identity/domain work.
 */
export async function handleAdminReadPost(request: HttpRequest & { readonly url: string }, target: { readonly accountId: string; readonly companyId: string }, deps: AdminRequestDeps = {}): Promise<Response> {
  if ([...new URL(request.url).searchParams.keys()].length > 0) {
    return jsonResponse(400, genericErrorBody(400));
  }
  const parsed = await parseAdminReadBody(request);
  if (!parsed.ok) return jsonResponse(400, genericErrorBody(400));
  try {
    return toAdminReadResponse(await readCompanyOverviewForRequest(target, parsed.reason, deps));
  } catch {
    // Audit-write or other internal failure: the domain transaction rolled back (no data was returned and no
    // audit row exists). Bounded generic envelope only — never provider/SQL/stack detail, never the reason.
    return jsonResponse(500, genericErrorBody(500));
  }
}
