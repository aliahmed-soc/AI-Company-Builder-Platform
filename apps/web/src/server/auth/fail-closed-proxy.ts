// ACBP-P1-001 — fail-closed wrapper for the Next.js proxy (middleware).
//
// Clerk's request authentication throws when a request presents a credential it cannot even parse —
// a malformed or tampered Authorization/session token (the observed failure is a base64/JSON decode
// `SyntaxError: Unexpected end of data`). Unwrapped, that throw surfaces as HTTP 500 on EVERY matched
// route. A security boundary must instead fail CLOSED: reject that specific class cleanly as 401.
//
// IMPORTANT: this is NOT a blanket catch. Only errors positively identified as an unparseable /
// invalid / tampered credential become 401. Provider/network unavailability, invalid server
// configuration, Clerk Backend API failures, and any unexpected internal error are re-thrown
// unchanged, so they surface honestly (5xx) and are never silently swallowed or masked as "auth".
import { NextResponse } from 'next/server';
import type { NextMiddleware } from 'next/server';

function textOf(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  return `${name} ${code} ${message}`.toLowerCase();
}

/**
 * True ONLY for failures caused by a credential the provider cannot parse/verify (malformed,
 * corrupt, tampered, or structurally invalid token). Everything else returns false so the caller
 * re-throws it.
 */
export function isUnparseableCredentialError(err: unknown): boolean {
  const hay = textOf(err);
  // Never classify provider/network/transport problems as a credential-parse failure.
  if (/econnrefused|econnreset|enotfound|etimedout|eai_again|enobufs|eaddrinuse|socket hang up|fetch failed|network|dns|timeout|unavailable|jwks|\bjwks\b|failed to (fetch|load)/.test(hay)) {
    return false;
  }
  // Never classify server-configuration problems as a credential-parse failure.
  if (/secret key|publishable key|missing.*key|not configured|configuration|clerk_secret_key|clerk_publishable_key|invalid.*key/.test(hay)) {
    return false;
  }
  // A base64/JSON decode SyntaxError on the token is the canonical malformed/tampered signal.
  if (err instanceof SyntaxError) return true;
  // Explicit malformed/invalid-credential signals from Clerk / JWT verification.
  return /malformed|unexpected end of data|unexpected token|token-invalid|tokeninvalid|invalid (json|token|jwt|base64|signature)|jwt (malformed|invalid|expired|verification failed)|failed to parse|not a valid (jwt|token)|base64/.test(
    hay,
  );
}

export function failClosed(handler: NextMiddleware): NextMiddleware {
  return async (request, event) => {
    try {
      return await handler(request, event);
    } catch (err) {
      if (isUnparseableCredentialError(err)) {
        // Deny cleanly; never surface the underlying parse error.
        return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
      }
      // Preserve provider-unavailability, misconfiguration, Clerk API failures, and internal bugs.
      throw err;
    }
  };
}
