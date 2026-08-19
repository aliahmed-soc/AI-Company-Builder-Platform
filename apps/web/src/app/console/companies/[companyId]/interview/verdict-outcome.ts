/*
 * ACBP-FE-008 — interpreting the two ADAPTIVE interview replies (DISC-003 / DISC-005):
 *
 *   POST .../interview/questions/{questionId}/evaluate    → the server's verdict on an answer
 *   POST .../interview/questions/{questionId}/assumption  → the "I don't know" path
 *
 * Pure, `(status, body, retryAfterHeader) -> outcome`, following `answer-outcome.ts` beside it.
 *
 * ⚠️ **NOTHING HERE SCORES AN ANSWER.** The row's explicit exclusion is "no client-side answer scoring", and
 * its authorization line says the server "decides whether to re-ask; the UI must not implement its own
 * heuristic". So this module reads a verdict; it never computes one. There is no length check, no keyword
 * list, no "that looks vague" branch. A verdict the server did not send does not exist — an unreadable 200
 * becomes `error`, never a guess.
 *
 * THE WIRE SHAPES ARE READ FROM THE ROUTE, NOT ASSUMED (companies-http.ts, the `answer_evaluated` and
 * `assumption_suggested` arms):
 *
 *   evaluate   200 -> { verdict: 'clear',         memoryItemId: string }
 *              200 -> { verdict: 'vague',         clarification: string }
 *              200 -> { verdict: 'contradictory', conflict: string }
 *   assumption 200 -> { assumption: string | null, memoryItemId: string | null }
 *   both       400/401/403/404/413/415/429/503/500 as the shared companies envelope.
 *
 * ⚠️ EACH VERDICT CARRIES ONLY ITS OWN FIELD, AND THIS MODULE MUST NOT PAPER OVER THAT. A `clear` reply has
 * no `clarification`. Reading the three arms into one optional-everything object is how a screen ends up
 * showing a founder a request to rephrase an answer the server accepted.
 *
 * ⚠️ `assumption: null` IS A SUCCESS. The model declining to assume anything is an honest answer, not a
 * failure — `ai_assumption` exists precisely so an assumed thing stays separable from a stated one, and
 * inventing one to fill the gap would defeat that. It maps to `nothing_assumed`, which is not an error kind.
 */

export type VerdictOutcome =
  /** The server accepted the answer and stored it as a typed memory item. */
  | { readonly kind: 'clear'; readonly memoryItemId: string; readonly label: string; readonly detail: string }
  /**
   * THE RE-ASK. The row requires it be "labelled as such": `label` is the words a screen shows, and
   * `clarification` is the SERVER's question, carried verbatim because paraphrasing it discards the only
   * specific information in the reply.
   */
  | { readonly kind: 'reask'; readonly clarification: string; readonly label: string; readonly detail: string }
  /** The answer contradicts something already established. Also a re-ask, but for a different reason. */
  | { readonly kind: 'contradiction'; readonly conflict: string; readonly label: string; readonly detail: string }
  | VerdictRefusal;

export type AssumptionOutcome =
  /** An assumption was proposed AND recorded as an assumption — never as a stated fact. */
  | { readonly kind: 'assumed'; readonly assumption: string; readonly memoryItemId: string | null; readonly label: string; readonly detail: string }
  /** The model declined to assume anything. A SUCCESS, and deliberately not an error kind. */
  | { readonly kind: 'nothing_assumed'; readonly label: string; readonly detail: string }
  | VerdictRefusal;

/** The refusal arms both routes share. Identical because both go through the same companies envelope. */
export type VerdictRefusal =
  | { readonly kind: 'invalid'; readonly serverMessage: string; readonly detail: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'malformed_media'; readonly detail: string }
  | { readonly kind: 'signed_out'; readonly detail: string }
  | { readonly kind: 'forbidden'; readonly detail: string }
  | { readonly kind: 'email_unverified'; readonly detail: string }
  | { readonly kind: 'not_found'; readonly detail: string }
  | { readonly kind: 'too_large'; readonly detail: string }
  | { readonly kind: 'rate_limited'; readonly detail: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string };

/**
 * Retry-After, only when the server really sent a usable one.
 *
 * THE EMPTY-STRING GUARD IS LOAD-BEARING: `Number('')` is `0`, not `NaN`, so an empty header would parse as a
 * perfectly valid "wait zero seconds" — telling a rate-limited founder to hammer a route that SPENDS MONEY on
 * every call. Copied deliberately from `answer-outcome.ts`, where a failing test put it there.
 */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errorCode(body: string): string {
  const e = readJson(body)?.['error'];
  return typeof e === 'string' ? e : '';
}

function readEnvelopeMessage(body: string): string | null {
  const e = readJson(body)?.['error'];
  if (typeof e !== 'object' || e === null) return null;
  const message = (e as Record<string, unknown>)['message'];
  return typeof message === 'string' && message !== '' ? message : null;
}

/** A non-empty string, or null. Blank is treated as absent: an empty clarification is not a question. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The shared refusal mapping. Both routes SPEND MONEY, so the 429 and 503 copy says what was and was not
 * charged — a founder who cannot tell whether a failed call consumed their ceiling will retry blindly.
 */
