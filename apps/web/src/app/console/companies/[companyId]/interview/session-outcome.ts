/*
 * ACBP-FE-007 — interpreting the three bodiless session POSTs: start, suspend and resume.
 *
 * ONE INTERPRETER FOR ALL THREE, because suspend and resume genuinely share an arm set by construction (both
 * run through the same helper at companies-request.ts:381-397) and start differs in exactly two places, both
 * encoded below: it is the only action that can answer `company_not_active`, and it is the only one whose
 * 404 cannot mean "no open session". The `action` argument exists so a refusal can say what did NOT happen;
 * it never changes which arm is chosen except at that 404.
 *
 * THE WIRE SHAPES ARE READ FROM THE ROUTES, NOT ASSUMED:
 *
 *   200 -> { session: <InterviewSessionDTO> }                         companies-http.ts:214-217
 *   400 -> { error: 'bad_request' }        (any query parameter)      interview/route.ts:16-21
 *   401 -> { error: 'unauthorized' }                                  companies-http.ts:268-269
 *   403 -> { error: 'forbidden' } | { error: 'email_unverified' }     companies-http.ts:254-261
 *   404 -> { error: 'not_found' }                                     companies-http.ts:256-257
 *   409 -> { error: 'company_not_active' }               (start only) companies-http.ts:218-220
 *   409 -> { error: 'invalid_transition', from: <state> } (pause/resume) companies-http.ts:246-247
 *   429 -> { error: 'rate_limited' } + Retry-After                    companies-http.ts:262-267
 *   503 -> { error: 'unavailable' }                                   companies-http.ts:258-259
 *   500 -> { error: 'internal_error' }                                companies-http.ts:105-111
 *
 * THE TWO 409s MUST NOT COLLAPSE. "The company is not active" is an honest, actionable state; an illegal
 * transition carries `from` — the server's own word for where the session actually is, and the only detail
 * on that refusal. Switching on the status number alone would hand a founder the wrong diagnosis, so both
 * are split on the `error` code the way create-outcome.ts splits the two 403s.
 *
 * NO CLAIM IS MADE THAT A SESSION WAS NEWLY STARTED. Core returns `created: boolean`
 * (interview-session.ts:49) and the web boundary DROPS it (companies-request.ts:372-373 returns only the
 * session) — unlike the answer arm, which forwards its own `created`. So this screen cannot distinguish "a
 * session was just created" from "one was already open", and a started-toast would be an invention.
 */
import type { InterviewSessionDTO } from '@acbp/contracts';

/** Which control produced the response. Used for copy, and at the 404 (see the header). */
export type SessionAction = 'start' | 'pause' | 'resume';

export type SessionOutcome =
  | { readonly kind: 'ok'; readonly session: InterviewSessionDTO; readonly detail: string }
  /** 409 `invalid_transition` — `from` is the server's own current-state word. */
  | { readonly kind: 'blocked_transition'; readonly from: string; readonly detail: string }
  /** 409 `company_not_active` — start only; an interview can only begin on an active company. */
  | { readonly kind: 'company_not_active'; readonly detail: string }
  /** A 409 whose code this screen does not recognise. Named honestly rather than guessed at. */
  | { readonly kind: 'conflict'; readonly detail: string }
  /** 404 on pause/resume: no OPEN interview session exists. */
  | { readonly kind: 'no_session'; readonly detail: string }
  /** 404 on start: there is no session to be missing, so it can only be actor resolution. */
  | { readonly kind: 'no_user_record'; readonly detail: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'signed_out'; readonly detail: string }
  | { readonly kind: 'forbidden'; readonly detail: string }
  | { readonly kind: 'email_unverified'; readonly detail: string }
  | { readonly kind: 'rate_limited'; readonly detail: string; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'error'; readonly detail: string };

/** Past-tense word for what did not happen, so every refusal can name it. */
const DID_NOT: Record<SessionAction, string> = { start: 'started', pause: 'paused', resume: 'resumed' };

/** See `create-outcome.ts:68-82` — the empty-string guard stops `Number('')` reading as "retry now". */
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

