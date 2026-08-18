/*
 * ACBP-FE-013 — what the two strategy write endpoints answered, turned into something the screen can say.
 *
 * ONE MODULE, TWO VERBS. `POST /strategy/selection` (recordStrategyDecision) and `POST /decisions`
 * (recordDecision) have IDENTICAL four-arm domain shapes — ok / forbidden / not_found / invalid — so two copies
 * of this interpreter would be two chances for one of them to drift. What genuinely differs is the meaning of a
 * 404, which is why `verb` is a parameter rather than a second file:
 *
 *   selection → the generation is absent or invisible.
 *   decision  → the core type's own comment names THREE causes: "The generation or the selection is
 *               absent/invisible, or the selection belongs to a different generation." The third is the one a
 *               founder can actually act on, and a shared "not found" sentence would never mention it.
 *
 * TWO WIRE COLLISIONS THE STATUS CODE CANNOT SPLIT:
 *
 *   403 carries `{error:'forbidden'}` OR `{error:'email_unverified'}`. These are opposite instructions — one
 *   says ask an owner for the role, the other says go verify your own address — so the body decides, not the code.
 *
 *   400 carries the DOMAIN's `{error:{category:'validation',…}}` (the decision was refused on its per-mode
 *   shape) OR the ROUTE's generic `{error:'bad_request'}` envelope (the body was malformed and never reached
 *   the domain). The second is OUR defect. Telling a founder to fix their input when this screen sent something
 *   unparseable would blame them for a bug they cannot see. The two are told apart by the SHAPE of `error` —
 *   an OBJECT for the domain's typed envelope, a bare STRING for the generic one — and never by its VALUE.
 *   That distinction is load-bearing: an earlier version of this comment named `internal_error` as the
 *   generic 400 body and a test pinned that fixture, when `genericErrorBody(400)` actually returns
 *   `bad_request`. The detection was right and the evidence written beside it was wrong, which is the worse
 *   half to get wrong — a reader checks the example, not the predicate.
 *
 * WHAT AN `invalid` MEANS DIFFERS BY VERB, and the copy has to follow. On `POST /strategy/selection` the
 * domain runs `validateStrategyDecision`, so a 400 really is about mode, ordinal or the 16-field shape. On
 * `POST /decisions` the ONLY path to `invalid` is `normalizeDecisionRationale` returning `undefined` — a
 * rationale that is present but unusable (non-string or over-long). Naming modes and ordinals there would
 * send a founder to re-check a form the endpoint never looked at.
 *
 * `persisted` IS TRI-STATE ON PURPOSE. Every refusal arm is deny-by-default with nothing written — the core
 * types say so in their own comments — so a founder never has to guess whether to re-submit. The exception is a
 * 500: an unexpected throw can happen AFTER a commit, so the honest answer there is `null` (unknown), not a
 * confident "nothing was saved" this screen has no basis for.
 */

export type OutcomeKind =
  | 'recorded'
  /** The request never completed an HTTP exchange — see {@link networkFailure}. NOT a response. */
  | 'unreachable'
  | 'invalid'
  | 'client_defect'
  | 'forbidden'
  | 'email_unverified'
  | 'not_found'
  | 'rate_limited'
  | 'unauthenticated'
  | 'unavailable'
  | 'server_error'
  | 'unexpected';

/**
 * Which write was attempted. FOUR arms differ by verb, not one: the 404 cause, the invalid cause, the
 * success copy, and the noun interpolated into every remaining sentence. An earlier comment here said "only
 * the 404 copy differs", which stopped being true the moment the 400 became verb-aware.
 */
export type DecisionVerb = 'selection' | 'decision';

export interface Outcome {
  readonly kind: OutcomeKind;
  readonly title: string;
  readonly detail: string;
  /** `true` written, `false` definitely not written, `null` unknown (a 500 may throw after a commit). */
  readonly persisted: boolean | null;
  readonly retryAfterSeconds: number | null;
}

/**
 * Whole positive seconds only.
 *
 * DELIBERATELY NOT `Number()` OR `parseInt()`: `Number('')` is 0, and `parseInt('1.5.2')` is 1 — both would
 * render a countdown the server never stated. A header this screen cannot read is reported as absent.
 */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  if (!/^\d+$/.test(header.trim())) return null;
  const n = Number(header.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const NOTHING_SAVED = 'Nothing was saved, so your choice is unchanged.';

/**
 * `fetch` itself rejected: DNS, offline, a dropped socket. NO HTTP EXCHANGE COMPLETED, so there is no status
 * to interpret and this is not an arm of {@link outcomeFor}.
 *
 * It exists because routing this through `outcomeFor(0, …)` rendered "The server answered with status 0" — a
 * sentence about a server that said nothing at all, and a status code that does not exist. The distinction
 * matters for what the founder should DO: the request may have been received and committed with only the
 * RESPONSE lost, so `persisted` is unknown, and the safe move is to reload and look rather than to re-submit.
 * Re-submitting is the dangerous guess here — a selection is immutable, so a second one is a second record.
 */
export function networkFailure(verb: DecisionVerb): Outcome {
  const noun = verb === 'selection' ? 'choice' : 'decision';
  return {
    kind: 'unreachable',
    title: 'The request did not reach the server',
    detail: `The connection failed before any reply came back, so this page cannot tell whether your ${noun} was recorded. Reload to see the current state — do not submit again, because if the first request did arrive a second one would be recorded separately.`,
    persisted: null,
    retryAfterSeconds: null,
  };
}

function errorCodeOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const e = (body as { error?: unknown }).error;
  return typeof e === 'string' ? e : null;
}

/** True only for the DOMAIN's typed validation envelope, whose `error` is an object carrying `category`. */
function isDomainValidation(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const e = (body as { error?: unknown }).error;
  if (typeof e !== 'object' || e === null) return false;
  return (e as { category?: unknown }).category === 'validation';
}

