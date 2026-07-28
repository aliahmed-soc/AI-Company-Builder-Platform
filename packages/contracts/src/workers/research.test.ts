// ACBP-P5-006 — WORK-002 made unrepresentable to violate (CDR-061 §1).
//
// The dangerous research output is not a claim that is WRONG. It is a claim that is plausible and sourced to
// something that does not exist, because a founder cannot tell it from a real one — and a model asked for citations
// while lacking sources will produce citation-SHAPED strings. These tests are about making that unstorable.
import { describe, test, expect } from 'vitest';
import { RESEARCH_TASK_TYPES, isResearchTaskType, parseResearchOutput, validateResearchDocument, MAX_RESEARCH_CLAIMS } from './research.js';

const SOURCE = { url: 'https://example.com/report', title: 'Market report 2026', retrievedAt: '2026-07-28T10:00:00.000Z' };
const RETRIEVED = ['https://example.com/report', 'https://example.com/other'];

const sourced = (over: Record<string, unknown> = {}) => ({ statement: 'The market grew 12% in 2025.', sources: [SOURCE], ...over });
const unverified = (over: Record<string, unknown> = {}) => ({ statement: 'Adoption is accelerating.', unverifiedReason: 'No public data source covers this segment.', ...over });

const doc = (claims: unknown[], over: Record<string, unknown> = {}) => ({ title: 'Market research', summary: 'What we found.', claims, ...over });

describe('the three task types canon names', () => {
  test('are exactly market research, competitor research and customer-segment analysis', () => {
    expect([...RESEARCH_TASK_TYPES]).toEqual(['market_research', 'competitor_research', 'customer_segment_analysis']);
    for (const t of RESEARCH_TASK_TYPES) expect(isResearchTaskType(t)).toBe(true);
    for (const bad of ['seo_audit', 'MARKET_RESEARCH', '', null, 3]) expect(isResearchTaskType(bad)).toBe(false);
  });
});

describe('G1 — a claim is sourced or explicitly unverified, and there is no third shape', () => {
  test('a sourced claim is accepted', () => {
    expect(parseResearchOutput(doc([sourced()]), RETRIEVED)).toMatchObject({ ok: true });
  });

  test('an explicitly unverified claim is accepted — admitting ignorance is a first-class outcome (G4)', () => {
    expect(parseResearchOutput(doc([unverified()]), RETRIEVED)).toMatchObject({ ok: true });
  });

  test('an EMPTY source list is a REFUSAL, not a synonym for unverified', () => {
    // The single most likely way WORK-002 dies: a model returns `sources: []` for a claim it could not support, and
    // a lenient reader treats the absence as "unverified". An absent source is a missing one, not a declared one.
    expect(parseResearchOutput(doc([sourced({ sources: [] })]), RETRIEVED)).toMatchObject({ ok: false, reason: 'unsupported_claim' });
  });

  test('a claim with NEITHER sources nor an unverified reason is refused', () => {
    expect(parseResearchOutput(doc([{ statement: 'Something is true.' }]), RETRIEVED)).toMatchObject({ ok: false, reason: 'unsupported_claim' });
  });

  test('a BLANK unverified reason is not an admission — it is a missing one', () => {
    for (const blank of ['', '   ', '\t']) {
      expect(parseResearchOutput(doc([unverified({ unverifiedReason: blank })]), RETRIEVED)).toMatchObject({ ok: false, reason: 'unsupported_claim' });
    }
  });

  test('a blank statement is refused — an empty claim is not a claim', () => {
    expect(parseResearchOutput(doc([sourced({ statement: '  ' })]), RETRIEVED)).toMatchObject({ ok: false, reason: 'blank_statement' });
  });
});

describe('G2 — a source must actually be a source, not citation-shaped text', () => {
  test('the url must be a real http(s) url', () => {
    for (const bad of ['not-a-url', 'example.com/report', 'ftp://example.com/x', 'javascript:alert(1)', '', null]) {
      expect(parseResearchOutput(doc([sourced({ sources: [{ ...SOURCE, url: bad }] })]), [...RETRIEVED, bad as string])).toMatchObject({ ok: false, reason: 'invalid_source' });
    }
  });

  test('a blank title is refused — "Source: [1]" is what an unsourced model produces', () => {
    expect(parseResearchOutput(doc([sourced({ sources: [{ ...SOURCE, title: '   ' }] })]), RETRIEVED)).toMatchObject({ ok: false, reason: 'invalid_source' });
  });

  test('retrievedAt must be a real timestamp — a citation with no retrieval time cannot be re-checked', () => {
    for (const bad of ['', 'yesterday', '2026-13-45', null, 12345]) {
      expect(parseResearchOutput(doc([sourced({ sources: [{ ...SOURCE, retrievedAt: bad }] })]), RETRIEVED)).toMatchObject({ ok: false, reason: 'invalid_source' });
    }
  });
});

