// @acbp/contracts — the deterministic policy evaluator (ACBP-P6-001a; CDR-066 §3-G3/G5/G6/G7/G8; ADR-010).
// Written BEFORE the implementation and watched to fail.
//
// The acceptance clause is *"same inputs same decision"*, so the tests that matter most are the ones proving the
// evaluator is a FUNCTION OF ITS INPUTS — no clock, no counters read from anywhere — and that everything it cannot
// read resolves toward refusal rather than being skipped.
import { describe, test, expect } from 'vitest';
import {
  POLICY_DIMENSIONS,
  TRUST_CRITICAL_DIMENSIONS,
  POLICY_CONDITIONS,
  FACT_PROVENANCES,
  DEFAULT_NEW_COMPANY_POLICY,
  evaluatePolicy,
  type PolicyRuleSet,
  type PolicyObservations,
} from './evaluate.js';

/**
 * A rule set at version 7, so every assertion about versioning is about a value that had to be carried through.
 *
 * `baseline` defaults to `deny` here only so these fixtures stay terse — it is REQUIRED on the type and is never
 * defaulted by the evaluator (CDR-066 §3-G9).
 */
const ruleSet = (rules: PolicyRuleSet['rules'], baseline: PolicyRuleSet['baseline'] = 'deny'): PolicyRuleSet => ({ version: 7, baseline, rules });
const structured = (value: unknown) => ({ value, provenance: 'structured' as const });
const fromModel = (value: unknown) => ({ value, provenance: 'model' as const });
const fromRegistry = (value: unknown) => ({ value, provenance: 'registry' as const });

const SPEND_RULE = { id: 'spend-1', dimension: 'spending_limit', condition: 'at_or_over_limit', operand: 100, decision: 'require_approval' } as const;
const RISK_RULE = { id: 'risk-1', dimension: 'risk_class', condition: 'risk_at_least', operand: 'external_reversible', decision: 'require_approval' } as const;
const STOP_RULE = { id: 'stop-1', dimension: 'emergency_stop', condition: 'flag_is_set', decision: 'deny', escalate: true } as const;

describe('the closed vocabularies come from canon, not from here', () => {
  test('dimensions are ADR-010 §5\'s own list', () => {
    // Every one of these is named in APPROVAL-AND-POLICY-ARCHITECTURE §4 or ADR-010 §5. Nothing invented.
    expect([...POLICY_DIMENSIONS]).toEqual([
      'spending_limit', 'message_limit', 'allowed_destinations', 'working_hours', 'forbidden_action',
      'risk_class', 'allowed_tools', 'emergency_stop', 'integration_status', 'usage_limit',
      'data_sensitivity', 'required_roles',
    ]);
  });

  test('the trust-critical set is exactly what ADR-010 §5 names as not-from-model-text', () => {
    // "trust-critical determinations (risk class, spend, destination, forbidden match) come from the tool registry
    // and structured payload fields, not model text."
    expect([...TRUST_CRITICAL_DIMENSIONS].sort()).toEqual(['allowed_destinations', 'forbidden_action', 'risk_class', 'spending_limit']);
  });

  test('provenance and condition sets are closed and lowercase', () => {
    expect([...FACT_PROVENANCES]).toEqual(['registry', 'structured', 'model']);
    for (const c of POLICY_CONDITIONS) expect(c).toMatch(/^[a-z][a-z_]*$/);
  });
});

describe('determinism — the evaluator is a function of its inputs (G3)', () => {
  test('the same inputs give the identical result, every time', () => {
    const rs = ruleSet([SPEND_RULE, RISK_RULE]);
    const obs: PolicyObservations = { spending_limit: structured(50), risk_class: fromRegistry('informational') };
    const first = evaluatePolicy(rs, obs);
    for (let i = 0; i < 25; i++) expect(evaluatePolicy(rs, obs)).toEqual(first);
  });

  test('the evaluating INSTANT is an input, so a working-hours rule is testable at any wall-clock time', () => {
    // A permissive baseline so this isolates the RULE's contribution rather than re-testing the baseline.
    const rs = ruleSet([{ id: 'hours-1', dimension: 'working_hours', condition: 'flag_is_set', decision: 'require_approval' }], 'allow');
    // "Outside hours" is a fact the caller supplies. Nothing here reads a clock, which is exactly why this test can
    // run at any hour and give the same answer — the property the acceptance clause is about.
    expect(evaluatePolicy(rs, { working_hours: structured(true) }).decision).toBe('require_approval');
    expect(evaluatePolicy(rs, { working_hours: structured(false) }).decision).toBe('allow');
  });
});

