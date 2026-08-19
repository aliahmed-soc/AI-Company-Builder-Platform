/*
 * ACBP-FE-008 — the adaptive-interview replies.
 *
 * The cases that matter are the ones where a plausible shortcut produces a screen that lies: reading the three
 * verdicts into one optional-everything object, treating "nothing to assume" as a failure, treating a paid
 * refusal as though it might have charged, and — the row's explicit exclusion — scoring an answer here.
 */
import { describe, expect, test } from 'vitest';
import { interpretEvaluateResponse, interpretAssumptionResponse } from './verdict-outcome.js';

const ok = (payload: unknown) => JSON.stringify(payload);
const err = (code: string) => JSON.stringify({ error: code });

describe('the verdict comes from the server, and only from the server', () => {
  test('a clear verdict is accepted and names the stored item', () => {
    const r = interpretEvaluateResponse(200, ok({ verdict: 'clear', memoryItemId: 'mem_1' }), null);
    expect(r.kind).toBe('clear');
    if (r.kind === 'clear') expect(r.memoryItemId).toBe('mem_1');
  });

  test('a vague verdict becomes a RE-ASK that is labelled as one, carrying the server question verbatim', () => {
    const r = interpretEvaluateResponse(200, ok({ verdict: 'vague', clarification: 'Which region do you sell into?' }), null);
    expect(r.kind).toBe('reask');
    if (r.kind !== 'reask') return;
    expect(r.label).toBe('The server is asking again');
    // VERBATIM. Paraphrasing discards the only specific information in the reply.
    expect(r.clarification).toBe('Which region do you sell into?');
    expect(r.detail).toContain('not been stored');
  });

  test('a contradictory verdict is its own outcome, not folded into the re-ask', () => {
    // Both are "answer not stored, ask again", but the REASON differs and a founder needs it: one asks for
    // detail, the other says this disagrees with something they already told the platform.
    const r = interpretEvaluateResponse(200, ok({ verdict: 'contradictory', conflict: 'Earlier you said retail.' }), null);
    expect(r.kind).toBe('contradiction');
    if (r.kind === 'contradiction') expect(r.conflict).toBe('Earlier you said retail.');
  });

  test('A LONG VAGUE-LOOKING ANSWER IS NOT SCORED HERE — a clear verdict stays clear', () => {
    // The row's explicit exclusion is "no client-side answer scoring". Nothing in this module inspects text.
    const r = interpretEvaluateResponse(200, ok({ verdict: 'clear', memoryItemId: 'mem_1' }), null);
    expect(r.kind).toBe('clear');
  });

  test('an unknown verdict is an error, never a guess at which of the three it meant', () => {
    expect(interpretEvaluateResponse(200, ok({ verdict: 'maybe', clarification: 'hm' }), null).kind).toBe('error');
  });
});

describe('each verdict is read by its OWN required field', () => {
  test('a clear verdict missing memoryItemId is unreadable, not a success', () => {
    expect(interpretEvaluateResponse(200, ok({ verdict: 'clear' }), null).kind).toBe('error');
  });

  test('a vague verdict missing the clarification is unreadable — there is no re-ask to show', () => {
    expect(interpretEvaluateResponse(200, ok({ verdict: 'vague' }), null).kind).toBe('error');
  });

  test('a BLANK clarification is treated as absent — an empty string is not a question', () => {
    expect(interpretEvaluateResponse(200, ok({ verdict: 'vague', clarification: '   ' }), null).kind).toBe('error');
  });

  test("a clear verdict carrying another arm's field is still read as clear, and never sprouts a clarification", () => {
    // If this module read the arms into one optional-everything object, a stray field would surface as a
    // request to rephrase an answer the server ACCEPTED.
    const r = interpretEvaluateResponse(200, ok({ verdict: 'clear', memoryItemId: 'mem_1', clarification: 'ignore me' }), null);
    expect(r.kind).toBe('clear');
    expect(Object.keys(r)).not.toContain('clarification');
  });

  test('an unreadable body is an error rather than an optimistic accept', () => {
    expect(interpretEvaluateResponse(200, 'not json', null).kind).toBe('error');
  });
});

