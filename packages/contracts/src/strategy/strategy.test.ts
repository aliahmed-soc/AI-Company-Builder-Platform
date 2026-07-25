// ACBP-P3-001 / CDR-034 — strategy contract conformance: the closed 16-field standard, deny-by-default parsing, the
// ADR-019 no-fake-precision `"unknown"` sentinel, and the honest fewer-than-three status derivation.
import { describe, test, expect } from 'vitest';
import {
  STRATEGY_OPTION_FIELDS,
  UNKNOWN_FIELD,
  MIN_DISTINCT_OPTIONS,
  MAX_STRATEGY_OPTIONS,
  STRATEGY_FIELD_MAX,
  isCompleteOptionFields,
  isStrategyGenerationStatus,
  isSimilarityCheckResult,
  parseStrategyOptions,
  narrowStrategyOutput,
  DISTINCTNESS_AXES,
  dedupeByDistinctness,
  type StrategyOptionField,
} from './strategy.js';

function fields(over: Partial<Record<StrategyOptionField, string>> = {}): Record<StrategyOptionField, string> {
  const base = {} as Record<StrategyOptionField, string>;
  for (const f of STRATEGY_OPTION_FIELDS) base[f] = `${f}-value`;
  return { ...base, ...over };
}
const opts = (n: number) => Array.from({ length: n }, (_, i) => fields({ description: `option ${i}` }));

describe('strategy 16-field standard (ACBP-P3-001/CDR-034)', () => {
  test('the canonical field set is exactly the PRD §11.3 sixteen fields, in order', () => {
    expect(STRATEGY_OPTION_FIELDS).toEqual([
      'description', 'customer', 'offer', 'business_model', 'scope', 'benefits', 'risks', 'cost_range',
      'effort', 'time_to_validate', 'time_to_launch', 'required_resources', 'key_assumptions',
      'validation_method', 'success_metrics', 'confidence',
    ]);
    expect(STRATEGY_OPTION_FIELDS).toHaveLength(16);
  });

  test('isCompleteOptionFields requires exactly the 16 fields, each non-blank and bounded', () => {
    expect(isCompleteOptionFields(fields())).toBe(true);
    // The `"unknown"` sentinel is a LEGAL labeled value (ADR-019 no fake precision).
    expect(isCompleteOptionFields(fields({ cost_range: UNKNOWN_FIELD }))).toBe(true);
    // Missing a field.
    const missing = fields();
    delete (missing as Record<string, unknown>)['risks'];
    expect(isCompleteOptionFields(missing)).toBe(false);
    // Extra (leaked) key.
    expect(isCompleteOptionFields({ ...fields(), extra: 'x' })).toBe(false);
    // Blank / non-string / over-long field.
    expect(isCompleteOptionFields(fields({ offer: '   ' }))).toBe(false);
    expect(isCompleteOptionFields({ ...fields(), confidence: 5 as unknown as string })).toBe(false);
    expect(isCompleteOptionFields(fields({ scope: 'x'.repeat(STRATEGY_FIELD_MAX + 1) }))).toBe(false);
    expect(isCompleteOptionFields(null)).toBe(false);
  });
});