/** A 200 is only a success if it really carries the session envelope. */
function readSession(body: string): InterviewSessionDTO | null {
  const s = readJson(body)?.['session'];
  if (typeof s !== 'object' || s === null) return null;
  const o = s as Record<string, unknown>;
  const looksRight = typeof o['sessionId'] === 'string' && typeof o['companyId'] === 'string' && typeof o['state'] === 'string' && typeof o['phase'] === 'string' && typeof o['createdAt'] === 'string';
  return looksRight ? (s as unknown as InterviewSessionDTO) : null;
}

export function interpretSessionResponse(action: SessionAction, status: number, body: string, retryAfterHeader: string | null): SessionOutcome {
  const did = DID_NOT[action];

  if (status === 200) {
    const session = readSession(body);
    if (session === null) {
      return { kind: 'error', detail: `The server accepted the request but returned a reply this screen could not read. Reload to see whether the interview was ${did}.` };
    }
    // Says only what the server said: here is the session and its state. See the header on `created`.
    return { kind: 'ok', session, detail: `The server accepted the request and reports this session as "${session.phase}".` };
  }

  const o = readJson(body);
  const rawCode = o?.['error'];
  const code = typeof rawCode === 'string' ? rawCode : '';

  switch (status) {
    case 400:
      return { kind: 'malformed', detail: `The server could not read the request this screen sent, so nothing was ${did}. That is a fault in this screen rather than anything you did.` };
    case 401:
      return { kind: 'signed_out', detail: `Your session is not active, so nothing was ${did}. Sign in and try again.` };
    case 403:
      return code === 'email_unverified'
        ? { kind: 'email_unverified', detail: `Your email address is not verified, so nothing was ${did}. The platform requires a verified primary address first.` }
        : { kind: 'forbidden', detail: `The server refused this and nothing was ${did}. Several different situations produce an identical refusal here, and the response does not say which one applied.` };
    case 404:
      // The one place `action` changes which arm is chosen. Start has no domain not_found arm at all, so a
      // 404 there cannot mean "no session" — only that actor resolution found no internal user record.
      return action === 'start'
        ? { kind: 'no_user_record', detail: 'You are signed in, but no internal user record exists for this sign-in yet — usually a provisioning step that has not landed. Reloading in a moment often resolves it.' }
        : {
            kind: 'no_session',
            // Names BOTH causes. This 404 covers "no open interview session exists" AND actor resolution
            // finding no internal user record — the same two-in-one the start arm above has, and the first
            // version of this sentence asserted only the first as though the server had distinguished them.
            detail: `The server found nothing to act on, so nothing was ${did}. That usually means no interview session is open for this company, though the same response also covers this sign-in having no internal user record yet — and the response does not say which applied. Reload to see the current state.`,
          };
    case 409: {
      if (code === 'company_not_active') {
        return { kind: 'company_not_active', detail: 'An interview can only be started on an active company, and the server reports this one is not active right now. Nothing was started.' };
      }
      const rawFrom = o?.['from'];
      const from = typeof rawFrom === 'string' ? rawFrom : null;
      if (code === 'invalid_transition' && from !== null) {
        return {
          kind: 'blocked_transition',
          from,
          // Quotes the server's own state word — the only detail this refusal carries.
          detail: `The server reports this session as "${from}", and that is not a state it allows this change from. Nothing was ${did}; reload to see where the session actually stands.`,
        };
      }
      // An `invalid_transition` with no `from` lands here too, deliberately: the arm above exists to surface
      // the server's state word, and without one there is nothing to surface and no reason to claim there is.
      return { kind: 'conflict', detail: `The server refused this and nothing was ${did}. It did not say which of several possible reasons applied.` };
    }
    case 429:
      return { kind: 'rate_limited', detail: `A request ceiling refused this, and nothing was ${did}.`, retryAfterSeconds: parseRetryAfter(retryAfterHeader) };
    case 503:
      return { kind: 'unavailable', detail: `Something this depends on is down, so nothing was ${did}. Nothing is wrong with your account, and retrying is safe.` };
    default:
      return { kind: 'error', detail: `The server answered with a status this screen does not handle: ${String(status)}. Nothing has been assumed about whether the interview was ${did} — reload to see the current state.` };
  }
}
