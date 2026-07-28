// ACBP-P5-006 / P5-007 / P5-008 — the worker gateway output validators (CDR-061, CDR-062, CDR-063).
//
// Written in review pass 2 of P5-007, which noticed that BOTH validators of the day had been added and neither
// exercised. Pass 2 of P5-008 then found the SAME thing again for `documentOutputValidator` — which is the lesson
// this repo keeps relearning: shipping the guard for one case does not generalize on its own. So this file is now
// the home for all three, and a fourth worker's validator belongs here on the day it is written.
//
// They are the seam the model gateway calls, they are pure, and they need no database — so unlike most of these
// tickets' tests they actually run on a laptop. An untested deny-by-default is just a claim about deny-by-default.
import { describe, test, expect } from 'vitest';
import { COMPARISON_SCHEMA, DOCUMENT_SCHEMA, RESEARCH_DOCUMENT_SCHEMA, STRATEGY_OPTION_FIELDS } from '@acbp/contracts';
import { comparisonOutputValidator } from './comparison-gateway.js';
import { documentOutputValidator } from './document-gateway.js';
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

const structuredDoc = JSON.stringify({
  documentType: 'business_plan_generation',
  title: 'Business plan',
  contextRefs: ['understanding:v3'],
  sections: [{ heading: 'Summary', body: 'Real content.' }],
});

describe('deny-by-default on the schema ref', () => {
  test('an UNKNOWN ref fails closed for every validator, even with output that would otherwise parse', () => {
    // The ref is the whole point of the dispatch: a validator that parsed anything handed to it would let one
    // worker's output satisfy another worker's contract.
    expect(comparisonOutputValidator('something.else@1', comparison)).toEqual({ ok: false });
    expect(researchOutputValidator('something.else@1', researchDoc)).toEqual({ ok: false });
    expect(documentOutputValidator('something.else@1', structuredDoc)).toEqual({ ok: false });
    expect(comparisonOutputValidator('', comparison)).toEqual({ ok: false });
    expect(documentOutputValidator('', structuredDoc)).toEqual({ ok: false });
  });

  test('each validator refuses the OTHER workers payloads under its own ref', () => {
    expect(comparisonOutputValidator(COMPARISON_SCHEMA, researchDoc)).toEqual({ ok: false });
    expect(comparisonOutputValidator(COMPARISON_SCHEMA, structuredDoc)).toEqual({ ok: false });
    expect(researchOutputValidator(RESEARCH_DOCUMENT_SCHEMA, comparison)).toEqual({ ok: false });
    expect(researchOutputValidator(RESEARCH_DOCUMENT_SCHEMA, structuredDoc)).toEqual({ ok: false });
    expect(documentOutputValidator(DOCUMENT_SCHEMA, comparison)).toEqual({ ok: false });
    expect(documentOutputValidator(DOCUMENT_SCHEMA, researchDoc)).toEqual({ ok: false });
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
    expect(documentOutputValidator(DOCUMENT_SCHEMA, '{"documentType":"business_plan_generation","title":"T","contextRefs":[],"sections":[]}')).toEqual({ ok: false });
  });

  test('malformed JSON fails closed for the document validator too', () => {
    for (const bad of ['', 'not json', '{']) expect(documentOutputValidator(DOCUMENT_SCHEMA, bad), bad).toEqual({ ok: false });
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
