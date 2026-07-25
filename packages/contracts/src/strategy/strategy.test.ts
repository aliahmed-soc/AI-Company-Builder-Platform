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
  parseStrategyRecommendation,
  resolveRecommendation,
  narrowStrategyRecommendation,
  RATIONALE_MAX,
  SELECTION_MODES,
  PHASE_SCOPES,
  validateStrategyDecision,
  isStrategySelectionMode,
  isStrategyPhaseScope,
  normalizeDecisionRationale,
  RATIONALE_MAX_DECISION,
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

  test('axis boundaries do not collide: shifting a word across adjacent axes yields DISTINCT keys (NUL-separated)', () => {
    // customer="a b"/offer="c" vs customer="a"/offer="b c" must NOT be treated as duplicates (a space join would collide).
    const a = fields({ customer: 'a b', offer: 'c', business_model: 'x' });
    const b = fields({ customer: 'a', offer: 'b c', business_model: 'x' });
    const c = fields({ customer: 'z', offer: 'z', business_model: 'z' });
    const r = dedupeByDistinctness([a, b, c]);
    expect(r.result).toBe('distinct');
    expect(r.distinct).toHaveLength(3);
    expect(r.duplicatesRejected).toBe(0);
  });
});

describe('owner decision — validateStrategyDecision (ACBP-P3-004/CDR-037/STRAT-003/005)', () => {
  test('the mode + phase-scope sets are exactly the canon values', () => {
    expect(SELECTION_MODES).toEqual(['select', 'edit', 'combine', 'reject']);
    expect(PHASE_SCOPES).toEqual(['first_phase', 'whole_plan']);
  });

  test('select: an in-range ordinal (+ optional phase scope); out-of-range / stray fields rejected', () => {
    const r = validateStrategyDecision({ mode: 'select', selectedOrdinal: 1, phaseScope: 'first_phase' }, 3);
    expect(r.ok && r.value).toEqual({ mode: 'select', selectedOrdinal: 1, phaseScope: 'first_phase' });
    // No phase scope → null.
    expect(validateStrategyDecision({ mode: 'select', selectedOrdinal: 0 }, 3)).toEqual({ ok: true, value: { mode: 'select', selectedOrdinal: 0, phaseScope: null } });
    expect(validateStrategyDecision({ mode: 'select', selectedOrdinal: 5 }, 3).ok).toBe(false); // out of range
    expect(validateStrategyDecision({ mode: 'select' }, 3).ok).toBe(false); // no ordinal
    expect(validateStrategyDecision({ mode: 'select', selectedOrdinal: 0, chosenFields: fields() }, 3).ok).toBe(false); // stray fields
    expect(validateStrategyDecision({ mode: 'select', selectedOrdinal: 0, phaseScope: 'later' }, 3).ok).toBe(false); // bad phase enum
  });

  test('edit: a valid 16-field object + optional in-range base ordinal; combine: 16-field object, no base', () => {
    const e = validateStrategyDecision({ mode: 'edit', selectedOrdinal: 0, chosenFields: fields({ description: '  edited  ' }) }, 3);
    expect(e.ok).toBe(true);
    if (e.ok && e.value.mode === 'edit') expect(e.value.chosenFields.description).toBe('edited'); // normalized
    const c = validateStrategyDecision({ mode: 'combine', chosenFields: fields() }, 3);
    expect(c.ok && c.value.mode).toBe('combine');
    // Invalid shapes.
    const incomplete = fields();
    delete (incomplete as Record<string, unknown>)['risks'];
    expect(validateStrategyDecision({ mode: 'edit', chosenFields: incomplete }, 3).ok).toBe(false);
    expect(validateStrategyDecision({ mode: 'combine', chosenFields: fields(), selectedOrdinal: 0 }, 3).ok).toBe(false); // combine names no base
    expect(validateStrategyDecision({ mode: 'edit', chosenFields: fields(), reasons: 'x' }, 3).ok).toBe(false); // stray reasons
  });

  test('reject: non-blank bounded reasons required; no option/fields/phase scope', () => {
    expect(validateStrategyDecision({ mode: 'reject', reasons: 'none fit our budget' }, 3)).toEqual({ ok: true, value: { mode: 'reject', reasons: 'none fit our budget' } });
    expect(validateStrategyDecision({ mode: 'reject', reasons: '   ' }, 3).ok).toBe(false); // blank
    expect(validateStrategyDecision({ mode: 'reject' }, 3).ok).toBe(false); // missing
    expect(validateStrategyDecision({ mode: 'reject', reasons: 'x', selectedOrdinal: 0 }, 3).ok).toBe(false); // stray option
    expect(validateStrategyDecision({ mode: 'reject', reasons: 'x', phaseScope: 'first_phase' }, 3).ok).toBe(false); // phase meaningless for reject
  });

  test('an unknown mode is rejected', () => {
    expect(validateStrategyDecision({ mode: 'approve' }, 3).ok).toBe(false);
    expect(isStrategySelectionMode('select')).toBe(true);
    expect(isStrategyPhaseScope('whole_plan')).toBe(true);
    expect(isStrategyPhaseScope('nope')).toBe(false);
  });
});

