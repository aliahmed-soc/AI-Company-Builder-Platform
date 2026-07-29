// ACBP-P5-012 — the revision request's rules, made executable (CDR-064; TASK-005 lineage; J-13; ADR-016).
//
// Pure: no clock, no database, no storage. What has to be right here is that a revision cannot be requested without
// saying what to change, and that the guidance is bounded before it reaches a durable row.
import { describe, test, expect } from 'vitest';
import { REVISION_GUIDANCE_MAX, validateRevisionGuidance, validateRevisionKey, REVISION_REFUSALS } from './revision.js';

describe('validateRevisionGuidance — a revision must say what to change', () => {
  test('accepts real guidance, and returns it TRIMMED', () => {
    // Trimmed at the contract, not at the call site: the trimmed value is what gets stored and what the uniqueness
    // and comparison semantics apply to, so exactly one place may decide what the guidance IS.
    expect(validateRevisionGuidance('  Shorten the summary to one page.  ')).toEqual({ ok: true, guidance: 'Shorten the summary to one page.' });
  });

  test('BLANK guidance is refused — a revision with nothing to change is a re-run wearing a revision\'s name', () => {
    // The worker would have nothing to do differently, so the founder would be charged a credit for the same output.
    for (const blank of ['', '   ', '\t\n  ']) {
      expect(validateRevisionGuidance(blank)).toEqual({ ok: false, reason: 'guidance_required' });
    }
  });

  test('a MISSING or non-string guidance is refused as required, not coerced', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(validateRevisionGuidance(bad)).toEqual({ ok: false, reason: 'guidance_required' });
    }
  });

  test('guidance is BOUNDED, and the bound is measured AFTER trimming', () => {
    // Unbounded caller prose in a durable row is a storage and a log hazard. Measuring after the trim means trailing
    // whitespace cannot push an otherwise-valid request over the edge.
    const atLimit = 'x'.repeat(REVISION_GUIDANCE_MAX);
    expect(validateRevisionGuidance(atLimit)).toEqual({ ok: true, guidance: atLimit });
    expect(validateRevisionGuidance(`  ${atLimit}  `)).toEqual({ ok: true, guidance: atLimit });
    expect(validateRevisionGuidance('x'.repeat(REVISION_GUIDANCE_MAX + 1))).toEqual({ ok: false, reason: 'guidance_too_long' });
  });

  test('the bound counts CHARACTERS the founder typed, not UTF-8 bytes', () => {
    // A column limit in bytes would refuse a shorter piece of Arabic or emoji prose than of English, which is a
    // silent penalty on non-Latin scripts rather than a real limit.
    const wide = '\u{1F600}'.repeat(REVISION_GUIDANCE_MAX);
    expect(validateRevisionGuidance(wide)).toEqual({ ok: true, guidance: wide });
  });
});

describe('validateRevisionKey — idempotency is per REQUEST (CDR-064 G3)', () => {
  test('accepts a real key, trimmed', () => {
    expect(validateRevisionKey('  rev-1  ')).toEqual({ ok: true, key: 'rev-1' });
  });

  test('a BLANK key is refused, never treated as a key', () => {
    // The P5-003b lesson, repeated in P5-014: an empty string treated as a real key makes unrelated calls collide,
    // which for a metered operation means one founder's revision silently answering another's request.
    for (const blank of ['', '   ', undefined, null, 7]) {
      expect(validateRevisionKey(blank)).toEqual({ ok: false, reason: 'key_required' });
    }
  });
});

describe('the refusal taxonomy is CLOSED', () => {
  test('every refusal a validator can return is a member of REVISION_REFUSALS', () => {
    // A refusal outside the set would reach a caller that cannot branch on it. Asserted as set equality rather than
    // containment, so an added reason must be admitted here on purpose.
    const produced = new Set<string>();
    for (const bad of ['', 'x'.repeat(REVISION_GUIDANCE_MAX + 1)]) {
      const r = validateRevisionGuidance(bad);
      if (!r.ok) produced.add(r.reason);
    }
    const k = validateRevisionKey('');
    if (!k.ok) produced.add(k.reason);
    expect([...produced].sort()).toEqual([...REVISION_REFUSALS].sort());
  });
});
