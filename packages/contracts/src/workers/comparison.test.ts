// ACBP-P5-007 — "insufficient input = specific request" made unrepresentable to violate (CDR-062 §2; WORK-003).
//
// A strategy worker handed too little has three tempting ways out — pad, guess, or shrug — and all three are worse
// than useless to a founder. These tests are about making the first two unstorable and the third indistinguishable
// from a refusal.
import { describe, test, expect } from 'vitest';
import { STRATEGY_OPTION_FIELDS, UNKNOWN_FIELD } from '../strategy/strategy.js';
import { parseComparisonOutput, MIN_COMPARED_MODELS, MAX_COMPARED_MODELS, MAX_INPUT_REQUESTS } from './comparison.js';

/** A complete 16-field model. Built from the canonical list so a field added there cannot leave this stale. */
const fields = (over: Record<string, string> = {}): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f}-value`;
  return { ...o, ...over };
};
const model = (name: string, over: Record<string, unknown> = {}) => ({ name, fields: fields(), ...over });
const request = (over: Record<string, unknown> = {}) => ({ field: 'target customer', why: 'A comparison needs the customer each model serves.', example: 'e.g. "independent gym owners in the UK with 1-3 sites"', ...over });

const comparison = (models: unknown[]) => ({ kind: 'comparison', models });
const insufficient = (missing: unknown[]) => ({ kind: 'insufficient_input', missing });

describe('G1 — a comparison OR a request, never both and never neither', () => {
  test('a comparison of two complete models is accepted', () => {
    expect(parseComparisonOutput(comparison([model('Subscription'), model('Marketplace')]))).toMatchObject({ ok: true });
  });

  test('a specific request is accepted — asking is a first-class outcome, not a failure', () => {
    expect(parseComparisonOutput(insufficient([request()]))).toMatchObject({ ok: true });
  });

  test('an unknown, missing or malformed shape is refused — there is no default outcome', () => {
    for (const bad of [undefined, null, {}, { kind: 'both' }, { kind: 'comparison' }, { kind: 'insufficient_input' }, 'comparison', 7]) {
      expect(parseComparisonOutput(bad)).toMatchObject({ ok: false });
    }
  });
});

describe('G2 — a comparison compares', () => {
  test('one model is not a comparison', () => {
    // The padding failure in its smallest form: a worker that could only characterise one model must ASK, not
    // present that one model as though a comparison had happened.
    expect(parseComparisonOutput(comparison([model('Only one')]))).toMatchObject({ ok: false, reason: 'not_a_comparison' });
    expect(MIN_COMPARED_MODELS).toBe(2);
  });

  test('zero models is refused, not treated as an empty comparison', () => {
    expect(parseComparisonOutput(comparison([]))).toMatchObject({ ok: false, reason: 'not_a_comparison' });
  });

  test('the model count is bounded at its exact limit', () => {
    const many = Array.from({ length: MAX_COMPARED_MODELS }, (_, i) => model(`Model ${i}`));
    expect(parseComparisonOutput(comparison(many))).toMatchObject({ ok: true });
    expect(parseComparisonOutput(comparison([...many, model('One more')]))).toMatchObject({ ok: false, reason: 'too_many_models' });
  });

  test('two models with the SAME name are refused — two labels for one model is not a comparison either', () => {
    expect(parseComparisonOutput(comparison([model('Subscription'), model('Subscription')]))).toMatchObject({ ok: false, reason: 'duplicate_model' });
  });

  test('a blank model name is refused', () => {
    expect(parseComparisonOutput(comparison([model('  '), model('Marketplace')]))).toMatchObject({ ok: false, reason: 'invalid_model' });
  });
});

describe('G3 — every compared model meets STRAT-002 in full', () => {
  test('a model missing even one of the sixteen fields is refused', () => {
    for (const dropped of STRATEGY_OPTION_FIELDS) {
      const partial = fields();
      delete partial[dropped];
      expect(parseComparisonOutput(comparison([{ name: 'A', fields: partial }, model('B')])), `missing ${dropped}`).toMatchObject({ ok: false, reason: 'incomplete_fields' });
    }
  });

  test('an EXTRA field is refused too — the standard is exactly sixteen, not at least sixteen', () => {
    expect(parseComparisonOutput(comparison([{ name: 'A', fields: { ...fields(), invented: 'x' } }, model('B')]))).toMatchObject({ ok: false, reason: 'incomplete_fields' });
  });

  test('a blank field value is refused — an empty string is not an answer', () => {
    expect(parseComparisonOutput(comparison([{ name: 'A', fields: fields({ customer: '   ' }) }, model('B')]))).toMatchObject({ ok: false, reason: 'incomplete_fields' });
  });

  test('the ADR-019 `unknown` sentinel IS accepted — a labelled gap beats invented precision', () => {
    // The honest path has to stay open. If "unknown" were rejected the only way to pass would be to make something
    // up, which is the failure this standard exists to prevent.
    expect(parseComparisonOutput(comparison([{ name: 'A', fields: fields({ cost_range: UNKNOWN_FIELD }) }, model('B')]))).toMatchObject({ ok: true });
  });
});

describe('G4 — a request is SPECIFIC or it is refused', () => {
  test('every item needs what is missing, why it is needed, and what a usable answer looks like', () => {
    for (const part of ['field', 'why', 'example'] as const) {
      expect(parseComparisonOutput(insufficient([request({ [part]: '   ' })])), `blank ${part}`).toMatchObject({ ok: false, reason: 'vague_request' });
      expect(parseComparisonOutput(insufficient([request({ [part]: undefined })])), `missing ${part}`).toMatchObject({ ok: false, reason: 'vague_request' });
    }
  });

  test('an EMPTY request list is refused — "insufficient input" with nothing asked for is the shrug', () => {
    // This is the line the requirement lives on. A worker returning `insufficient_input` with no questions has
    // handed the problem back unchanged, which is exactly what "= specific request" forbids.
    expect(parseComparisonOutput(insufficient([]))).toMatchObject({ ok: false, reason: 'vague_request' });
  });

  test('the request list is bounded at its exact limit', () => {
    const many = Array.from({ length: MAX_INPUT_REQUESTS }, (_, i) => request({ field: `field ${i}` }));
    expect(parseComparisonOutput(insufficient(many))).toMatchObject({ ok: true });
    expect(parseComparisonOutput(insufficient([...many, request({ field: 'one more' })]))).toMatchObject({ ok: false, reason: 'too_many_requests' });
  });

  test('asking twice for the same thing is refused', () => {
    expect(parseComparisonOutput(insufficient([request(), request()]))).toMatchObject({ ok: false, reason: 'duplicate_request' });
  });
});
