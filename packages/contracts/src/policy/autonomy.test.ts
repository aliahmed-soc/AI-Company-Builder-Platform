// @acbp/contracts — autonomy levels (ACBP-P6-006a; CDR-071; APPR-008; PRD §12). Written BEFORE the implementation
// and watched to fail.
//
// The tests that matter here are the ones about what happens when the level is WRONG, because the failure mode of
// this module is an action executing without a human saying yes. A level that reads as "no restriction" is worse
// than no level at all.
import { describe, test, expect } from 'vitest';
import {
  AUTONOMY_LEVELS,
  MVP_AUTONOMY_LEVELS,
  MOST_RESTRICTIVE_AUTONOMY_LEVEL,
  DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL,
  AUTONOMY_LEVEL_CONSEQUENCES,
  isAutonomyLevel,
  isMvpAutonomyLevel,
  resolveAutonomyLevel,
  autonomyLevelRules,
  type AutonomyLevel,
} from './autonomy.js';
import { evaluatePolicy, DEFAULT_NEW_COMPANY_POLICY, type PolicyRuleSet, type PolicyObservations } from './evaluate.js';
import { RISK_CLASSES } from '../tools/risk-class.js';

const observed = (riskClass: string): PolicyObservations => ({ risk_class: { value: riskClass, provenance: 'registry' } });

/** A rule set carrying ONLY the level's rules, over a permissive baseline — so any refusal came from the level. */
const levelOnly = (level: AutonomyLevel): PolicyRuleSet => ({ version: 1, baseline: 'allow', rules: autonomyLevelRules(level) });

describe('the level vocabulary comes from canon, not from here', () => {
  test('PRD §12 names five levels', () => {
    expect(AUTONOMY_LEVELS).toEqual([1, 2, 3, 4, 5]);
  });

  test('MVP ships levels 1-2 only (PRD §11.5)', () => {
    expect(MVP_AUTONOMY_LEVELS).toEqual([1, 2]);
  });

  test('the most restrictive level is DERIVED from the list, so it cannot drift if the set is revisited', () => {
    expect(MOST_RESTRICTIVE_AUTONOMY_LEVEL).toBe(AUTONOMY_LEVELS[0]);
    expect(MOST_RESTRICTIVE_AUTONOMY_LEVEL).toBe(1);
  });

  test('every level has a plain-language consequence — PRD principle 2 requires the consequence, not the number', () => {
    for (const level of AUTONOMY_LEVELS) {
      expect(AUTONOMY_LEVEL_CONSEQUENCES[level].trim().length).toBeGreaterThan(0);
    }
  });
});

describe('CDR-071 §2-G3 — the NEW-COMPANY default and the CORRUPT-DATA fallback are different decisions', () => {
  test('a new company starts at level 2, because the owner ruled that posture on 2026-07-29', () => {
    expect(DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL).toBe(2);
  });

  test('and it is deliberately NOT the most restrictive level — the two must not be collapsed into one constant', () => {
    expect(DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL).not.toBe(MOST_RESTRICTIVE_AUTONOMY_LEVEL);
  });

  test('the ruled default is an MVP level, so it can actually be set', () => {
    expect(isMvpAutonomyLevel(DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL)).toBe(true);
  });

  test('the default level agrees with DEFAULT_NEW_COMPANY_POLICY — one definition of what executes unasked', () => {
    // If these ever disagree, a new company's stored rules and its level would answer "does this need approval"
    // differently, which is the exact defect CDR-071 §2-G2 composes to avoid.
    expect(autonomyLevelRules(DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL).map((r) => ({ ...r, id: '' }))).toEqual(
      DEFAULT_NEW_COMPANY_POLICY.rules.map((r) => ({ ...r, id: '' })),
    );
  });
});