describe('decision record — normalizeDecisionRationale (ACBP-P3-005/CDR-038/STRAT-006)', () => {
  test('absent or blank rationale normalizes to null — a decision is never blocked for lacking one', () => {
    expect(normalizeDecisionRationale(undefined)).toBeNull();
    expect(normalizeDecisionRationale(null)).toBeNull();
    expect(normalizeDecisionRationale('   ')).toBeNull();
  });

  test('a usable rationale is trimmed and preserved', () => {
    expect(normalizeDecisionRationale('  cheapest path to a first customer  ')).toBe('cheapest path to a first customer');
    expect(normalizeDecisionRationale('x'.repeat(RATIONALE_MAX_DECISION))).toHaveLength(RATIONALE_MAX_DECISION);
  });

  test('a present-but-unusable rationale is undefined (deny-by-default: the caller surfaces `invalid`)', () => {
    expect(normalizeDecisionRationale('x'.repeat(RATIONALE_MAX_DECISION + 1))).toBeUndefined(); // over-long
    expect(normalizeDecisionRationale(42)).toBeUndefined(); // non-string
    expect(normalizeDecisionRationale({ text: 'nope' })).toBeUndefined();
  });

  test('the bound applies to the NORMALIZED value — surrounding whitespace is not content', () => {
    // At the limit plus padding: the trimmed value fits, so it is accepted (and it is the trimmed value that is stored,
    // so the DB CHECK can never be violated by the padding).
    const padded = `  ${'x'.repeat(RATIONALE_MAX_DECISION)}  `;
    expect(normalizeDecisionRationale(padded)).toHaveLength(RATIONALE_MAX_DECISION);
  });
});