/** True when a 200 actually carries the payload for the verb attempted. */
function hasPayload(body: unknown, verb: DecisionVerb): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const key = verb === 'selection' ? 'selection' : 'decision';
  const v = (body as Record<string, unknown>)[key];
  return typeof v === 'object' && v !== null;
}

export function outcomeFor(status: number, body: unknown, retryAfterHeader: string | null, verb: DecisionVerb): Outcome {
  const noun = verb === 'selection' ? 'choice' : 'decision';

  if (status === 200) {
    if (hasPayload(body, verb)) {
      return {
        kind: 'recorded',
        title: verb === 'selection' ? 'Your choice is recorded' : 'The decision is recorded',
        detail: verb === 'selection'
          ? 'The server recorded your choice against this generation. It is immutable — a later change is recorded as a new choice rather than as an edit to this one. It is NOT yet the decision the planning gate reads: hardening it into a decision is a second, separate step below.'
          : 'The decision is recorded and immutable. It hardens the selection it names, which is what the planning gate reads.',
        persisted: true,
        retryAfterSeconds: null,
      };
    }
    // A 200 with no payload is not evidence of a write. Reporting success here would tell a founder their
    // choice is saved on the strength of a status code alone.
    return {
      kind: 'unexpected',
      title: 'The server answered without saying what it did',
      detail: `The request succeeded but the response carried no ${noun}, so this page cannot confirm it was recorded. Reload to see the current state before trying again.`,
      persisted: null,
      retryAfterSeconds: null,
    };
  }

  if (status === 400) {
    if (isDomainValidation(body)) {
      return {
        kind: 'invalid',
        title: verb === 'selection' ? 'The server refused this decision' : 'The server refused the reason you gave',
        // PER VERB, because `invalid` has a different single cause on each endpoint. The decisions route runs
        // no per-mode validation at all — its only route to `invalid` is an unusable rationale.
        detail:
          verb === 'selection'
            ? `The decision did not pass the rules for its mode — for example a selected option that is not in this generation, or a rejection with no reasons. ${NOTHING_SAVED}`
            : `The decision itself was fine; the written reason was not usable — it is bounded, and an over-long one is refused rather than truncated. Shorten it or leave it blank, which never blocks the record. ${NOTHING_SAVED}`,
        persisted: false,
        retryAfterSeconds: null,
      };
    }
    return {
      kind: 'client_defect',
      title: 'This page sent something the server could not read',
      detail: `The request was refused before it reached the part of the server that judges decisions, which means this page built it wrongly rather than you entering anything invalid. ${NOTHING_SAVED} Reloading may clear it; if it persists it is a defect worth reporting.`,
      persisted: false,
      retryAfterSeconds: null,
    };
  }

  if (status === 401) {
    return {
      kind: 'unauthenticated',
      title: 'You are signed out',
      detail: `Recording a ${noun} requires a verified session. ${NOTHING_SAVED} Sign in and try again.`,
      persisted: false,
      retryAfterSeconds: null,
    };
  }

  if (status === 403) {
    if (errorCodeOf(body) === 'email_unverified') {
      return {
        kind: 'email_unverified',
        title: 'Your email address is not verified',
        detail: `You are signed in, but the platform requires a verified primary email before it records a ${noun}. Verify the address on your account, then try again. ${NOTHING_SAVED}`,
        persisted: false,
        retryAfterSeconds: null,
      };
    }
    return {
      kind: 'forbidden',
      title: 'This decision is not yours to make',
      detail: `Recording it is restricted to a company owner. The server does not say which of several situations applied, and this page does not guess. ${NOTHING_SAVED}`,
      persisted: false,
      retryAfterSeconds: null,
    };
  }

  if (status === 404) {
    return {
      kind: 'not_found',
      title: 'The server found nothing to record against',
      detail: verb === 'selection'
        ? `The generation this choice refers to could not be resolved. The server does not say why, and this page does not guess. ${NOTHING_SAVED} Reload to see the current generation.`
        : `The generation or the selection could not be resolved, OR the selection belongs to a different generation than the one named. The server answers all three identically and does not say which applied. ${NOTHING_SAVED} Reload to see the current state.`,
      persisted: false,
      retryAfterSeconds: null,
    };
  }

  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
    return {
      kind: 'rate_limited',
      title: 'Too many requests',
      detail: `A request ceiling refused this write.${retryAfterSeconds === null ? ' The server did not say how long to wait.' : ` It should succeed again in about ${String(retryAfterSeconds)} seconds.`} ${NOTHING_SAVED}`,
      persisted: false,
      retryAfterSeconds,
    };
  }

  if (status === 503) {
    return {
      kind: 'unavailable',
      title: 'Something this page depends on is down',
      detail: `The ${noun} could not be recorded because a dependency is unavailable. ${NOTHING_SAVED} Nothing is wrong with your company and a retry is safe.`,
      persisted: false,
      retryAfterSeconds: null,
    };
  }

  if (status === 500) {
    return {
      kind: 'server_error',
      title: 'The server failed while recording this',
      detail: `The server reported an internal failure and gives no detail about it. WHETHER THE ${noun.toUpperCase()} WAS SAVED IS UNKNOWN — the failure can happen either side of the write — so reload and check the current state before trying again rather than re-submitting.`,
      persisted: null,
      retryAfterSeconds: null,
    };
  }

  return {
    kind: 'unexpected',
    title: 'Unexpected response',
    detail: `The server answered with status ${String(status)}, which this screen does not handle. Nothing has been assumed about whether the ${noun} was recorded; reload to see the current state.`,
    persisted: null,
    retryAfterSeconds: null,
  };
}