describe('recognising a level', () => {
  test('the five levels are levels', () => {
    for (const level of AUTONOMY_LEVELS) expect(isAutonomyLevel(level)).toBe(true);
  });

  test.each([0, 6, -1, 1.5, '1', '2', null, undefined, {}, [], NaN, Infinity, true])('%p is not a level', (value) => {
    expect(isAutonomyLevel(value)).toBe(false);
  });

  test('only 1 and 2 are available in MVP', () => {
    expect(MVP_AUTONOMY_LEVELS.every(isMvpAutonomyLevel)).toBe(true);
    for (const level of [3, 4, 5]) expect(isMvpAutonomyLevel(level)).toBe(false);
  });
});

describe('CDR-071 §2-G4 — an unusable level resolves to the MOST RESTRICTIVE one', () => {
  test('a valid level resolves to itself', () => {
    for (const level of AUTONOMY_LEVELS) expect(resolveAutonomyLevel(level)).toBe(level);
  });

  // Each of these is a way the column can come back wrong: absent, corrupt, out of range, or a string from a driver
  // that did not coerce. NONE of them may read as "no restriction applies".
  test.each([undefined, null, 0, 6, 99, -1, 2.5, '2', 'two', '', {}, [], NaN, Infinity, true, false])(
    'the unusable value %p resolves to level 1',
    (value) => {
      expect(resolveAutonomyLevel(value)).toBe(MOST_RESTRICTIVE_AUTONOMY_LEVEL);
    },
  );
});

describe('CDR-071 §2-G2 — the level RESTRICTS; at level 1 nothing executes unasked', () => {
  test.each(RISK_CLASSES)('level 1 requires approval for %s', (riskClass) => {
    const result = evaluatePolicy(levelOnly(1), observed(riskClass));
    expect(result.decision).toBe('require_approval');
  });

  test('level 2 lets informational execute — the control, without which "refuses everything" would also pass', () => {
    const result = evaluatePolicy(levelOnly(2), observed('informational'));
    expect(result.decision).toBe('allow');
  });

  test('level 2 lets internal-reversible execute (PRD §12: "L2: execute; results reviewable")', () => {
    const result = evaluatePolicy(levelOnly(2), observed('internal_reversible'));
    expect(result.decision).toBe('allow');
  });

  test.each(['external_reversible', 'sensitive_irreversible'])('level 2 still requires approval for %s', (riskClass) => {
    const result = evaluatePolicy(levelOnly(2), observed(riskClass));
    expect(result.decision).toBe('require_approval');
  });

  test('an UNCLASSIFIED action requires approval at BOTH levels — TOOL-001 resolves it to the most restrictive class', () => {
    for (const level of MVP_AUTONOMY_LEVELS) {
      const result = evaluatePolicy(levelOnly(level), observed('not-a-risk-class'));
      expect(result.decision).toBe('require_approval');
    }
  });
});

describe('CDR-071 §2-G2 — composing a level can only ever TIGHTEN', () => {
  // The defect this prevents: a company at level 1 whose stored rules are permissive having two contradictory
  // answers to "does this need approval", where the wrong one is the one that executes.
  const permissive: PolicyRuleSet = { version: 3, baseline: 'allow', rules: [] };

  test('level 1 rules added to a wide-open policy refuse informational anyway', () => {
    const composed: PolicyRuleSet = { ...permissive, rules: [...permissive.rules, ...autonomyLevelRules(1)] };
    expect(evaluatePolicy(composed, observed('informational')).decision).toBe('require_approval');
  });

  test('a level NEVER loosens: adding level 2 rules cannot turn an existing deny into an allow', () => {
    const denying: PolicyRuleSet = {
      version: 4,
      baseline: 'allow',
      rules: [{ id: 'company-deny', dimension: 'risk_class', condition: 'risk_at_least', operand: 'informational', decision: 'deny' }],
    };
    const composed: PolicyRuleSet = { ...denying, rules: [...denying.rules, ...autonomyLevelRules(2)] };
    expect(evaluatePolicy(composed, observed('informational')).decision).toBe('deny');
  });
});

describe('CDR-071 §2-G5 — levels 3-5 are storable but never more permissive than MVP allows', () => {
  test.each([3, 4, 5] as const)('level %s yields the level-1 rules, so a stored future level cannot execute unasked', (level) => {
    expect(autonomyLevelRules(level)).toEqual(autonomyLevelRules(1));
  });
});