describe('versioning — every decision names the rules that produced it (G6)', () => {
  test('the rule-set version is carried into the result', () => {
    expect(evaluatePolicy(ruleSet([STOP_RULE]), { emergency_stop: structured(true) }).policyVersion).toBe(7);
  });

  test('an UNREADABLE rule set denies and reports no version — it never silently evaluates as empty', () => {
    for (const bad of [undefined, null, {}, { version: 7 }, { rules: [] }, { version: 'seven', rules: [] }, 42, 'rules']) {
      const r = evaluatePolicy(bad, {});
      expect(r.decision).toBe('deny');
      expect(r.policyVersion).toBeNull();
    }
  });

  test('a well-formed but EMPTY rule set reports its version and returns its baseline', () => {
    const r = evaluatePolicy(ruleSet([]), {});
    expect(r.decision).toBe('deny');
    expect(r.policyVersion).toBe(7);
  });

  test('an unreadable BASELINE is as fatal as an unreadable version', () => {
    for (const bad of ['ALLOW', 'permit', null, 0, {}, undefined]) {
      const r = evaluatePolicy({ version: 7, baseline: bad, rules: [] }, {});
      expect(r.decision).toBe('deny');
      expect(r.policyVersion).toBeNull();
    }
  });
});

describe('the BASELINE is explicit and required (G9)', () => {
  test('an all-quiet rule set returns its baseline — that is the only way `allow` is ever reached', () => {
    expect(evaluatePolicy(ruleSet([], 'allow'), {}).decision).toBe('allow');
    expect(evaluatePolicy(ruleSet([], 'deny'), {}).decision).toBe('deny');
    expect(evaluatePolicy(ruleSet([], 'require_approval'), {}).decision).toBe('require_approval');
  });

  test('a rule set with NO baseline is unreadable — it is never assumed permissive', () => {
    const r = evaluatePolicy({ version: 7, rules: [] }, {});
    expect(r.decision).toBe('deny');
    expect(r.policyVersion).toBeNull();
  });

  test('a firing rule always beats a permissive baseline', () => {
    const r = evaluatePolicy(ruleSet([STOP_RULE], 'allow'), { emergency_stop: structured(true) });
    expect(r.decision).toBe('deny');
  });
});