describe('G6 — a source must be something the worker ACTUALLY RETRIEVED', () => {
  test('a url that was never fetched is refused, however well-formed it looks', () => {
    // THE CENTRAL DEFENCE. A perfectly-formed URL to a real-looking report that the worker never fetched is exactly
    // what an invented citation looks like, and it is also what injected content asks the model to cite. Shape
    // validation alone accepts it; only comparing against what was really retrieved rejects it.
    const invented = { url: 'https://plausible-analysts.example/2026-outlook', title: 'Industry Outlook 2026', retrievedAt: SOURCE.retrievedAt };
    expect(parseResearchOutput(doc([sourced({ sources: [invented] })]), RETRIEVED)).toMatchObject({ ok: false, reason: 'unretrieved_source' });
  });

  test('a claim citing one retrieved and one invented source is still refused — every source is checked', () => {
    const invented = { url: 'https://plausible-analysts.example/x', title: 'X', retrievedAt: SOURCE.retrievedAt };
    expect(parseResearchOutput(doc([sourced({ sources: [SOURCE, invented] })]), RETRIEVED)).toMatchObject({ ok: false, reason: 'unretrieved_source' });
  });

  test('with NOTHING retrieved, every sourced claim is refused and only unverified claims can pass', () => {
    // The "source unavailable" case from the backlog's failure column, stated exactly: the honest output of a run
    // that fetched nothing is a document of unverified claims, never a document of invented ones.
    expect(parseResearchOutput(doc([sourced()]), [])).toMatchObject({ ok: false, reason: 'unretrieved_source' });
    expect(parseResearchOutput(doc([unverified()]), [])).toMatchObject({ ok: true });
  });
});

describe('G3 — one bad claim fails the WHOLE document', () => {
  test('a document mixing good claims with one invented citation is refused entirely', () => {
    // Not 90% useful. The valid claims now carry the invented one's credibility, which is worse than useless.
    const invented = { url: 'https://plausible-analysts.example/x', title: 'X', retrievedAt: SOURCE.retrievedAt };
    const result = parseResearchOutput(doc([sourced(), unverified(), sourced({ sources: [invented] })]), RETRIEVED);
    expect(result).toMatchObject({ ok: false, reason: 'unretrieved_source' });
    expect(result.ok === false && result.claimIndex).toBe(2);
  });
});

describe('the document itself', () => {
  test('needs a title, a summary and at least one claim', () => {
    expect(parseResearchOutput(doc([]), RETRIEVED)).toMatchObject({ ok: false, reason: 'no_claims' });
    expect(parseResearchOutput(doc([sourced()], { title: '  ' }), RETRIEVED)).toMatchObject({ ok: false, reason: 'invalid_document' });
    expect(parseResearchOutput(doc([sourced()], { summary: '' }), RETRIEVED)).toMatchObject({ ok: false, reason: 'invalid_document' });
  });

  test('malformed output is refused rather than partially accepted', () => {
    for (const bad of [undefined, null, {}, 'a document', 7, { claims: 'many' }]) {
      expect(parseResearchOutput(bad, RETRIEVED)).toMatchObject({ ok: false });
    }
  });

  test('the claim count is bounded at its exact limit', () => {
    const many = Array.from({ length: MAX_RESEARCH_CLAIMS }, () => sourced());
    expect(parseResearchOutput(doc(many), RETRIEVED)).toMatchObject({ ok: true });
    expect(parseResearchOutput(doc([...many, sourced()]), RETRIEVED)).toMatchObject({ ok: false, reason: 'too_many_claims' });
  });
});

describe('validateResearchDocument — the same rules applied to an already-parsed document', () => {
  test('accepts a document whose every claim is sourced-or-declared, and reports the split', () => {
    const parsed = parseResearchOutput(doc([sourced(), unverified()]), RETRIEVED);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(validateResearchDocument(parsed.document, RETRIEVED)).toEqual({ ok: true, sourcedClaims: 1, unverifiedClaims: 1 });
  });

  test('is the SAME gate as the parser — a document that was legal at parse time cannot become legal by a later edit', () => {
    // Re-validated at use, not only at construction: the P0-005 key-derivation precedent. A document that reached a
    // caller from a row or a retry payload gets checked again against what that run actually retrieved.
    const parsed = parseResearchOutput(doc([sourced()]), RETRIEVED);
    if (!parsed.ok) throw new Error('setup');
    expect(validateResearchDocument(parsed.document, [])).toMatchObject({ ok: false, reason: 'unretrieved_source' });
  });
});
