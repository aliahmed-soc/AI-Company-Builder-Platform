/*
 * ACBP-FE-006 — interpreting what the pause/resume route answered.
 *
 * SPLIT OUT FROM THE COMPONENT ON PURPOSE. The fetch itself is three lines and untestable without a browser;
 * deciding what a 409 or a 429 MEANS to a founder is the part that can be wrong, so it lives here as a pure
 * function over (status, body, Retry-After) and is unit-tested against the shapes `companies-http.ts`
 * actually returns.
 *
 * The shapes, read from the mapper rather than assumed:
 *   200 { status: <companyStatus> }              — transitioned
 *   409 { error: 'invalid_transition', from }    — the company was not in the required source state
 *   403 { error: 'forbidden' | 'email_unverified' }
 *   429 opaque body + Retry-After header         — the header is the ONLY usable number; no limit is disclosed
 *   503 { error: 'unavailable' }
 */

export type TransitionOutcome =
  | { readonly kind: 'done'; readonly companyStatus: string; readonly message: string }
  /** The company moved under us. `from` is the state it was ACTUALLY in — the one useful fact in a 409. */
  | { readonly kind: 'stale'; readonly from: string; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'retry'; readonly afterSeconds: number | null; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

export function interpretTransitionResponse(status: number, body: unknown, retryAfterHeader: string | null): TransitionOutcome {
  const b = asRecord(body);

  if (status === 200) {
    const companyStatus = typeof b['status'] === 'string' ? b['status'] : 'unknown';
    return { kind: 'done', companyStatus, message: `Done — this company is now ${companyStatus}.` };
  }

  if (status === 409) {
    // THE ONE GENUINELY INFORMATIVE FAILURE. The server tells us the state it found, which is almost always
    // "someone else already did this", so the honest move is to report the real state and re-read.
    const from = typeof b['from'] === 'string' ? b['from'] : 'a different state';
    return {
      kind: 'stale',
      from,
      message: `No change was made: this company was ${from} when the request arrived, not the state that transition requires. The page has been refreshed with what the server currently reports.`,
    };
  }

  if (status === 403) {
    return b['error'] === 'email_unverified'
      ? { kind: 'refused', message: 'Refused: your primary email is not verified. Verify it on your account, then try again.' }
      : { kind: 'refused', message: 'Refused. Pausing and resuming are owner-only, and the server does not distinguish that from the company being unreachable for your account.' };
  }

  if (status === 429) {
    // Retry-After is the only number disclosed — deliberately no bucket balance or limit value. Parse it
    // defensively: a missing or unparseable header is reported as unknown, never as a fabricated zero.
    const parsed = retryAfterHeader === null ? Number.NaN : Number.parseInt(retryAfterHeader, 10);
    const afterSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    return {
      kind: 'retry',
      afterSeconds,
      message:
        afterSeconds === null
          ? 'A request ceiling refused this. The server did not say how long to wait, so try again shortly.'
          : `A request ceiling refused this. Try again in about ${afterSeconds} seconds.`,
    };
  }

  if (status === 401) return { kind: 'refused', message: 'Your session is no longer valid. Sign in again and retry.' };
  if (status === 503) return { kind: 'retry', afterSeconds: null, message: 'A dependency is unavailable, so nothing was changed. Retrying is safe.' };

  // Anything else names its status rather than pretending to understand it.
  return { kind: 'error', message: `The server answered ${status}, which this screen does not handle. Nothing has been assumed about whether the change was applied.` };
}
