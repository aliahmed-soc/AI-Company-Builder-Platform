/*
 * ACBP-FE-013 / ACBP-FE-014 — interpreting the three metered generate endpoints.
 *
 * `POST /strategy/generate`, `POST /strategy/recommend` and `POST /roadmap/generate` share a shape, so one
 * interpreter serves all three. What they do NOT share is their preconditions, and those are the whole value
 * of this module: each 409 names a DIFFERENT thing the founder must do first, and collapsing them into
 * "cannot generate right now" would throw away the only actionable half of the answer.
 *
 *   no_understanding     → the interview has produced nothing to plan from yet.
 *   not_confirmed        → an understanding exists and has NOT been confirmed. Different action entirely.
 *   stale_understanding  → it was confirmed, then changed. The generation would plan from an old picture.
 *   no_decision          → no strategy decision is recorded, so there is nothing to build a roadmap on.
 *   decision_rejected    → a decision EXISTS and it was a rejection. Retrying is futile until that changes.
 *   stale_decision       → the decision is behind the current understanding.
 *
 * 502 IS NOT 500, AND THE DIFFERENCE MATTERS TO A FOUNDER. `generation_failed` / `recommendation_failed` mean
 * the model call itself did not produce a usable result — the platform is fine, the attempt is not — so a
 * retry is reasonable. An unexpected 500 says nothing of the kind.
 *
 * THESE ARE METERED AND SIT BEHIND A COMPANY CEILING, so 429 is an ordinary outcome rather than an edge case,
 * and `Retry-After` is parsed strictly — see {@link outcomeFor} in `decision-outcome.ts` for why `Number()`
 * and `parseInt` are both wrong here.
 *
 * THE CEILING IS DEBITED ONLY AFTER OWNER-ONLY AUTHORIZATION (head `2046c69` of ACBP-API-008 fixed exactly
 * that), so a 403 must NEVER be phrased as though the caller had spent quota. That is why `forbidden` says
 * nothing about credits.
 */

export type GenerateVerb = 'strategy' | 'recommendation' | 'roadmap';

export type GenerateKind =
  | 'generated'
  | 'unreachable'
  | 'blocked_precondition'
  | 'model_failed'
  | 'forbidden'
  | 'email_unverified'
  | 'not_found'
  | 'rate_limited'
  | 'unauthenticated'
  | 'unavailable'
  | 'server_error'
  | 'unexpected';

export interface GenerateOutcome {
  readonly kind: GenerateKind;
  readonly title: string;
  readonly detail: string;
  /** `true` produced, `false` definitely not, `null` unknown (a 500 can fail either side of the write). */
  readonly produced: boolean | null;
  readonly retryAfterSeconds: number | null;
  /** True when retrying the same call unchanged could plausibly succeed. A precondition 409 never can. */
  readonly retryable: boolean;
}

/** Whole positive seconds only — `Number('')` is 0 and `parseInt('1.5.2')` is 1; both would invent a wait. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  if (!/^\d+$/.test(header.trim())) return null;
  const n = Number(header.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function errorCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const e = (body as { error?: unknown }).error;
  return typeof e === 'string' ? e : null;
}

const NOUN: Readonly<Record<GenerateVerb, string>> = {
  strategy: 'strategy options',
  recommendation: 'recommendation',
  roadmap: 'roadmap',
};

/** Each precondition names what to do next. None of them is retryable as-is — that is what makes them useful. */
const PRECONDITION: Readonly<Record<string, string>> = {
  no_understanding:
    'The interview has not produced an understanding of this company yet, so there is nothing to generate from. Work through the interview first.',
  not_confirmed:
    'An understanding exists but has not been confirmed. Generation reads the CONFIRMED picture, so review it and confirm it, then come back — this is not a failure and nothing was spent.',
  stale_understanding:
    'The confirmed understanding has changed since it was confirmed. Generating now would plan from a picture that is already out of date, so the server refused. Re-confirm the understanding first.',
  no_decision: 'No strategy decision is recorded, and a roadmap is built from one. Record a decision on the strategy screen first.',
  decision_rejected:
    'The decision on record is a REJECTION, and a rejection deliberately does not unlock planning. Retrying will keep failing until a non-reject decision is recorded.',
  stale_decision: 'The recorded decision is behind the current understanding, so the server refused rather than plan from it. Record a decision against the current picture first.',
};

