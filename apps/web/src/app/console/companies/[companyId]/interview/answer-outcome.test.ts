/*
 * ACBP-FE-007 — every arm the answer POST can hand back, including the one that looks like success.
 *
 * The 200 arms carry the most risk here. `created: false` has TWO causes and only one of them means the
 * founder's text is stored; the other means it was DROPPED and the screen is now showing someone else's
 * answer. A test suite that only checks status codes would pass on a screen that silently loses answers.
 */
import { describe, expect, it } from 'vitest';
import type { AnswerSubmission } from '@acbp/contracts';
import { interpretAnswerResponse } from './answer-outcome';

const ANSWERED: AnswerSubmission = { status: 'answered', content: 'We sell to independent clinics.' };
const SKIPPED: AnswerSubmission = { status: 'skipped', content: null };

function answerBody(over: { status?: 'answered' | 'skipped'; content?: string | null; revision?: number; created: boolean }): string {
  return JSON.stringify({
    answer: {
      questionId: 'q_1',
      revision: over.revision ?? 1,
      status: over.status ?? 'answered',
      content: 'content' in over ? over.content : 'We sell to independent clinics.',
      createdAt: '2026-08-17T00:00:00.000Z',
    },
    created: over.created,
  });
}

function envelope(message: string): string {
  return JSON.stringify({ error: { category: 'validation', code: 'VALIDATION_FAILED', message, retryable: false } });
}

describe('interpretAnswerResponse — the three different things a 200 can mean', () => {
  it('reports a genuinely new answer as saved', () => {
    const out = interpretAnswerResponse(200, answerBody({ created: true }), null, ANSWERED);
    expect(out.kind).toBe('saved');
  });

  it('reports an identical re-submission as unchanged, not as a new save', () => {
    const out = interpretAnswerResponse(200, answerBody({ created: false }), null, ANSWERED);
    expect(out.kind).toBe('unchanged');
  });

  it('reports a re-skipped skip as unchanged', () => {
    const out = interpretAnswerResponse(200, answerBody({ created: false, status: 'skipped', content: null }), null, SKIPPED);
    expect(out.kind).toBe('unchanged');
  });

  it('DETECTS THAT THE ANSWER WAS DROPPED when created is false but the stored content differs', () => {
    // After MAX_APPEND_ATTEMPTS revision collisions the server stops retrying and truthfully returns whatever
    // the current answer now is — possibly another writer's — also with `created: false`. Reading every
    // `created: false` as "saved, no change" is how a founder's answer disappears with a success message.
    const out = interpretAnswerResponse(200, answerBody({ created: false, content: 'Something another writer stored.' }), null, ANSWERED);
    expect(out.kind).toBe('overwritten_by_other');
  });

  it('detects the drop when the STATUS differs, not only the content', () => {
    const out = interpretAnswerResponse(200, answerBody({ created: false, status: 'skipped', content: null }), null, ANSWERED);
    expect(out.kind).toBe('overwritten_by_other');
  });

  it('surfaces what is actually stored now, so the founder can see what replaced their answer', () => {
    const out = interpretAnswerResponse(200, answerBody({ created: false, content: 'Another writer.' }), null, ANSWERED);
    expect(out.kind === 'overwritten_by_other' && out.storedContent).toBe('Another writer.');
  });

  it('treats a 200 whose body cannot be read as an error rather than a save', () => {
    const out = interpretAnswerResponse(200, 'not json', null, ANSWERED);
    expect(out.kind).toBe('error');
  });

  it('treats a 200 missing the answer envelope as an error rather than a save', () => {
    const out = interpretAnswerResponse(200, JSON.stringify({ created: true }), null, ANSWERED);
    expect(out.kind).toBe('error');
  });
});

