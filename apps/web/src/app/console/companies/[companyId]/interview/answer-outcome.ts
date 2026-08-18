/*
 * ACBP-FE-007 — interpreting `POST /api/companies/{id}/interview/questions/{questionId}/answer`.
 *
 * PURE, `(status, body, retryAfterHeader, submitted) -> outcome`, following `create-outcome.ts` beside it.
 * The extra `submitted` argument is not decoration — see the `created: false` note below; without it the
 * screen cannot tell a saved answer from a lost one.
 *
 * THE WIRE SHAPES ARE READ FROM THE ROUTE, NOT ASSUMED:
 *
 *   200 -> { answer: <AnswerDTO>, created: boolean }             companies-http.ts:221-224
 *   400 -> { error: <PublicErrorEnvelope> }  (domain judged it)  companies-http.ts:180-181
 *   400 -> { error: 'bad_request' }          (route, pre-domain) answer/route.ts:17-19
 *   401 -> { error: 'unauthorized' }                             companies-http.ts:268-269
 *   403 -> { error: 'forbidden' } | { error: 'email_unverified' } companies-http.ts:254-261
 *   404 -> { error: 'not_found' }                                companies-http.ts:256-257
 *   413 -> { error: 'payload_too_large' }                        companies-http.ts:39-41
 *   415 -> { error: 'unsupported_media_type' }                   companies-http.ts:39-41
 *   429 -> { error: 'rate_limited' } + Retry-After               companies-http.ts:262-267
 *   503 -> { error: 'unavailable' }                              companies-http.ts:258-259
 *   500 -> { error: 'internal_error' }                           companies-http.ts:105-111
 *
 * THERE IS NO 409 ARM, AND THAT ABSENCE IS DELIBERATE. `RecordAnswerResult` is exactly
 * `ok | forbidden | not_found | validation` (core interview-qa.ts:46-50), so this route cannot conflict. A
 * `case 409:` would handle something the server never sends — a claim no test could falsify. It falls
 * through to `error`, which says honestly that the status was not one this screen knows.
 *
 * `created: false` HAS TWO CAUSES AND ONE OF THEM MEANS THE ANSWER WAS NOT SAVED.
 * The ordinary cause is idempotency: the submission was identical to the stored answer, so no revision was
 * appended (core interview-qa.ts:113-115). The other is contention — after MAX_APPEND_ATTEMPTS revision
 * collisions the loop gives up and "return[s] the current answer truthfully (never a 500)"
 * (interview-qa.ts:134-136), which may be ANOTHER WRITER'S text. Both arrive as 200 `created: false`.
 * The client can tell them apart, and must: compare what came back against what was sent. Collapsing them
 * into one "saved" message is how a founder's answer vanishes behind a success notice.
 *
 * The comparison uses the contract's own `isSameAnswer` rather than a hand-rolled equality, because that is
 * the exact predicate the SERVER used to decide idempotency. A private re-implementation that drifted from
 * it would misclassify precisely the cases this arm exists to catch.
 */
import { isSameAnswer } from '@acbp/contracts';
import type { AnswerDTO, AnswerSubmission } from '@acbp/contracts';

export type AnswerOutcome =
  /** A new revision was appended. */
  | { readonly kind: 'saved'; readonly answer: AnswerDTO; readonly detail: string }
  /** Identical to what was already stored — the server appended nothing, and nothing was lost. */
  | { readonly kind: 'unchanged'; readonly answer: AnswerDTO; readonly detail: string }
  /**
   * THE ANSWER WAS NOT SAVED. The server returned a current answer that is not the one submitted. See the
   * header. `storedContent` is what is actually in the record now, so the founder can see what replaced it.
   */
  | { readonly kind: 'overwritten_by_other'; readonly answer: AnswerDTO; readonly storedContent: string | null; readonly detail: string }
  /** A 400 the DOMAIN produced: `error` is a PublicErrorEnvelope OBJECT whose message names the problem. */
  | { readonly kind: 'invalid'; readonly code: string; readonly serverMessage: string; readonly detail: string }
  /** A 400 the ROUTE produced before the domain was reached — the request itself was unreadable. */
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
 * THE EMPTY-STRING GUARD IS LOAD-BEARING: `Number('')` is `0`, not `NaN`, so an empty header would parse as
 * a perfectly valid "wait zero seconds" — telling a rate-limited founder to hammer the endpoint. Copied
 * deliberately from `create-outcome.ts:76-82`, where a failing test put it there.
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

/** The domain's envelope, or null when the 400 was the route's string form. Keeps the two 400s apart. */
function readEnvelope(body: string): { code: string; message: string } | null {
  const e = readJson(body)?.['error'];
  if (typeof e !== 'object' || e === null) return null;
  const o = e as Record<string, unknown>;
  const message = typeof o['message'] === 'string' ? o['message'] : '';
  const code = typeof o['code'] === 'string' ? o['code'] : '';
  return message === '' ? null : { code, message };
}