describe('a rule that cannot be evaluated DENIES and is named (G4)', () => {
  test('a missing observation makes its rule unevaluable, not absent', () => {
    // The temptation is to skip a rule whose input is missing. That is the rule-gap failure: a restriction nobody
    // could check becomes a restriction that did not apply.
    const r = evaluatePolicy(ruleSet([SPEND_RULE]), {});
    expect(r.decision).toBe('deny');
    expect(r.unevaluableRuleIds).toEqual(['spend-1']);
    expect(r.firedRuleIds).toEqual([]);
  });

  // ── THE TEST THAT ACTUALLY PROVES FAIL-CLOSED ──────────────────────────────────────────────────────────
  // Found by mutation: with a `deny` baseline, "unevaluable contributes deny" and "unevaluable is silently skipped"
  // are INDISTINGUISHABLE — both end at `deny`, one because the guard worked and one because the baseline caught it.
  // Every earlier test in this block was satisfied by the wrong implementation. Only a PERMISSIVE baseline separates
  // them, because only then does skipping the rule actually let the action through.
  test('an unevaluable rule overrides a permissive baseline — it is NOT skipped', () => {
    const r = evaluatePolicy(ruleSet([SPEND_RULE], 'allow'), {});
    expect(r.decision).toBe('deny');
    expect(r.unevaluableRuleIds).toEqual(['spend-1']);
  });

  test('an unevaluable rule alongside a firing permissive rule still denies', () => {
    const permit = { id: 'ok-1', dimension: 'usage_limit', condition: 'at_or_over_limit', operand: 0, decision: 'allow' } as const;
    const r = evaluatePolicy(ruleSet([SPEND_RULE, permit], 'allow'), { usage_limit: structured(5) });
    expect(r.decision).toBe('deny');
    expect(r.firedRuleIds).toEqual(['ok-1']);
    expect(r.unevaluableRuleIds).toEqual(['spend-1']);
  });

  test('a MALFORMED rule overrides a permissive baseline too', () => {
    const r = evaluatePolicy(ruleSet([{ id: 'bad-2', dimension: 'nope', condition: 'flag_is_set', decision: 'allow' } as never], 'allow'), {});
    expect(r.decision).toBe('deny');
    expect(r.unevaluableRuleIds).toContain('bad-2');
  });

  // There are THREE distinct ways a rule becomes unevaluable, and each needs its own permissive-baseline test —
  // found the hard way: the first two were covered and a mutation that skipped the THIRD still passed, because
  // every test reaching that branch used a `deny` baseline that masked the result.
  //   1. the rule itself is malformed              (above)
  //   2. the observation is missing / unwrapped    (above)
  //   3. the CONDITION cannot be decided from an otherwise well-formed observation  (here)
  test('a rule whose CONDITION cannot be decided overrides a permissive baseline', () => {
    // A well-formed provenance wrapper carrying a value the comparison cannot use. The rule is present, its input is
    // present, and it still cannot be evaluated — so it must refuse rather than quietly not apply.
    for (const junk of ['100', null, NaN, {}, Infinity]) {
      const r = evaluatePolicy(ruleSet([SPEND_RULE], 'allow'), { spending_limit: structured(junk) });
      expect(r.decision).toBe('deny');
      expect(r.unevaluableRuleIds).toEqual(['spend-1']);
    }
  });

  test('an undecidable flag condition overrides a permissive baseline', () => {
    const r = evaluatePolicy(ruleSet([STOP_RULE], 'allow'), { emergency_stop: structured('true') });
    expect(r.decision).toBe('deny');
    expect(r.unevaluableRuleIds).toEqual(['stop-1']);
  });

  test('an allowlist operand that is not a list overrides a permissive baseline', () => {
    const rule = { id: 'dest-2', dimension: 'allowed_destinations', condition: 'not_in_allowlist', operand: 'a@example.test', decision: 'deny' } as const;
    const r = evaluatePolicy(ruleSet([rule], 'allow'), { allowed_destinations: structured('b@example.test') });
    expect(r.decision).toBe('deny');
    expect(r.unevaluableRuleIds).toEqual(['dest-2']);
  });

  test('a malformed rule denies and is named', () => {
    const r = evaluatePolicy(ruleSet([{ id: 'bad-1', dimension: 'nonsense', condition: 'at_or_over_limit', operand: 1, decision: 'allow' } as never]), { spending_limit: structured(0) });
    expect(r.decision).toBe('deny');
    expect(r.unevaluableRuleIds).toContain('bad-1');
  });

  test('a non-numeric limit or counter is unevaluable, never coerced', () => {
    for (const junk of ['100', null, undefined, NaN, {}, [], Infinity]) {
      const r = evaluatePolicy(ruleSet([SPEND_RULE]), { spending_limit: structured(junk) });
      expect(r.decision).toBe('deny');
      expect(r.unevaluableRuleIds).toEqual(['spend-1']);
    }
  });

  test('a rule with an unreadable id is still counted — it cannot vanish for want of a name', () => {
    const r = evaluatePolicy(ruleSet([{ dimension: 'spending_limit', condition: 'at_or_over_limit', operand: 1, decision: 'deny' } as never]), { spending_limit: structured(5) });
    expect(r.decision).toBe('deny');
    expect(r.unevaluableRuleIds.length).toBe(1);
  });
});