describe('AI recommendation — parse + resolve (ACBP-P3-003/CDR-036/STRAT-004)', () => {
  const rec = (over: Record<string, unknown> = {}) => JSON.stringify({ recommended_ordinal: 1, rationale: 'Best fit for the target customer.', sensitivities: 'Changes if the budget assumption is wrong.', ...over });

  test('parseStrategyRecommendation shape-validates and passes an abstain through', () => {
    const ok = parseStrategyRecommendation(rec());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value).toEqual({ recommendedOrdinal: 1, rationale: 'Best fit for the target customer.', sensitivities: 'Changes if the budget assumption is wrong.' });
    // Honest abstain (recommended_ordinal null) is a VALID shape.
    const abstain = parseStrategyRecommendation(JSON.stringify({ recommended_ordinal: null, rationale: null, sensitivities: null }));
    expect(abstain.ok && abstain.value.recommendedOrdinal).toBeNull();
  });

  test('parseStrategyRecommendation rejects malformed shapes (non-JSON, non-object, wrong-typed fields)', () => {
    expect(parseStrategyRecommendation('not json').ok).toBe(false);
    expect(parseStrategyRecommendation('42').ok).toBe(false);
    expect(parseStrategyRecommendation(JSON.stringify({ recommended_ordinal: '1' })).ok).toBe(false); // string ordinal
    expect(parseStrategyRecommendation(JSON.stringify({ recommended_ordinal: 1.5 })).ok).toBe(false); // non-integer
    expect(parseStrategyRecommendation(JSON.stringify({ recommended_ordinal: 0, rationale: 42 })).ok).toBe(false); // number rationale
  });

  test('resolveRecommendation SHOWS a recommendation only when option-in-range + non-blank rationale + sensitivities', () => {
    const parsed = parseStrategyRecommendation(rec({ recommended_ordinal: 2 }));
    if (!parsed.ok) throw new Error('unreachable');
    // Valid: ordinal 2 within [0,3), both fields non-blank.
    expect(resolveRecommendation(parsed.value, 3)).toEqual({ recommendedOrdinal: 2, rationale: 'Best fit for the target customer.', sensitivities: 'Changes if the budget assumption is wrong.' });
    // Out of range → abstain (null).
    expect(resolveRecommendation(parsed.value, 2)).toBeNull();
  });

  test('resolveRecommendation DENIES by default: abstain, out-of-range, blank rationale, blank sensitivities, over-long', () => {
    const mk = (o: Record<string, unknown>) => { const p = parseStrategyRecommendation(JSON.stringify(o)); if (!p.ok) throw new Error('bad'); return p.value; };
    expect(resolveRecommendation(mk({ recommended_ordinal: null, rationale: 'x', sensitivities: 'y' }), 3)).toBeNull(); // abstain
    expect(resolveRecommendation(mk({ recommended_ordinal: 5, rationale: 'x', sensitivities: 'y' }), 3)).toBeNull(); // out of range
    expect(resolveRecommendation(mk({ recommended_ordinal: -1, rationale: 'x', sensitivities: 'y' }), 3)).toBeNull(); // negative
    expect(resolveRecommendation(mk({ recommended_ordinal: 0, rationale: '   ', sensitivities: 'y' }), 3)).toBeNull(); // blank rationale
    expect(resolveRecommendation(mk({ recommended_ordinal: 0, rationale: 'x', sensitivities: '' }), 3)).toBeNull(); // blank sensitivities
    expect(resolveRecommendation(mk({ recommended_ordinal: 0, rationale: 'z'.repeat(RATIONALE_MAX + 1), sensitivities: 'y' }), 3)).toBeNull(); // over-long
  });

  test('narrowStrategyRecommendation re-narrows the gateway-validated (camelCase) value without re-parsing', () => {
    const parsed = parseStrategyRecommendation(rec());
    if (!parsed.ok) throw new Error('unreachable');
    // A round-trip of the validated value (camelCase) narrows back cleanly — the core consumes THIS, not raw text.
    expect(narrowStrategyRecommendation(parsed.value)).toEqual(parsed.value);
    expect(narrowStrategyRecommendation({ recommendedOrdinal: null, rationale: null, sensitivities: null })).toEqual({ recommendedOrdinal: null, rationale: null, sensitivities: null });
    // A corrupted seam value is rejected.
    expect(narrowStrategyRecommendation({ recommendedOrdinal: 'x' })).toBeUndefined();
    expect(narrowStrategyRecommendation(null)).toBeUndefined();
  });

  test('resolveRecommendation trims the surfaced rationale/sensitivities', () => {
    const p = parseStrategyRecommendation(rec({ recommended_ordinal: 0, rationale: '  padded why  ', sensitivities: '  padded what  ' }));
    if (!p.ok) throw new Error('bad');
    const r = resolveRecommendation(p.value, 1);
    expect(r).toEqual({ recommendedOrdinal: 0, rationale: 'padded why', sensitivities: 'padded what' });
  });
});