/** A 200 body is only usable if it really is the answer envelope; anything else is an error, not a save. */
function readAnswer(body: string): { answer: AnswerDTO; created: boolean } | null {
  const o = readJson(body);
  if (o === null) return null;
  const a = o['answer'];
  if (typeof a !== 'object' || a === null) return null;
  const r = a as Record<string, unknown>;
  const status = r['status'];
  const content = r['content'];
  const looksRight =
    typeof r['questionId'] === 'string' &&
    typeof r['revision'] === 'number' &&
    (status === 'answered' || status === 'skipped') &&
    (typeof content === 'string' || content === null) &&
    typeof r['createdAt'] === 'string' &&
    typeof o['created'] === 'boolean';
  return looksRight ? { answer: a as unknown as AnswerDTO, created: o['created'] as boolean } : null;
}

export function interpretAnswerResponse(status: number, body: string, retryAfterHeader: string | null, submitted: AnswerSubmission): AnswerOutcome {
  if (status === 200) {
    const read = readAnswer(body);
    if (read === null) {
      return { kind: 'error', detail: 'The server accepted the request but returned a reply this screen could not read. Reload the interview to see what is actually stored before answering again.' };
    }
    if (read.created) {
      return { kind: 'saved', answer: read.answer, detail: 'Saved.' };
    }
    // created === false — the fork that decides whether the founder's text survived. See the header.
    if (isSameAnswer(read.answer, submitted)) {
      return { kind: 'unchanged', answer: read.answer, detail: 'That is already what the server has stored for this question, so nothing was changed.' };
    }
    return {
      kind: 'overwritten_by_other',
      answer: read.answer,
      storedContent: read.answer.content,
      detail: 'Your answer was NOT saved. The server reports a different answer stored against this question, which happens when several submissions land at once and the server stops retrying. What it currently holds is shown below — resubmit if it should be replaced.',
    };
  }

  const code = errorCode(body);

  switch (status) {
    case 400: {
      const envelope = readEnvelope(body);
      if (envelope !== null) {
        return {
          kind: 'invalid',
          code: envelope.code,
          // VERBATIM. The server names which of four things is wrong; paraphrasing discards the only precise
          // information in the response.
          serverMessage: envelope.message,
          detail: 'The server judged this answer and reports the first problem it found.',
        };
      }
      return { kind: 'malformed', detail: 'The server could not read what this screen sent, so nothing was saved. That is a fault in this screen rather than in anything you typed.' };
    }
    case 401:
      return { kind: 'signed_out', detail: 'Your session is not active, so nothing was saved. Sign in and submit again — the text is still here.' };
    case 403:
      return code === 'email_unverified'
        ? { kind: 'email_unverified', detail: 'Your email address is not verified, so nothing was saved. The platform requires a verified primary address before it accepts this. Verify it on your account, then submit again.' }
        : {
            kind: 'forbidden',
            // NAMES NO SINGLE CAUSE. One opaque 403 covers non-membership, a denied role, an unknown or
            // foreign company, and the same-origin gate — with no discriminator in the body.
            detail: 'The server refused this and nothing was saved. Several different situations produce an identical refusal here, and the response does not say which one applied.',
          };
    case 404:
      // Also without a discriminator: no open session, an unknown or foreign question, a question belonging
      // to another session, or no internal user record behind this sign-in.
      return { kind: 'not_found', detail: 'The server found nothing to answer at that address and saved nothing. That covers several situations — among them an interview that is no longer open and a question that is not part of it — and the response does not say which applied. Reload the interview to see its current state.' };
    case 413:
      // NOT the founder's fault. The 16 KiB body cap is enforced before any parse, while the domain limit is
      // 10,000 CHARACTERS — and 10,000 characters of two-byte text exceeds the byte cap, so an answer this
      // screen accepted can still be refused here.
      return { kind: 'too_large', detail: 'The server refused the request as too large and saved nothing. The size limit it applies is measured in bytes rather than characters, so text in a non-Latin script can exceed it well before the character count this screen shows. Shortening the answer will get past it, but the mismatch is a fault in this screen.' };
    case 415:
      return { kind: 'malformed_media', detail: 'The server refused the content type this screen sent, so nothing was saved. That is a fault in this screen rather than in anything you typed.' };
    case 429:
      return { kind: 'rate_limited', detail: 'A request ceiling refused this and nothing was saved.', retryAfterSeconds: parseRetryAfter(retryAfterHeader) };
    case 503:
      return { kind: 'unavailable', detail: 'Something this depends on is down, so nothing was saved. Nothing is wrong with your account, and retrying is safe.' };
    default:
      // 500 and anything unlisted — including a 409, which this route cannot produce (see the header).
      return { kind: 'error', detail: `The server answered with a status this screen does not handle: ${String(status)}. Nothing has been assumed about whether the answer was saved — reload the interview to see what is stored.` };
  }
}