describe('the I-do-not-know path', () => {
  test('an assumption is labelled AS an assumption, in words', () => {
    const r = interpretAssumptionResponse(200, ok({ assumption: 'Buyers are independent cafes.', memoryItemId: 'mem_2' }), null);
    expect(r.kind).toBe('assumed');
    if (r.kind !== 'assumed') return;
    expect(r.assumption).toBe('Buyers are independent cafes.');
    // Readable text, not colour — the row's accessibility line. And it must say whose claim it is.
    expect(r.label).toBe('Assumed, not stated by you');
    expect(r.detail).toContain('rather than as something you told it');
  });

  test('assumption: null is a SUCCESS — "nothing assumed", not an error', () => {
    // The model declining to assume is an honest answer. Treating it as a failure would push toward filling
    // the gap with a guess, which is what the separate `ai_assumption` memory type exists to avoid.
    const r = interpretAssumptionResponse(200, ok({ assumption: null, memoryItemId: null }), null);
    expect(r.kind).toBe('nothing_assumed');
    if (r.kind !== 'nothing_assumed') return;
    expect(r.detail).toContain('rather than being filled with a guess');
  });

  test('a blank assumption string is treated the same as null, not shown as an empty chip', () => {
    expect(interpretAssumptionResponse(200, ok({ assumption: '   ' }), null).kind).toBe('nothing_assumed');
  });

  test('an assumption with no memoryItemId is still an assumption — the id is not what makes it one', () => {
    const r = interpretAssumptionResponse(200, ok({ assumption: 'Buyers are cafes.', memoryItemId: null }), null);
    expect(r.kind).toBe('assumed');
    if (r.kind === 'assumed') expect(r.memoryItemId).toBeNull();
  });

  test('a body with NO assumption key at all is unreadable, not "nothing assumed"', () => {
    // The distinction matters: "the model had nothing to assume" is a claim about the model. A reply this
    // screen could not parse is a claim about the reply, and must not be reported as the first.
    expect(interpretAssumptionResponse(200, ok({ memoryItemId: null }), null).kind).toBe('error');
  });
});

describe('both routes spend money, so their refusals say what was charged', () => {
  test('a 429 names the ceiling and says nothing was charged', () => {
    const r = interpretEvaluateResponse(429, err('rate_limited'), '30');
    expect(r.kind).toBe('rate_limited');
    if (r.kind !== 'rate_limited') return;
    expect(r.retryAfterSeconds).toBe(30);
    expect(r.detail).toContain('nothing was charged');
  });

  test('an EMPTY Retry-After yields null, never zero — zero would say "retry immediately" on a paid route', () => {
    // `Number('')` is 0, not NaN. Without the guard this tells a rate-limited founder to hammer a money route.
    const r = interpretEvaluateResponse(429, err('rate_limited'), '   ');
    expect(r.kind === 'rate_limited' && r.retryAfterSeconds).toBeNull();
  });

  test('a 503 says retrying is safe, because nothing was charged', () => {
    expect(interpretAssumptionResponse(503, err('unavailable'), null).detail).toContain('Nothing was charged');
  });

  test('the two 403s stay distinct, and the opaque one names no single cause', () => {
    expect(interpretEvaluateResponse(403, err('email_unverified'), null).kind).toBe('email_unverified');
    const forbidden = interpretEvaluateResponse(403, err('forbidden'), null);
    expect(forbidden.kind).toBe('forbidden');
    expect(forbidden.detail).toContain('deliberately does not say which');
  });

  test('a 400 carrying the domain envelope quotes the server verbatim; a bare 400 does not pretend to', () => {
    const judged = interpretEvaluateResponse(400, JSON.stringify({ error: { code: 'invalid', message: 'The answer is empty.' } }), null);
    expect(judged.kind).toBe('invalid');
    if (judged.kind === 'invalid') expect(judged.serverMessage).toBe('The answer is empty.');
    expect(interpretEvaluateResponse(400, err('bad_request'), null).kind).toBe('malformed');
  });

  test('an unhandled status is reported as unhandled rather than mapped to something plausible', () => {
    const r = interpretAssumptionResponse(418, '', null);
    expect(r.kind).toBe('error');
    expect(r.detail).toContain('418');
  });

  test('both routes map the shared statuses identically — one envelope, one reading', () => {
    for (const status of [401, 404, 413, 415, 503]) {
      expect(interpretEvaluateResponse(status, err('x'), null).kind).toBe(interpretAssumptionResponse(status, err('x'), null).kind);
    }
  });
});
