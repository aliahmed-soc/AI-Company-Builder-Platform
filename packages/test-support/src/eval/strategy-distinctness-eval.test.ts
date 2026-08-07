// ACBP-P3-006 / CDR-086 — eval area 4 (three-option strategy generation), MODEL-FREE half.
//
// ADR-019 §13 lists ten pre-production eval areas; area 4 is "three-option strategy generation". CDR-002 §10 sets its
// hard gate as "strategy distinctness 100% seeded-near-duplicate rejection + ≥90% rubric-distinct triples". Only the
// FIRST half is scorable without a live model — the STRAT-001 similarity check is deterministic and model-free
// (CDR-035 §1) — so only that half is scored here. The rubric half is DECLARED DEFERRED, never reported as passing.

import { describe, expect, test } from 'vitest';
import {
  assertEvalDatasetWellFormed,
  scoreStrategyDistinctness,
  STRATEGY_DISTINCTNESS_CASES,
  STRATEGY_EVAL_DATASET_VERSION,
  type DistinctnessChecker,
  type DistinctnessEvalCase,
} from './strategy-distinctness-eval.js';
import { evalExitCode, renderStrategyDistinctnessReport } from './strategy-distinctness-report.js';

/** A checker that never rejects anything — the "missed every near-duplicate" mutant. */
const neverRejects: DistinctnessChecker = (options) => ({
  distinct: options,
  result: options.length >= 3 ? 'distinct' : 'insufficient_distinct',
  duplicatesRejected: 0,
});

/** A checker that collapses every option set to one — the "rejects everything" mutant. */
const rejectsEverything: DistinctnessChecker = (options) => ({
  distinct: options.slice(0, 1),
  result: 'insufficient_distinct',
  duplicatesRejected: Math.max(0, options.length - 1),
});

describe('ACBP-P3-006 — eval area 4, model-free half', () => {
  test('the shipped seeded dataset scores 100% near-duplicate rejection and passes its hard threshold', () => {
    const report = scoreStrategyDistinctness();

    const metric = report.metrics.find((m) => m.metric === 'seeded_near_duplicate_rejection');
    expect(metric).toBeDefined();
    expect(metric?.observed).toBe(1);
    expect(metric?.hard).toBe(1);
    expect(metric?.verdict).toBe('pass');
    expect(report.verdict).toBe('pass');
  });

  // The eval is only worth having if it goes RED against a broken checker. These two mutants are the evidence:
  // without them a dataset of trivially-distinct options would also score 100% and prove nothing.
  test('fails the area when the checker misses every seeded near-duplicate', () => {
    const report = scoreStrategyDistinctness({ checker: neverRejects });

    const metric = report.metrics.find((m) => m.metric === 'seeded_near_duplicate_rejection');
    expect(metric?.observed).toBe(0);
    expect(metric?.verdict).toBe('fail');
    expect(report.verdict).toBe('fail');
    // The seeded cases are named in the failure list, so a red run says WHICH case regressed.
    expect(report.failures.some((f) => f.includes('seeded-all-three-cosmetic-variants'))).toBe(true);
  });

  test('fails the area when the checker over-rejects genuinely distinct options', () => {
    const report = scoreStrategyDistinctness({ checker: rejectsEverything });

    // Over-rejection cannot hide behind a high rejection rate: the CONTROL cases catch it.
    expect(report.verdict).toBe('fail');
    expect(report.failures.some((f) => f.includes('control-three-genuinely-distinct'))).toBe(true);
  });

  test('the shipped dataset is well-formed — every declared seed is a real planted near-duplicate', () => {
    expect(() => assertEvalDatasetWellFormed(STRATEGY_DISTINCTNESS_CASES)).not.toThrow();
  });

  test('the dataset guard THROWS when a case claims a seeded duplicate it does not actually contain', () => {
    const vacuous: DistinctnessEvalCase = {
      ...STRATEGY_DISTINCTNESS_CASES[0]!,
      id: 'vacuous-seed',
      // Three genuinely distinct options, but the case CLAIMS one is a planted duplicate. Scoring this would
      // report a rejection that never had anything to reject.
      seededDuplicates: 1,
    };

    // Pinned to the SEED-MISMATCH message specifically. Matching only the case id would also pass if the guard threw
    // for an unrelated reason (every message names the case), which would not prove this failure mode is detected.
    expect(() => assertEvalDatasetWellFormed([vacuous])).toThrow(
      /case vacuous-seed declares 1 seeded near-duplicate\(s\) but contains 0/,
    );
  });

  test('the rendered report discloses the deferred half instead of implying area 4 is fully evaluated', () => {
    const text = renderStrategyDistinctnessReport(scoreStrategyDistinctness());

    expect(text).toContain('ACBP-P3-006');
    expect(text).toContain(STRATEGY_EVAL_DATASET_VERSION);
    expect(text).toContain('seeded_near_duplicate_rejection');
    // The gate evidence must not be readable as "area 4 passed". The deferred half is named, with its blocker.
    expect(text).toContain('DEFERRED');
    expect(text).toContain('rubric_distinct_triples');
    expect(text).toContain('ACBP-P2-011');
    expect(text).toMatch(/AREA 4 IS NOT FULLY EVALUATED/);
  });

  // `pnpm eval:area-4` is the row's verification procedure, so its exit code IS the evidence. Keeping the mapping in
  // a pure function means both branches are covered here rather than living untested inside the runner script.
  test('the exit code is 0 only when the scored half passes, and 1 when it fails', () => {
    expect(evalExitCode(scoreStrategyDistinctness())).toBe(0);
    expect(evalExitCode(scoreStrategyDistinctness({ checker: neverRejects }))).toBe(1);
  });

  test('the deferred rubric metric is declared but never reported as a passing metric', () => {
    const report = scoreStrategyDistinctness();

    expect(report.metrics.some((m) => m.metric === 'rubric_distinct_triples')).toBe(false);
    const deferred = report.deferred.find((d) => d.metric === 'rubric_distinct_triples');
    expect(deferred?.blockedBy).toBe('ACBP-P2-011');
    expect(deferred?.hard).toBe(0.9);
  });
});
