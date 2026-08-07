// ACBP-P1-002 Slice 3 — safe HTTP mapping helpers for the Clerk webhook Route Handler (apps/web).
//
// These own the leakage-free translation between the neutral webhook result and an HTTP response. No
// internal id, provider id, instance id, email, payload hash, signature, SQL, or provider error text
// is ever placed in a response body. The response STATUS distinguishes rejection classes (per the
// approved matrix); the body stays generic so `applied` vs `duplicate` is not a probing oracle.
import { ErrorCodes, type ErrorCode } from '@acbp/contracts';

/** Only JSON webhook requests are accepted; media-type matched case-insensitively, params ignored. */
export function isJsonContentType(contentType: string | null | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  const media = contentType.split(';')[0]?.trim().toLowerCase();
  return media === 'application/json';
}

/**
 * Map a bounded verifier PublicErrorEnvelope code to a safe HTTP status (approved matrix). Signature
 * problems are 401; malformed/timing are 400; an unexpected verifier fault is 500. Unknown → 500.
 */
export function statusForWebhookCode(code: ErrorCode): number {
  switch (code) {
    case ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_MISSING:
    case ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_CONFLICT:
    case ErrorCodes.WEBHOOK_SIGNATURE_INVALID:
    case ErrorCodes.WEBHOOK_INSTANCE_MISMATCH:
      return 401;
    case ErrorCodes.WEBHOOK_TIMESTAMP_INVALID:
    case ErrorCodes.WEBHOOK_PAYLOAD_MALFORMED:
      return 400;
    case ErrorCodes.WEBHOOK_VERIFIER_FAILED:
    default:
      return 500;
  }
}

/** Generic, status-aligned error body (never carries the class detail beyond the status itself). */
export function genericErrorBody(status: number): { readonly error: string } {
  if (status === 401) return { error: 'unauthorized' };
  if (status === 413) return { error: 'payload_too_large' };
  if (status === 415) return { error: 'unsupported_media_type' };
  if (status === 400) return { error: 'bad_request' };
  if (status === 405) return { error: 'method_not_allowed' };
  // ACBP-P7-013. Without this line a throttled response would carry `internal_error`, which is not merely untidy:
  // it tells a caller their request FAILED when it was REFUSED, and the correct client behaviour differs (wait
  // and retry, versus do not retry). The name says no more than the 429 status already does — no limit value,
  // no remaining balance, no scope.
  if (status === 429) return { error: 'rate_limited' };
  return { error: 'internal_error' };
}

/**
 * Collect a provider-neutral, lowercased header record (exact values preserved). `Headers` already
 * lowercases keys and joins duplicate SAME-name headers; distinct alias names (svix and webhook
 * prefixes) stay separate so the verifier's alias-conflict handling still applies. Next types never leak.
 */
export function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}