export function generateOutcomeFor(status: number, body: unknown, retryAfterHeader: string | null, verb: GenerateVerb): GenerateOutcome {
  const noun = NOUN[verb];
  const code = errorCodeOf(body);

  if (status === 200 || status === 201) {
    return {
      kind: 'generated',
      title: `Your ${noun} ${verb === 'strategy' ? 'are' : 'is'} ready`,
      detail: 'The server produced it and recorded it. What is shown below is the new result.',
      produced: true,
      retryAfterSeconds: null,
      retryable: false,
    };
  }

  if (status === 409 && code !== null && code in PRECONDITION) {
    return {
      kind: 'blocked_precondition',
      title: 'Something needs to happen first',
      detail: PRECONDITION[code] ?? '',
      produced: false,
      retryAfterSeconds: null,
      // THE POINT OF SPLITTING THESE OUT. Retrying a precondition failure unchanged cannot succeed, so the
      // screen must not offer a retry that is guaranteed to fail again.
      retryable: false,
    };
  }

  if (status === 502) {
    return {
      kind: 'model_failed',
      title: `The attempt did not produce a usable ${noun}`,
      // 502, NOT 500: the platform is fine, this attempt is not.
      detail: `The model call completed without returning something the server would accept, so nothing was recorded. This is about this attempt rather than about your company, and trying again is reasonable.`,
      produced: false,
      retryAfterSeconds: null,
      retryable: true,
    };
  }

  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
    return {
      kind: 'rate_limited',
      title: 'This company has reached its generation ceiling',
      detail: `Generation is metered per company.${retryAfterSeconds === null ? ' The server did not say how long to wait.' : ` It should be available again in about ${String(retryAfterSeconds)} seconds.`} Nothing was produced and nothing was spent on this attempt.`,
      produced: false,
      retryAfterSeconds,
      retryable: true,
    };
  }

  if (status === 401) {
    return { kind: 'unauthenticated', title: 'You are signed out', detail: `Generating a ${noun} requires a verified session. Sign in and try again.`, produced: false, retryAfterSeconds: null, retryable: false };
  }

  if (status === 403) {
    if (code === 'email_unverified') {
      return {
        kind: 'email_unverified',
        title: 'Your email address is not verified',
        detail: `The platform requires a verified primary email before it generates a ${noun}. Verify the address on your account, then try again.`,
        produced: false,
        retryAfterSeconds: null,
        retryable: false,
      };
    }
    return {
      kind: 'forbidden',
      title: 'This is not yours to run',
      // SAYS NOTHING ABOUT CREDITS. The ceiling is debited only AFTER owner-only authorization, so a refused
      // caller has spent nothing — and copy implying otherwise would invent a cost.
      detail: 'Generation is restricted to a company owner. The server does not say which of several situations applied, and this page does not guess. Nothing was produced.',
      produced: false,
      retryAfterSeconds: null,
      retryable: false,
    };
  }

  if (status === 404) {
    return { kind: 'not_found', title: 'The server found nothing to work from', detail: 'What this refers to could not be resolved — it may have been superseded since this page loaded. Reload to see the current state.', produced: false, retryAfterSeconds: null, retryable: false };
  }

  if (status === 503) {
    return { kind: 'unavailable', title: 'Something this depends on is down', detail: `The ${noun} could not be generated because a dependency is unavailable. Nothing was produced and a retry is safe.`, produced: false, retryAfterSeconds: null, retryable: true };
  }

  if (status === 500) {
    return {
      kind: 'server_error',
      title: 'The server failed while generating',
      detail: `The server reported an internal failure and gives no detail. WHETHER ANYTHING WAS RECORDED IS UNKNOWN — the failure can happen either side of the write — so reload and look before trying again.`,
      produced: null,
      retryAfterSeconds: null,
      retryable: false,
    };
  }

  return {
    kind: 'unexpected',
    title: 'Unexpected response',
    detail: `The server answered with status ${String(status)}, which this screen does not handle. Nothing has been assumed about whether a ${noun} was produced; reload to see the current state.`,
    produced: null,
    retryAfterSeconds: null,
    retryable: false,
  };
}

/** `fetch` itself rejected — no HTTP exchange completed, so there is no status to interpret. */
export function generateNetworkFailure(verb: GenerateVerb): GenerateOutcome {
  return {
    kind: 'unreachable',
    title: 'The request did not reach the server',
    detail: `The connection failed before any reply came back, so this page cannot tell whether a ${NOUN[verb]} was produced. Reload to see the current state rather than generating again — generation is metered, and a second attempt would be charged separately.`,
    produced: null,
    retryAfterSeconds: null,
    retryable: false,
  };
}
