// @acbp/contracts — understanding-generation contracts (ACBP-P2-008; CDR-029; UNDER-001/005). Pure. Pins the
// closed 6-class set, the deny-by-default output parse, per-section confidence + status (present/assumed/unknown
// via the 0.5 threshold), and the weakest-section overall confidence.
import { describe, test, expect } from 'vitest';
import {
  UNDERSTANDING_CLASSES,
  SECTION_STATUSES,
  DOCUMENT_STATUSES,
  UNDERSTANDING_SCHEMA,
  SECTION_CONFIDENCE_THRESHOLD,
  isUnderstandingClass,
  parseUnderstanding,
  computeSections,
  overallConfidence,
} from './index.js';

describe('understanding vocabulary (CDR-029)', () => {
  test('the closed 6-class set + statuses + threshold', () => {
    expect(UNDERSTANDING_CLASSES).toEqual(['fact', 'preference', 'constraint', 'assumption', 'research_finding', 'open_question']);
    for (const c of UNDERSTANDING_CLASSES) expect(isUnderstandingClass(c)).toBe(true);
    for (const bad of ['user_fact', 'opinion', '', 42, null]) expect(isUnderstandingClass(bad)).toBe(false);
    expect(SECTION_STATUSES).toEqual(['present', 'assumed', 'unknown']);
    expect(DOCUMENT_STATUSES).toEqual(['complete', 'partial']);
    expect(SECTION_CONFIDENCE_THRESHOLD).toBe(0.5);
    expect(typeof UNDERSTANDING_SCHEMA).toBe('string');
  });
});

describe('parseUnderstanding — deny-by-default', () => {
  test('accepts a well-formed item list', () => {
    const r = parseUnderstanding('{"items":[{"class":"fact","content":"Sells coffee.","confidence":0.9},{"class":"open_question","content":"Pricing model?","confidence":0.2}]}');
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.items).toHaveLength(2);
    expect(r.ok && r.value.items[0]!.class).toBe('fact');
  });
  test('accepts an empty item list (a document with no derived items is valid — all sections unknown)', () => {
    const r = parseUnderstanding('{"items":[]}');
    expect(r.ok && r.value.items).toEqual([]);
  });
  test('rejects bad class, out-of-range confidence, blank/over-long content, non-array, malformed JSON', () => {
    expect(parseUnderstanding('{"items":[{"class":"user_fact","content":"x","confidence":0.5}]}').ok).toBe(false);
    expect(parseUnderstanding('{"items":[{"class":"fact","content":"x","confidence":1.5}]}').ok).toBe(false);
    expect(parseUnderstanding('{"items":[{"class":"fact","content":"x","confidence":-0.1}]}').ok).toBe(false);
    expect(parseUnderstanding('{"items":[{"class":"fact","content":"","confidence":0.5}]}').ok).toBe(false);
    expect(parseUnderstanding('{"items":[{"class":"fact","content":"   ","confidence":0.5}]}').ok).toBe(false);
    expect(parseUnderstanding(JSON.stringify({ items: [{ class: 'fact', content: 'x'.repeat(20000), confidence: 0.5 }] })).ok).toBe(false);
    expect(parseUnderstanding('{"items":"nope"}').ok).toBe(false);
    expect(parseUnderstanding('not json').ok).toBe(false);
    expect(parseUnderstanding('{"items":[{"class":"fact","confidence":0.5}]}').ok).toBe(false); // missing content
  });
});

describe('computeSections + overallConfidence (UNDER-005 weakest-section)', () => {
  const items = [
    { class: 'fact' as const, content: 'a', confidence: 0.9 },
    { class: 'fact' as const, content: 'b', confidence: 0.7 }, // fact mean 0.8 → present
    { class: 'assumption' as const, content: 'c', confidence: 0.3 }, // assumption mean 0.3 → assumed
    // constraint/preference/research_finding/open_question empty → unknown
  ];
  test('per-section confidence (mean) + status via the 0.5 threshold', () => {
    const secs = computeSections(items);
    const byClass = Object.fromEntries(secs.map((s) => [s.class, s]));
    expect(byClass['fact']!.count).toBe(2);
    expect(byClass['fact']!.confidence).toBeCloseTo(0.8);
    expect(byClass['fact']!.status).toBe('present');
    expect(byClass['assumption']!.status).toBe('assumed'); // has an item but < 0.5
    expect(byClass['constraint']!.status).toBe('unknown');
    expect(byClass['constraint']!.confidence).toBe(0);
    // Every class has exactly one section.
    expect(secs.map((s) => s.class).sort()).toEqual([...UNDERSTANDING_CLASSES].sort());
  });
  test('overall confidence = the WEAKEST covered (non-unknown) section', () => {
    // covered sections: fact 0.8, assumption 0.3 → min 0.3.
    expect(overallConfidence(computeSections(items))).toBeCloseTo(0.3);
  });
  test('all-unknown document → overall confidence 0', () => {
    expect(overallConfidence(computeSections([]))).toBe(0);
  });
});