describe('conditions', () => {
  test('at_or_over_limit fires at the boundary, not just past it', () => {
    expect(evaluatePolicy(ruleSet([SPEND_RULE]), { spending_limit: structured(99) }).firedRuleIds).toEqual([]);
    expect(evaluatePolicy(ruleSet([SPEND_RULE]), { spending_limit: structured(100) }).firedRuleIds).toEqual(['spend-1']);
    expect(evaluatePolicy(ruleSet([SPEND_RULE]), { spending_limit: structured(101) }).firedRuleIds).toEqual(['spend-1']);
  });

  test('risk_at_least compares on the ORDERED set, never by name (G7)', () => {
    const fire = (riskClass: string) => evaluatePolicy(ruleSet([RISK_RULE]), { risk_class: fromRegistry(riskClass) }).firedRuleIds;
    expect(fire('informational')).toEqual([]);
    expect(fire('internal_reversible')).toEqual([]);
    expect(fire('external_reversible')).toEqual(['risk-1']);
    expect(fire('sensitive_irreversible')).toEqual(['risk-1']);
  });

  test('an UNCLASSIFIED risk resolves to the most restrictive class and therefore fires', () => {
    // TOOL-001. The unclassified case needs no rule of its own — it is simply gated as the most dangerous class.
    expect(evaluatePolicy(ruleSet([RISK_RULE]), { risk_class: fromRegistry(null) }).firedRuleIds).toEqual(['risk-1']);
  });

  test('flag_is_set fires only on a real boolean true', () => {
    const fired = (v: unknown) => evaluatePolicy(ruleSet([STOP_RULE]), { emergency_stop: structured(v) }).firedRuleIds;
    expect(fired(true)).toEqual(['stop-1']);
    expect(fired(false)).toEqual([]);
    // A truthy non-boolean is a caller mistake; it is unevaluable rather than quietly read as set.
    expect(evaluatePolicy(ruleSet([STOP_RULE]), { emergency_stop: structured('true') }).unevaluableRuleIds).toEqual(['stop-1']);
  });

  test('not_in_allowlist fires when the value is absent from the operand list', () => {
    const rule = { id: 'dest-1', dimension: 'allowed_destinations', condition: 'not_in_allowlist', operand: ['a@example.test'], decision: 'deny' } as const;
    expect(evaluatePolicy(ruleSet([rule]), { allowed_destinations: structured('a@example.test') }).firedRuleIds).toEqual([]);
    expect(evaluatePolicy(ruleSet([rule]), { allowed_destinations: structured('b@example.test') }).firedRuleIds).toEqual(['dest-1']);
    // An operand that is not a list cannot express an allowlist — unevaluable, not "everything is allowed".
    expect(evaluatePolicy(ruleSet([rule]), { allowed_destinations: structured('b@example.test') }).decision).toBe('deny');
  });
});

describe('model-produced classifications are untrusted inputs (G5, PRD principle 17)', () => {
  test('on a TRUST-CRITICAL dimension, a model-sourced value makes the rule fire regardless of the value', () => {
    // "Where a model classification is the only available signal, the engine treats it as untrusted and takes the
    // most restrictive applicable path." For a restriction rule that means assuming the restricted case holds.
    // Permissive baseline, so the rule's own contribution is what is being read. The observed value is 0 — nowhere
    // near the limit of 100 — and the rule fires anyway, because a model's word about spend is not evidence.
    const r = evaluatePolicy(ruleSet([SPEND_RULE], 'allow'), { spending_limit: fromModel(0) });
    expect(r.firedRuleIds).toEqual(['spend-1']);
    expect(r.decision).toBe('require_approval');
    expect(r.untrustedRuleIds).toEqual(['spend-1']);
  });

  test('a model-sourced RISK CLASS cannot lower the gate', () => {
    const r = evaluatePolicy(ruleSet([RISK_RULE]), { risk_class: fromModel('informational') });
    expect(r.firedRuleIds).toEqual(['risk-1']);
  });

  test('on a NON-trust-critical dimension, a model-sourced value is read normally', () => {
    // Nothing in canon requires distrusting a model hint about working hours; over-restricting everywhere would make
    // the distinction meaningless and the engine useless.
    const rs = ruleSet([{ id: 'hours-1', dimension: 'working_hours', condition: 'flag_is_set', decision: 'require_approval' }]);
    expect(evaluatePolicy(rs, { working_hours: fromModel(false) }).firedRuleIds).toEqual([]);
  });

  test('an unrecognised provenance is treated as UNTRUSTED, not as structured', () => {
    const r = evaluatePolicy(ruleSet([SPEND_RULE]), { spending_limit: { value: 0, provenance: 'guess' } as never });
    expect(r.firedRuleIds).toEqual(['spend-1']);
  });

  test('a bare value with NO provenance wrapper is unevaluable', () => {
    const r = evaluatePolicy(ruleSet([SPEND_RULE]), { spending_limit: 0 as never });
    expect(r.decision).toBe('deny');
    expect(r.unevaluableRuleIds).toEqual(['spend-1']);
  });
});

