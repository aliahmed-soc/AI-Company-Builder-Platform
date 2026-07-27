// ACBP-P5-003a — TOOL-001's "Risk class mandatory; unclassified = most restrictive" made executable.
//
// The set itself is OWNER-APPROVED BY DEFAULT and provisional (CDR-051 §0) — canon never enumerates it. These tests
// therefore pin the two things that are NOT provisional: that the ordering exists and is total, and that an absent or
// unrecognised class resolves to the most restrictive one rather than to anything convenient.
import { describe, test, expect } from 'vitest';
import { RISK_CLASSES, isRiskClass, riskRank, resolveRiskClass, isAtLeastAsRestrictiveAs, MOST_RESTRICTIVE_RISK_CLASS } from './risk-class.js';

describe('the risk-class set', () => {
  test('is closed — an unregistered class is not a class', () => {
    expect(isRiskClass('informational')).toBe(true);
    expect(isRiskClass('internal_reversible')).toBe(true);
    expect(isRiskClass('external_reversible')).toBe(true);
    expect(isRiskClass('external_irreversible')).toBe(true);
    for (const bad of ['harmless', 'INFORMATIONAL', 'external', '', null, undefined, 0, {}]) {
      expect(isRiskClass(bad)).toBe(false);
    }
  });

  test('is ORDERED, and the order is total — "most restrictive" is meaningless without it', () => {
    const ranks = RISK_CLASSES.map(riskRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(RISK_CLASSES.length); // no two classes share a rank
  });

  test('the most restrictive class is the LAST one, and is named explicitly', () => {
    expect(MOST_RESTRICTIVE_RISK_CLASS).toBe(RISK_CLASSES[RISK_CLASSES.length - 1]);
    for (const c of RISK_CLASSES) expect(riskRank(c)).toBeLessThanOrEqual(riskRank(MOST_RESTRICTIVE_RISK_CLASS));
  });

  test('informational is the least restrictive — a read-only tool must never out-rank a write', () => {
    expect(riskRank('informational')).toBeLessThan(riskRank('internal_reversible'));
    expect(riskRank('internal_reversible')).toBeLessThan(riskRank('external_reversible'));
    expect(riskRank('external_reversible')).toBeLessThan(riskRank('external_irreversible'));
  });
});

describe('resolveRiskClass — TOOL-001\'s "unclassified = most restrictive"', () => {
  test('a registered class resolves to itself', () => {
    for (const c of RISK_CLASSES) expect(resolveRiskClass(c)).toBe(c);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['unrecognised', 'harmless'],
    ['canon\'s ungrouped "external"', 'external'],
    ['a wrong-cased class', 'Informational'],
    ['a non-string', 42],
  ])('%s resolves to the MOST RESTRICTIVE class, never to a convenient default', (_label, input) => {
    expect(resolveRiskClass(input)).toBe(MOST_RESTRICTIVE_RISK_CLASS);
  });

  test('the fallback is NOT `informational` — that is the specific bug this rule exists to prevent', () => {
    // Defaulting an unknown class to "harmless" would let a tool whose registration is broken run ungated. The
    // failure mode is silent: nothing errors, and an external-effect tool executes as if it read a document.
    expect(resolveRiskClass(undefined)).not.toBe('informational');
    expect(resolveRiskClass('anything-at-all')).not.toBe('informational');
  });

  test('resolution NEVER throws — a broken registry row must not take the dispatcher down', () => {
    // Refusing would be a denial of service on the whole registry (CDR-051 §2-G2). The call still happens; it happens
    // under the strictest gate.
    for (const bad of [null, undefined, '', 'nonsense', 42, {}, [], Symbol('s')]) {
      expect(() => resolveRiskClass(bad)).not.toThrow();
    }
  });
});

describe('riskRank — total, and never ranks an unknown value below a real one (review pass 1)', () => {
  test('an unclassified value ranks as the MOST restrictive, never -1', () => {
    // The bypass this closes: typed `RiskClass`, `indexOf` returns -1 for anything unrecognised — BELOW
    // `informational`. A cast at a database boundary (`row.risk_class as RiskClass`) is the obvious thing to write,
    // and it would have silently produced the least restrictive rank possible for a broken registry row.
    for (const bad of [undefined, null, '', 'external', 'nonsense', 42, {}]) {
      expect(riskRank(bad)).toBe(riskRank(MOST_RESTRICTIVE_RISK_CLASS));
      expect(riskRank(bad)).toBeGreaterThan(riskRank('informational'));
    }
  });

  test('rank is never negative for any input at all', () => {
    for (const value of [...RISK_CLASSES, undefined, null, 'junk', -1, Symbol('s')]) {
      expect(riskRank(value)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('isAtLeastAsRestrictiveAs — the comparison policy will key off', () => {
  test('a class is at least as restrictive as itself', () => {
    for (const c of RISK_CLASSES) expect(isAtLeastAsRestrictiveAs(c, c)).toBe(true);
  });

  test('compares by rank, in the direction the name claims', () => {
    expect(isAtLeastAsRestrictiveAs('external_irreversible', 'informational')).toBe(true);
    expect(isAtLeastAsRestrictiveAs('informational', 'external_irreversible')).toBe(false);
  });

  test('an UNCLASSIFIED value compares as the most restrictive, so a broken row never slips under a threshold', () => {
    // The comparison must apply the same resolution rule, or a caller could bypass a gate by passing a class the
    // registry failed to record.
    expect(isAtLeastAsRestrictiveAs(undefined, 'external_irreversible')).toBe(true);
    expect(isAtLeastAsRestrictiveAs(null, 'informational')).toBe(true);
  });
});
