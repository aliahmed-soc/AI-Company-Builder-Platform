// ACBP-P1-003 — safe HTTP mapping + bounded body parsing for the account-profile route (apps/web).
//
// Keeps Next types out of the domain and never leaks internals. The PATCH body is size-capped and
// UTF-8/JSON validated before parsing; only the two editable keys (displayName, locale) are extracted —
// any other key (e.g. an injected `email` or `accountId`) is dropped here, so the client cannot reach
// fields it does not own. Field-level value validation is the domain's job (normalizeProfileUpdate).
import { isJsonContentType, genericErrorBody } from '../webhooks/http.js';
import { readLimitedRawBody, type RawBodyRequest } from '../webhooks/raw-body.js';
import type { ProfileUpdateInput } from '@acbp/core';
import type { ProfileRequestResult } from './profile-request.js';

/** Profile bodies are tiny; cap well below the webhook limit. */
export const MAX_PROFILE_BODY_BYTES = 16 * 1024;

export type ParseBodyResult = { readonly ok: true; readonly input: ProfileUpdateInput } | { readonly ok: false; readonly status: number };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * Parse + validate the PATCH body into a ProfileUpdateInput. 415 for a non-JSON content type, 413 when
 * over the cap, 400 for malformed length/UTF-8/JSON or a non-object. An empty body is a no-op update
 * (`{}`). Only `displayName` and `locale` survive — other keys are intentionally dropped.
 */
export async function parseProfileUpdateBody(request: RawBodyRequest & { readonly headers: Pick<Headers, 'get'> }): Promise<ParseBodyResult> {
  if (!isJsonContentType(request.headers.get('content-type'))) return { ok: false, status: 415 };

  const body = await readLimitedRawBody(request, MAX_PROFILE_BODY_BYTES);
  if (!body.ok) return { ok: false, status: body.reason === 'too_large' ? 413 : 400 };

  if (body.bytes.byteLength === 0) return { ok: true, input: {} }; // empty body = no-op update

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
  } catch {
    return { ok: false, status: 400 };
  }
  if (text.trim() === '') return { ok: true, input: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400 };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, status: 400 };

  const obj = parsed as Record<string, unknown>;
  const input: { displayName?: unknown; locale?: unknown } = {};
  if ('displayName' in obj) input.displayName = obj['displayName'];
  if ('locale' in obj) input.locale = obj['locale'];
  // Values are validated by the domain (normalizeProfileUpdate); type coercion is deliberately avoided.
  return { ok: true, input: input as ProfileUpdateInput };
}

/** Map a bounded profile result to a safe HTTP response. Success carries the view; errors stay generic. */

/**
 * Run a request use case and map it, converting ANY unexpected throw into the BOUNDED generic 500 envelope
 * (ACBP-P1-014 Class R restoration of the accepted 'all cross-boundary HTTP errors are bounded + sanitized'
 * invariant). Success and denial semantics are untouched; only the previously-unmapped throw path changes,
 * from a framework-generated error to a bounded internal_error envelope with status 500.
 */
export async function respondToProfileRequest(run: () => Promise<ProfileRequestResult>): Promise<Response> {
  try {
    return toProfileResponse(await run());
  } catch {
    return jsonResponse(500, genericErrorBody(500));
  }
}

export function toProfileResponse(result: ProfileRequestResult): Response {
  switch (result.status) {
    case 'ok':
      return jsonResponse(200, { profile: result.profile });
    case 'validation_error':
      return jsonResponse(400, { error: result.error });
    case 'unauthenticated':
      return jsonResponse(401, genericErrorBody(401));
    case 'email_unverified':
      return jsonResponse(403, { error: 'email_unverified' });
    case 'forbidden':
      return jsonResponse(403, { error: 'forbidden' });
    case 'not_found':
      return jsonResponse(404, { error: 'not_found' });
    case 'unavailable':
      return jsonResponse(503, { error: 'unavailable' });
  }
}