describe('combination and escalation across rules (POL-005)', () => {
  test('the most restrictive fired rule wins, and deny beats require_approval', () => {
    const rs = ruleSet([SPEND_RULE, STOP_RULE]);
    const r = evaluatePolicy(rs, { spending_limit: structured(500), emergency_stop: structured(true) });
    expect(r.decision).toBe('deny');
    expect(r.escalate).toBe(true);
    expect([...r.firedRuleIds].sort()).toEqual(['spend-1', 'stop-1']);
  });

  test('escalation is reported only when the winning decision is a denial', () => {
    const rs = ruleSet([{ id: 'esc-1', dimension: 'usage_limit', condition: 'at_or_over_limit', operand: 1, decision: 'require_approval', escalate: true }], 'allow');
    const r = evaluatePolicy(rs, { usage_limit: structured(5) });
    expect(r.decision).toBe('require_approval');
    expect(r.escalate).toBe(false);
  });

  test('a rule that does not fire contributes nothing — but an all-quiet rule set still denies', () => {
    const r = evaluatePolicy(ruleSet([SPEND_RULE]), { spending_limit: structured(1) });
    expect(r.firedRuleIds).toEqual([]);
    expect(r.decision).toBe('deny');
  });
});

describe('no default LIMIT VALUES are shipped (G8; AOQ-14 is the owner\'s)', () => {
  // This guard used to be a name regex banning anything matching /DEFAULT|LIMIT|CAP/. That was a blunt proxy: it
  // would have banned the owner-RULED baseline policy (G10) while still permitting a rule literally named
  // `spendRule` carrying a threshold of 500. It now asserts what G8 actually says — no numeric threshold on a
  // limit dimension — which is the thing AOQ-14 reserves to the owner.
  const LIMIT_DIMENSIONS = ['spending_limit', 'message_limit', 'usage_limit', 'working_hours'] as const;

  test('the shipped default policy carries no numeric threshold on any limit dimension', () => {
    for (const rule of DEFAULT_NEW_COMPANY_POLICY.rules) {
      if ((LIMIT_DIMENSIONS as readonly string[]).includes(rule.dimension)) {
        expect(typeof rule.operand).not.toBe('number');
      }
    }
  });
});

describe('the owner-ruled new-company baseline (G10, ruled 2026-07-29)', () => {
  // "informational and internal-reversible actions are allowed by default; anything at a higher risk class requires
  // approval; nothing is denied outright by the baseline alone."
  const decideFor = (riskClass: unknown) => evaluatePolicy(DEFAULT_NEW_COMPANY_POLICY, { risk_class: fromRegistry(riskClass) }).decision;

  test('informational and internal_reversible are ALLOWED — a new company can do useful internal work on day one', () => {
    expect(decideFor('informational')).toBe('allow');
    expect(decideFor('internal_reversible')).toBe('allow');
  });

  test('everything above internal_reversible REQUIRES APPROVAL — nothing external or costly happens unasked', () => {
    expect(decideFor('external_reversible')).toBe('require_approval');
    expect(decideFor('sensitive_irreversible')).toBe('require_approval');
  });

  test('an UNCLASSIFIED action requires approval — it resolves to the most restrictive class', () => {
    for (const junk of [null, undefined, '', 'made_up_class', 42]) expect(decideFor(junk)).toBe('require_approval');
  });

  test('the baseline alone NEVER denies — deny is reserved for rules a company adds on top', () => {
    expect(DEFAULT_NEW_COMPANY_POLICY.baseline).toBe('allow');
    for (const rule of DEFAULT_NEW_COMPANY_POLICY.rules) expect(rule.decision).not.toBe('deny');
    for (const riskClass of ['informational', 'internal_reversible', 'external_reversible', 'sensitive_irreversible']) {
      expect(decideFor(riskClass)).not.toBe('deny');
    }
  });

  test('a company-added deny rule still wins over the permissive baseline (POL-005)', () => {
    const withDeny: PolicyRuleSet = { ...DEFAULT_NEW_COMPANY_POLICY, rules: [...DEFAULT_NEW_COMPANY_POLICY.rules, STOP_RULE] };
    expect(evaluatePolicy(withDeny, { risk_class: fromRegistry('informational'), emergency_stop: structured(true) }).decision).toBe('deny');
  });

  test('the default policy is itself a well-formed, versioned rule set', () => {
    const r = evaluatePolicy(DEFAULT_NEW_COMPANY_POLICY, { risk_class: fromRegistry('informational') });
    expect(r.policyVersion).toBe(DEFAULT_NEW_COMPANY_POLICY.version);
    expect(r.unevaluableRuleIds).toEqual([]);
  });

  test('a MODEL-sourced risk class cannot buy the permissive path', () => {
    // risk_class is trust-critical, so a model claiming "informational" fires the rule anyway (G5).
    expect(evaluatePolicy(DEFAULT_NEW_COMPANY_POLICY, { risk_class: fromModel('informational') }).decision).toBe('require_approval');
  });
});
