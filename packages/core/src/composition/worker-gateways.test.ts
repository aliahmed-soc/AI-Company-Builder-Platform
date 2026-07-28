// ACBP-P5-006 / P5-007 — the worker gateway output validators (CDR-061, CDR-062).
//
// Written in review pass 2 of P5-007, which noticed that BOTH validators had been added and neither exercised. They
// are the seam the model gateway calls, they are pure, and they need no database — so unlike this ticket's other
// tests they actually run on a laptop. An untested deny-by-default is just a claim about deny-by-default.
import { describe, test, expect } from 'vitest';
import { COMPARISON_SCHEMA, RESEARCH_DOCUMENT_SCHEMA, STRATEGY_OPTION_FIELDS } from '@acbp/contracts';
import { comparisonOutputValidator } from './comparison-gateway.js';
import { researchOutputValidator } from './research-gateway.js';

const fields = (): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f}-value`;
  return o;
};
const comparison = JSON.stringify({ kind: 'comparison', models: [{ name: 'A', fields: fields() }, { name: 'B', fields: fields() }] });
const researchDoc = JSON.stringify({
  title: 'T',
  summary: 'S',
  claims: [{ statement: 'A claim.', sources: [{ url: 'https://example.com/x', title: 'X', retrievedAt: '2026-07-28T09:00:00.000Z' }] }],
});

describe('deny-by-default on the schema ref', () => {
  test('an UNKNOWN ref fails closed for both validators, even with output that would otherwise parse', () => {
    // The ref is the whole point of the dispatch: a validator that parsed anything handed to it would let one
    // worker's output satisfy another worker's contract.
    expect(comparisonOutputValidator('something.else@1', comparison)).toEqual({ ok: false });
    expect(researchOutputValidator('something.else@1', researchDoc)).toEqual({ ok: false });
    expect(comparisonOutputValidator('', comparison)).toEqual({ ok: false });
  });

  test('each validator refuses the OTHER worker s payload under its own ref', () => {
    expect(comparisonOutputValidator(COMPARISON_SCHEMA, researchDoc)).toEqual({ ok: false });
    expect(researchOutputValidator(RESEARCH_DOCUMENT_SCHEMA, comparison)).toEqual({ ok: false });
  });
});

describe('unparseable output is a refusal, never a partial acceptance', () => {
  test('malformed JSON fails closed rather than throwing', () => {
    for (const bad of ['', 'not json', '{', '{"kind":', 'undefined']) {
      expect(comparisonOutputValidator(COMPARISON_SCHEMA, bad), bad).toEqual({ ok: false });
      expect(researchOutputValidator(RESEARCH_DOCUMENT_SCHEMA, bad), bad).toEqual({ ok: false });
    }
  });

  test('valid JSON that is not the expected shape is refused', () => {
    expect(comparisonOutputValidator(COMPARISON_SCHEMA, '{"kind":"comparison","models":[]}')).toEqual({ ok: false });
    expect(researchOutputValidator(RESEARCH_DOCUMENT_SCHEMA, '{"title":"T"}')).toEqual({ ok: false });
  });
});

describe('the happy paths, and what each hands back', () => {
  test('the comparison validator returns the parsed OUTCOME', () => {
    const result = comparisonOutputValidator(COMPARISON_SCHEMA, comparison);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: 'comparison' });
  });

  test('the research validator returns a DRAFT — never a certified document', () => {
    // The load-bearing difference between the two. This hook cannot know what the run fetched, so what it produces
    // must still be uncertified; `certifyResearchDocument` is the only thing that mints a document.
    const result = researchOutputValidator(RESEARCH_DOCUMENT_SCHEMA, researchDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ title: 'T', summary: 'S' });
    // A source that was never retrieved sails through here — by design, and refused at certification.
    const invented = JSON.stringify({ title: 'T', summary: 'S', claims: [{ statement: 'x', sources: [{ url: 'https://never-fetched.example/y', title: 'Y', retrievedAt: '2026-07-28T09:00:00.000Z' }] }] });
    expect(researchOutputValidator(RESEARCH_DOCUMENT_SCHEMA, invented).ok).toBe(true);
  });
});