describe('parseStrategyOptions (deny-by-default)', () => {
  test('≥3 complete options → status complete', () => {
    const r = parseStrategyOptions(JSON.stringify({ options: opts(MIN_DISTINCT_OPTIONS) }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('complete');
      expect(r.value.options).toHaveLength(3);
      expect(r.value.fewerReason).toBeNull();
      expect(r.value.partial).toBe(false);
    }
  });

  test('fewer than 3 options → honest fewer_than_three, with the model reason retained', () => {
    const r = parseStrategyOptions(JSON.stringify({ options: opts(2), fewer_reason: 'Only two distinct customers exist for this idea.' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('fewer_than_three');
      expect(r.value.fewerReason).toBe('Only two distinct customers exist for this idea.');
    }
  });

  test('zero options is a valid honest outcome (fewer_than_three, count 0)', () => {
    const r = parseStrategyOptions(JSON.stringify({ options: [] }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('fewer_than_three');
      expect(r.value.options).toHaveLength(0);
    }
  });

  test('fewer_reason is dropped when the outcome is complete (a reason is only meaningful for fewer-than-three)', () => {
    const r = parseStrategyOptions(JSON.stringify({ options: opts(3), fewer_reason: 'irrelevant' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fewerReason).toBeNull();
  });

  test('the honest partial flag is carried; a non-boolean partial is rejected', () => {
    const ok = parseStrategyOptions(JSON.stringify({ options: opts(3), partial: true }));
    expect(ok.ok && ok.value.partial).toBe(true);
    expect(parseStrategyOptions(JSON.stringify({ options: opts(3), partial: 'yes' })).ok).toBe(false);
  });

  test('rejects: malformed JSON, non-object, non-array options, an incomplete option, a blank reason, and over-many options', () => {
    expect(parseStrategyOptions('{not json').ok).toBe(false);
    expect(parseStrategyOptions('42').ok).toBe(false);
    expect(parseStrategyOptions(JSON.stringify({ options: 'nope' })).ok).toBe(false);
    const bad = fields();
    delete (bad as Record<string, unknown>)['customer'];
    expect(parseStrategyOptions(JSON.stringify({ options: [bad] })).ok).toBe(false);
    expect(parseStrategyOptions(JSON.stringify({ options: opts(2), fewer_reason: '   ' })).ok).toBe(false);
    expect(parseStrategyOptions(JSON.stringify({ options: opts(MAX_STRATEGY_OPTIONS + 1) })).ok).toBe(false);
  });

  test('field values are trimmed on the way out', () => {
    const r = parseStrategyOptions(JSON.stringify({ options: [fields({ description: '  padded  ' }), fields(), fields()] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options[0]!.description).toBe('padded');
  });

  test('narrowStrategyOutput re-validates an already-parsed value and rejects a forged status/incomplete option', () => {
    const parsed = parseStrategyOptions(JSON.stringify({ options: opts(3) }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // A round-trip of the validated value narrows back cleanly (no raw re-parse needed).
    expect(narrowStrategyOutput(parsed.value)).toEqual(parsed.value);
    // A forged status inconsistent with the count is rejected.
    expect(narrowStrategyOutput({ ...parsed.value, status: 'fewer_than_three' })).toBeUndefined();
    // A fewer-than-three reason on a `complete` outcome is inconsistent → rejected.
    expect(narrowStrategyOutput({ ...parsed.value, fewerReason: 'should not be here' })).toBeUndefined();
    // An incomplete option is rejected.
    const broken = fields();
    delete (broken as Record<string, unknown>)['risks'];
    expect(narrowStrategyOutput({ options: [broken], partial: false, status: 'fewer_than_three', fewerReason: null })).toBeUndefined();
    expect(narrowStrategyOutput(null)).toBeUndefined();
  });

  test('enum guards', () => {
    expect(isStrategyGenerationStatus('complete')).toBe(true);
    expect(isStrategyGenerationStatus('done')).toBe(false);
    expect(isSimilarityCheckResult('pending')).toBe(true);
    expect(isSimilarityCheckResult('maybe')).toBe(false);
  });
});

describe('distinctness check — dedupeByDistinctness (ACBP-P3-002/CDR-035/STRAT-001)', () => {
  test('the distinctness axes are exactly customer/offer/business_model', () => {
    expect(DISTINCTNESS_AXES).toEqual(['customer', 'offer', 'business_model']);
  });

  test('a genuinely distinct set passes unchanged → distinct', () => {
    const opts = [
      fields({ customer: 'SMBs', offer: 'DIY tool', business_model: 'subscription' }),
      fields({ customer: 'Enterprises', offer: 'managed service', business_model: 'contract' }),
      fields({ customer: 'Consumers', offer: 'mobile app', business_model: 'freemium' }),
    ];
    const r = dedupeByDistinctness(opts);
    expect(r.result).toBe('distinct');
    expect(r.distinct).toHaveLength(3);
    expect(r.duplicatesRejected).toBe(0);
  });

  test('cosmetic variants (same axes, different title/prose) are rejected as near-duplicates', () => {
    // Three options identical on customer/offer/business_model — only description/benefits differ ("same plan,
    // different titles"). They collapse to ONE distinct option → insufficient_distinct.
    const opts = [
      fields({ customer: 'SMBs', offer: 'DIY tool', business_model: 'subscription', description: 'Option A' }),
      fields({ customer: 'SMBs', offer: 'DIY tool', business_model: 'subscription', description: 'Option B (reworded)' }),
      fields({ customer: 'SMBs', offer: 'DIY tool', business_model: 'subscription', description: 'Option C (also reworded)' }),
    ];
    const r = dedupeByDistinctness(opts);
    expect(r.result).toBe('insufficient_distinct');
    expect(r.distinct).toHaveLength(1);
    expect(r.distinct[0]!.description).toBe('Option A'); // first representative kept
    expect(r.duplicatesRejected).toBe(2);
  });

  test('normalization: case/whitespace differences on axis values do NOT make options distinct', () => {
    const opts = [
      fields({ customer: 'Small Businesses', offer: 'DIY tool', business_model: 'subscription' }),
      fields({ customer: '  small   businesses ', offer: 'diy tool', business_model: 'SUBSCRIPTION' }),
      fields({ customer: 'Enterprises', offer: 'managed service', business_model: 'contract' }),
    ];
    const r = dedupeByDistinctness(opts);
    // Only two genuinely-distinct options (the first two normalize to the same key) → insufficient.
    expect(r.result).toBe('insufficient_distinct');
    expect(r.distinct).toHaveLength(2);
  });

  test('differing on ANY single axis is enough to be distinct', () => {
    const base = { customer: 'SMBs', offer: 'DIY tool', business_model: 'subscription' };
    const opts = [
      fields(base),
      fields({ ...base, offer: 'managed service' }), // differs on offer only
      fields({ ...base, business_model: 'one-time' }), // differs on business_model only
    ];
    const r = dedupeByDistinctness(opts);
    expect(r.result).toBe('distinct');
    expect(r.distinct).toHaveLength(3);
  });

  test('a mixed set keeps the distinct representatives and rejects the duplicates', () => {
    const opts = [
      fields({ customer: 'SMBs', offer: 'DIY tool', business_model: 'subscription', description: 'keep-1' }),
      fields({ customer: 'SMBs', offer: 'DIY tool', business_model: 'subscription', description: 'dup-of-1' }),
      fields({ customer: 'Enterprises', offer: 'managed', business_model: 'contract', description: 'keep-2' }),
      fields({ customer: 'Consumers', offer: 'app', business_model: 'freemium', description: 'keep-3' }),
    ];
    const r = dedupeByDistinctness(opts);
    expect(r.result).toBe('distinct');
    expect(r.distinct.map((o) => o.description)).toEqual(['keep-1', 'keep-2', 'keep-3']);
    expect(r.duplicatesRejected).toBe(1);
  });

  test('an empty set is insufficient_distinct', () => {
    const r = dedupeByDistinctness([]);
    expect(r.result).toBe('insufficient_distinct');
    expect(r.distinct).toHaveLength(0);
  });
});