describe('interpretAnswerResponse — the two 400s are different events', () => {
  it.each([
    'Answer status is invalid.',
    'A skipped answer carries no content.',
    'An answer requires non-empty content.',
    'Answer content is too long.',
  ])('carries the server sentence %j through verbatim', (message) => {
    // The server has already named which of four things is wrong. Substituting "please check your answer"
    // throws away the only precise information in the response — the exact defect FE-005 shipped and whose
    // unit tests passed because they asserted the same wrong shape.
    const out = interpretAnswerResponse(400, envelope(message), null, ANSWERED);
    expect(out.kind).toBe('invalid');
    expect(out.kind === 'invalid' && out.serverMessage).toBe(message);
  });

  it('reads a route-level 400 as a fault in this screen, not as a judgement on the answer', () => {
    const out = interpretAnswerResponse(400, JSON.stringify({ error: 'bad_request' }), null, ANSWERED);
    expect(out.kind).toBe('malformed');
  });

  it('does not mistake the string 400 for the envelope 400', () => {
    const routeLevel = interpretAnswerResponse(400, JSON.stringify({ error: 'bad_request' }), null, ANSWERED);
    const domain = interpretAnswerResponse(400, envelope('Answer content is too long.'), null, ANSWERED);
    expect(routeLevel.kind).not.toBe(domain.kind);
  });
});

describe('interpretAnswerResponse — refusals that must not collapse into each other', () => {
  it('separates an unverified email from a plain refusal, though both are 403', () => {
    const forbidden = interpretAnswerResponse(403, JSON.stringify({ error: 'forbidden' }), null, ANSWERED);
    const unverified = interpretAnswerResponse(403, JSON.stringify({ error: 'email_unverified' }), null, ANSWERED);
    expect(forbidden.kind).toBe('forbidden');
    expect(unverified.kind).toBe('email_unverified');
  });

  it('names no single cause for a plain 403, because the body carries no discriminator', () => {
    // One opaque 403 covers non-membership, a denied role, an unknown or foreign company, AND the
    // same-origin gate. Picking one would hand a founder a guess dressed as a diagnosis.
    const out = interpretAnswerResponse(403, JSON.stringify({ error: 'forbidden' }), null, ANSWERED);
    expect(out.detail.toLowerCase()).toContain('does not say which');
  });

  it('says a 404 did not distinguish its several causes', () => {
    const out = interpretAnswerResponse(404, JSON.stringify({ error: 'not_found' }), null, ANSWERED);
    expect(out.kind).toBe('not_found');
  });

  it.each([
    [401, 'signed_out'],
    [413, 'too_large'],
    [415, 'malformed_media'],
    [503, 'unavailable'],
    [500, 'error'],
  ])('maps %i to %s', (status, kind) => {
    const out = interpretAnswerResponse(status, JSON.stringify({ error: 'x' }), null, ANSWERED);
    expect(out.kind).toBe(kind);
  });

  it('does not blame the founder for a 413, because the byte cap and the character limit disagree', () => {
    // 10,000 characters is domain-legal, but the 16 KiB body cap is enforced first and 10,000 characters of
    // two-byte UTF-8 exceeds it. An Arabic-writing founder can be refused for text this screen accepted.
    const out = interpretAnswerResponse(413, JSON.stringify({ error: 'payload_too_large' }), null, ANSWERED);
    expect(out.detail.toLowerCase()).toContain('this screen');
  });

  it('has NO 409 arm, because the answer route cannot produce one', () => {
    // RecordAnswerResult is exactly ok | forbidden | not_found | validation. A `case 409` here would be a
    // branch for something the server never sends — a claim no test could falsify.
    const out = interpretAnswerResponse(409, JSON.stringify({ error: 'conflict' }), null, ANSWERED);
    expect(out.kind).toBe('error');
    expect(out.detail).toContain('409');
  });
});

describe('interpretAnswerResponse — Retry-After', () => {
  it('reads a real Retry-After', () => {
    const out = interpretAnswerResponse(429, JSON.stringify({ error: 'rate_limited' }), '31', ANSWERED);
    expect(out.kind === 'rate_limited' && out.retryAfterSeconds).toBe(31);
  });

  it('treats an EMPTY Retry-After as absent rather than as zero seconds', () => {
    // `Number('')` is 0, so an unguarded parse tells a rate-limited founder to retry immediately — advice
    // that is both wrong and the worst possible response to a ceiling.
    const out = interpretAnswerResponse(429, JSON.stringify({ error: 'rate_limited' }), '', ANSWERED);
    expect(out.kind === 'rate_limited' && out.retryAfterSeconds).toBeNull();
  });

  it('treats a non-numeric Retry-After as absent', () => {
    const out = interpretAnswerResponse(429, JSON.stringify({ error: 'rate_limited' }), 'soon', ANSWERED);
    expect(out.kind === 'rate_limited' && out.retryAfterSeconds).toBeNull();
  });
});
