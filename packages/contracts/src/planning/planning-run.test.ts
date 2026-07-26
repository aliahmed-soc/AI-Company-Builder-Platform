// @acbp/contracts — planning-run contract tests (ACBP-P4-006; CDR-041; PLAN-004).
import { describe, test, expect } from 'vitest';
import {
  PLANNING_RUN_MODES,
  PLANNING_RUN_OUTCOMES,
  PLANNING_INPUT_KINDS,
  isPlanningRunMode,
  isPlanningRunOutcome,
  isPlanningInputKind,
  isFullyExplained,
} from './planning-run.js';

describe('planning run enums (CDR-041)', () => {
  test('modes cover both entry points — a steered run is a planning run too', () => {
    // PLAN-002 runs propose tasks, so "why these tasks" applies to them exactly as it does to autonomous planning
    // (CDR-041 §3-G1). Excluding them would leave the owner's own steered plans unexplained.
    expect(PLANNING_RUN_MODES).toEqual(['autonomous', 'steered']);
    expect(isPlanningRunMode('steered')).toBe(true);
    expect(isPlanningRunMode('manual')).toBe(false);
  });

  test('outcomes keep steering\'s honest answers DISTINCT from failure', () => {
    // Collapsing clarification/refusal into `failed` would record an honest model answer as a system fault — the
    // exact misrepresentation PLAN-002's failure clause forbids.
    expect(PLANNING_RUN_OUTCOMES).toEqual(['ok', 'partial', 'clarification', 'refusal', 'failed']);
    for (const honest of ['clarification', 'refusal']) expect(isPlanningRunOutcome(honest)).toBe(true);
    expect(isPlanningRunOutcome('error')).toBe(false);
  });

  test('input kinds are closed, and already declare the kinds P4-006 does not yet record', () => {
    // `metric`/`prior_result` have no subsystem yet (P6-009 / Phase 5). Declaring them now is what makes adding them
    // an INSERT rather than a migration + CHECK change (CDR-041 §2).
    expect(PLANNING_INPUT_KINDS).toEqual(['roadmap', 'decision', 'milestone', 'memory_item', 'memory_item_withheld', 'metric', 'prior_result']);
    expect(isPlanningInputKind('memory_item_withheld')).toBe(true);
    expect(isPlanningInputKind('everything')).toBe(false);
  });

  test('a WITHHELD memory item is its own kind, not an omission', () => {
    // "Considered it and did not use it, because of a MEM-004 conflict" is transparency. Dropping it would make the
    // snapshot claim the item was never looked at.
    expect(isPlanningInputKind('memory_item')).toBe(true);
    expect(isPlanningInputKind('memory_item_withheld')).toBe(true);
    expect(PLANNING_INPUT_KINDS.filter((k) => k.startsWith('memory_item'))).toHaveLength(2);
  });
});

describe('isFullyExplained (PLAN-004)', () => {
  test('a run is fully explained only when EVERY task carries a rationale', () => {
    expect(isFullyExplained({ taskCount: 3, tasksMissingRationale: 0 })).toBe(true);
    expect(isFullyExplained({ taskCount: 3, tasksMissingRationale: 1 })).toBe(false);
    expect(isFullyExplained({ taskCount: 3, tasksMissingRationale: 3 })).toBe(false);
  });

  test('a run that produced NO tasks is not "fully explained" by vacuous truth', () => {
    // A failed or refused run explains nothing; reporting it as fully explained would be the most misleading possible
    // reading of a zero count.
    expect(isFullyExplained({ taskCount: 0, tasksMissingRationale: 0 })).toBe(false);
  });
});
