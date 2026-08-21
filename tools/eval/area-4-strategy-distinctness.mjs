// ACBP-P3-006 / CDR-086 — the runnable area-4 evaluation: `pnpm eval:area-4`.
//
// Scores eval area 4 (three-option strategy generation, ADR-019 §13) against the versioned seeded dataset and prints
// the report that the backlog row names as its verification procedure. Exits NON-ZERO when the area's model-free half
// does not meet its CDR-002 §10 hard threshold.
//
// Deliberately needs NOTHING external: no database, no model provider, no key, no network. The STRAT-001 similarity
// check is deterministic and model-free (CDR-035 §1), so this run costs nothing and can never skip — which is the
// whole reason this half of the area could ship ahead of ACBP-P2-011.
//
// The scoring, dataset and renderer all live in @acbp/test-support and are the SAME implementation the CI suite
// asserts (packages/test-support/src/eval/strategy-distinctness-eval.test.ts), so this command cannot drift from the
// guarantee the tests prove.

const { assertEvalDatasetWellFormed, scoreStrategyDistinctness, renderStrategyDistinctnessReport, evalExitCode, STRATEGY_DISTINCTNESS_CASES } =
  await import('@acbp/test-support');

// Validate the dataset BEFORE scoring it. A case that declares a planted near-duplicate it does not contain would
// score as a rejection of nothing, and a 100% hard gate would read green over an empty proof. This throws instead.
assertEvalDatasetWellFormed(STRATEGY_DISTINCTNESS_CASES);

const report = scoreStrategyDistinctness();
console.log(renderStrategyDistinctnessReport(report));

// The mapping itself is unit-tested (both branches) in strategy-distinctness-eval.test.ts.
process.exit(evalExitCode(report));
