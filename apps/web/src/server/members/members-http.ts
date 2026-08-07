// ACBP-P1-004 — safe HTTP mapping + bounded body parsing for the members routes (apps/web).
//
// Keeps Next types out of the domain and never leaks internals. Bodies are size-capped and JSON-typed;
// only the expected keys survive parsing. The raw invite token is returned ONLY in the invite response
// (the owner conveys it out-of-band). Field-level validation is the domain's job (@acbp/core).
import { rateLimitedResponse } from '../companies/companies-http.js';
import { isJsonContentType, genericErrorBody } from '../webhooks/http.js';
import { readLimitedRawBody, type RawBodyRequest } from '../webhooks/raw-body.js';
import type { MembersRequestResult } from './members-request.js';

export const MAX_MEMBERS_BODY_BYTES = 16 * 1024;

type Parsed<T> = { readonly ok: true; readonly input: T } | { readonly ok: false; readonly status: number };
type HttpRequest = RawBodyRequest & { readonly headers: Pick<Headers, 'get'> };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

async function readJsonObject(request: HttpRequest): Promise<{ ok: true; obj: Record<string, unknown> } | { ok: false; status: number }> {
  if (!isJsonContentType(request.headers.get('content-type'))) return { ok: false, status: 415 };
  const body = await readLimitedRawBody(request, MAX_MEMBERS_BODY_BYTES);
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

/** Parse an invite body → { invitedEmail, role } (raw values; the domain validates). */
export async function parseInviteBody(request: HttpRequest): Promise<Parsed<{ invitedEmail: unknown; role: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { invitedEmail: r.obj['invitedEmail'], role: r.obj['role'] } };
}

/** Parse an accept body → { token }. */
export async function parseAcceptBody(request: HttpRequest): Promise<Parsed<{ token: unknown }>> {
  const r = await readJsonObject(request);
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, input: { token: r.obj['token'] } };
}

/** Map a bounded members result to a safe HTTP response. */

/**
 * Run a request use case and map it, converting ANY unexpected throw into the BOUNDED generic 500 envelope
 * (ACBP-P1-014 Class R restoration of the accepted 'all cross-boundary HTTP errors are bounded + sanitized'
 * invariant). Success and denial semantics are untouched; only the previously-unmapped throw path changes,
 * from a framework-generated error to a bounded internal_error envelope with status 500.
 */
export async function respondToMembersRequest(run: () => Promise<MembersRequestResult>): Promise<Response> {
  try {
    return toMembersResponse(await run());
  } catch {
    return jsonResponse(500, genericErrorBody(500));
  }
}

export function toMembersResponse(result: MembersRequestResult): Response {
  switch (result.status) {
    case 'members':
      return jsonResponse(200, { members: result.members });
    case 'invited':
      // The ONLY place the raw invite token is exposed (owner conveys it out-of-band).
      return jsonResponse(201, { membership: { membershipId: result.membershipId, role: result.role }, inviteToken: result.inviteToken });
    case 'accepted':
      return jsonResponse(200, { membership: { membershipId: result.membershipId, accountId: result.accountId, role: result.role } });
    case 'revoked':
      return new Response(null, { status: 204 });
    case 'rate_limited':
      // CDR-008 section 8's request ceiling (ACBP-P7-013; CDR-082). Shared helper so every surface throttles
      // identically — same status, same opaque body, same Retry-After.
      return rateLimitedResponse(result.retryAfterSeconds);
    case 'validation':
      return jsonResponse(400, { error: result.error });
    case 'conflict':
      return jsonResponse(409, { error: 'conflict' });
    case 'last_owner':
      return jsonResponse(409, { error: 'last_owner' });
    case 'invalid_token':
      return jsonResponse(400, { error: 'invalid_token' });
    case 'email_unverified':
      return jsonResponse(403, { error: 'email_unverified' });
    case 'forbidden':
      return jsonResponse(403, { error: 'forbidden' });
    case 'not_found':
      return jsonResponse(404, { error: 'not_found' });
    case 'unavailable':
      return jsonResponse(503, { error: 'unavailable' });
    case 'unauthenticated':
      return jsonResponse(401, genericErrorBody(401));
  }
}