function refusalFor(status: number, body: string, retryAfterHeader: string | null): VerdictRefusal {
  const code = errorCode(body);
  switch (status) {
    case 400: {
      const message = readEnvelopeMessage(body);
      if (message !== null) {
        // VERBATIM. The server names the problem; paraphrasing discards the only precise thing in the reply.
        return { kind: 'invalid', serverMessage: message, detail: 'The server judged this request and reports the problem it found.' };
      }
      return { kind: 'malformed', detail: 'The server could not read what this screen sent, so nothing was evaluated and nothing was charged. That is a fault in this screen rather than in anything you typed.' };
    }
    case 401:
      return { kind: 'signed_out', detail: 'Your session is not active, so nothing was evaluated. Sign in and try again — your text is still here.' };
    case 403:
      return code === 'email_unverified'
        ? { kind: 'email_unverified', detail: 'Your email address is not verified. The platform requires a verified primary address before it will run this. Verify it on your account, then try again.' }
        : {
            kind: 'forbidden',
            // NAMES NO SINGLE CAUSE. One opaque 403 covers non-membership, a denied role, and a company that
            // does not exist; the server deliberately does not distinguish them, and neither does this.
            detail: 'The server refused this. Several situations produce an identical refusal — the company may not be yours, or your role may not permit it — and the response deliberately does not say which.',
          };
    case 404:
      return { kind: 'not_found', detail: 'The server found nothing at that address. The interview or the question may have moved; reload the interview before answering again.' };
    case 413:
      return { kind: 'too_large', detail: 'That answer is longer than the server will accept, so nothing was evaluated and nothing was charged. Shorten it and try again.' };
    case 415:
      return { kind: 'malformed_media', detail: 'This screen sent a format the server does not accept. Nothing was evaluated. That is a fault in this screen.' };
    case 429: {
      const retryAfterSeconds = parseRetryAfter(retryAfterHeader);
      return {
        kind: 'rate_limited',
        retryAfterSeconds,
        detail: `This company has reached its ceiling for calls that cost money, so nothing was evaluated and nothing was charged.${retryAfterSeconds === null ? ' The server did not say how long to wait.' : ` It should succeed again in about ${String(retryAfterSeconds)} seconds.`}`,
      };
    }
    case 503:
      return { kind: 'unavailable', detail: 'Something this depends on is unavailable, so nothing was evaluated. Nothing was charged and retrying is safe.' };
    default:
      return { kind: 'error', detail: `The server answered with a status this screen does not handle: ${String(status)}. Nothing has been shown rather than guessing at what it meant.` };
  }
}

export function interpretEvaluateResponse(status: number, body: string, retryAfterHeader: string | null): VerdictOutcome {
  if (status !== 200) return refusalFor(status, body, retryAfterHeader);

  const o = readJson(body);
  const verdict = o?.['verdict'];

  // Read each arm by ITS OWN required field. A `clear` reply with no `memoryItemId`, or a `vague` one with no
  // clarification, is not a verdict this screen can act on — and the honest answer is that it could not be read.
  if (verdict === 'clear') {
    const memoryItemId = text(o?.['memoryItemId']);
    if (memoryItemId !== null) {
      return { kind: 'clear', memoryItemId, label: 'Answer accepted', detail: 'The server judged this answer clear and recorded it.' };
    }
  } else if (verdict === 'vague') {
    const clarification = text(o?.['clarification']);
    if (clarification !== null) {
      return {
        kind: 'reask',
        clarification,
        // THE ROW'S REQUIREMENT, IN ONE FIELD: "a re-ask is labelled as such".
        label: 'The server is asking again',
        detail: 'The server judged this answer too vague to record and asked a follow-up. It has not been stored yet.',
      };
    }
  } else if (verdict === 'contradictory') {
    const conflict = text(o?.['conflict']);
    if (conflict !== null) {
      return {
        kind: 'contradiction',
        conflict,
        label: 'This conflicts with something recorded earlier',
        detail: 'The server judged this answer to contradict something already established, and has not stored it.',
      };
    }
  }

  return { kind: 'error', detail: 'The server replied with a verdict this screen could not read, so nothing is shown. Reload the interview to see what is actually stored before answering again.' };
}

export function interpretAssumptionResponse(status: number, body: string, retryAfterHeader: string | null): AssumptionOutcome {
  if (status !== 200) return refusalFor(status, body, retryAfterHeader);

  const o = readJson(body);
  if (o === null || !('assumption' in o)) {
    return { kind: 'error', detail: 'The server replied in a shape this screen could not read, so nothing is shown.' };
  }

  const assumption = text(o['assumption']);
  if (assumption === null) {
    // NOT AN ERROR. See the header: the model declining to assume is an honest answer.
    return {
      kind: 'nothing_assumed',
      label: 'No assumption was made',
      detail: 'The server had nothing it was willing to assume for this question, so nothing was recorded. The question stays unanswered rather than being filled with a guess.',
    };
  }

  return {
    kind: 'assumed',
    assumption,
    memoryItemId: text(o['memoryItemId']),
    // THE ROW'S REQUIREMENT: "an assumption is shown as an assumption". The label is words, not a colour —
    // a founder must be able to tell an assumed thing from something they said, and the platform stores it as
    // a distinct memory type for exactly that reason.
    label: 'Assumed, not stated by you',
    detail: 'The server proposed this and recorded it as an assumption rather than as something you told it. Correct it if it is wrong — it will be used as though it were true until you do.',
  };
}
