// ACBP-API-011 — safe HTTP mapping for the account usage rollup route (apps/web).
//
// Keeps Next types out of the domain and never leaks internals, on the `profile-http.ts` pattern beside it.
import { genericErrorBody } from '../webhooks/http.js';
import { rateLimitedResponse } from '../companies/companies-http.js';
import type { UsageRequestResult } from './usage-request.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

/**
 * Run the usage read and map it, converting ANY unexpected throw into the BOUNDED generic 500 envelope
 * (ACBP-P1-014 Class R). The accepted platform invariant is that every cross-boundary HTTP error is bounded and
 * sanitized; an unmapped throw here would be a framework-generated 500 outside that contract.
 */
export async function respondToUsageRequest(run: () => Promise<UsageRequestResult>): Promise<Response> {
  try {
    return toUsageResponse(await run());
  } catch {
    return jsonResponse(500, genericErrorBody(500));
  }
}

export function toUsageResponse(result: UsageRequestResult): Response {
  switch (result.status) {
    case 'ok':
      return jsonResponse(200, { usage: result.usage });
    /**
     * 200 CARRYING NULL, NOT 404 — the CDR-087 §5.0 G9 rule applied to a period.
     *
     * The account exists and the caller may read it; the projection for this period has simply never been
     * computed. A 404 would assert that the period does not exist, which is a different and false statement, and
     * it is how a UI shows an error page on a perfectly normal first visit.
     *
     * `usage: null` AND NOT A ZEROED BODY. Core distinguishes "computed and zero" from "never computed" on
     * purpose; sending zeroes here would collapse that distinction at the last possible moment and hand the
     * client a measurement nobody took. `periodStart` still travels so the client knows WHICH period is absent.
     */
    case 'not_computed':
      return jsonResponse(200, { usage: null, periodStart: result.periodStart });
    // 400: the period is malformed. Its own code rather than the generic envelope, because the client's next move
    // is to fix the parameter — distinct from a refusal, where retrying with a better value cannot help.
    case 'invalid_period':
      return jsonResponse(400, { error: 'invalid_period' });
    case 'rate_limited':
      // CDR-008 §8's request ceiling. The SHARED helper, so every surface throttles identically — same status,
      // same opaque body, same Retry-After.
      return rateLimitedResponse(result.retryAfterSeconds);
    case 'unauthenticated':
      return jsonResponse(401, genericErrorBody(401));
    case 'email_unverified':
      return jsonResponse(403, { error: 'email_unverified' });
    // The same opaque 403 whatever the cause — not an account owner, not a member, no such membership. No oracle.
    case 'forbidden':
      return jsonResponse(403, { error: 'forbidden' });
    case 'not_found':
      return jsonResponse(404, { error: 'not_found' });
    case 'unavailable':
      return jsonResponse(503, { error: 'unavailable' });
  }
}
