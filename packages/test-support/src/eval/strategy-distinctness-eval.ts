// @acbp/test-support — ACBP-P3-006 / CDR-086: eval area 4 (three-option strategy generation), MODEL-FREE half.
//
// ADR-019 §13 mandates a pre-production evaluation gate over ten areas; area 4 is "three-option strategy generation".
// CDR-002 §10 sets its hard gate as "strategy distinctness 100% seeded-near-duplicate rejection + ≥90% rubric-distinct
// triples". Those two halves have different costs: the STRAT-001 similarity check is DETERMINISTIC AND MODEL-FREE
// (CDR-035 §1 — "no embeddings, no metering"), so the seeded-rejection half is scorable offline at zero spend, while
// the rubric half needs real generations from both ADR-019 pinned models and is therefore gated on ACBP-P2-011.
//
// This module scores ONLY the model-free half and DECLARES the rubric half deferred (see `AREA_4_DEFERRED_METRICS`).
// The deferred metric is never reported as passing — `scoreStrategyDistinctness` puts it in `deferred`, never in
// `metrics`, so a reader cannot mistake "not run" for "met". Dev/CI only; never a production dependency.

import { MIN_DISTINCT_OPTIONS, STRATEGY_OPTION_FIELDS, dedupeByDistinctness } from '@acbp/contracts';
import type {
  DistinctnessResult,
  SimilarityCheckResult,
  StrategyOptionField,
  StrategyOptionFields,
} from '@acbp/contracts';

/**
 * The eval DATASET version (CDR-002 §8 requires a versioned dataset — thresholds and cases must be reproducible).
 * Bump on any change to `STRATEGY_DISTINCTNESS_CASES`; a re-run against a different version is not a comparable run.
 */
export const STRATEGY_EVAL_DATASET_VERSION = '2026-08-07.1';

export type EvalVerdict = 'pass' | 'warn' | 'fail';

/** A four-tier threshold entry (CDR-002 §8). `warning` is null where no tighter margin can exist — see below. */
export interface EvalThresholdSpec {
  readonly metric: string;
  /** The hard release threshold as a fraction in [0,1]. */
  readonly hard: number;
  /** The warning threshold (a tighter margin inside the hard gate), or null when none is expressible. */
  readonly warning: number | null;
  /** The canon clause this value comes from. No value here is invented. */
  readonly source: string;
}

/**
 * Area 4's model-free metric. CDR-002 §10 fixes the hard gate at 100% seeded-near-duplicate rejection.
 *
 * `warning` is NULL deliberately. CDR-002 §8 places warning thresholds at "5-point/percentage tighter margins" INSIDE
 * the hard gate; at a hard gate of 100% there is no value between the gate and perfection, so a warning tier here
 * would have to be either 100% (identical to the gate — no signal) or above it (unreachable). Recording null states
 * that honestly rather than inventing a number CDR-002 does not authorize.
 */
export const AREA_4_SEEDED_REJECTION_THRESHOLD: EvalThresholdSpec = {
  metric: 'seeded_near_duplicate_rejection',
  hard: 1,
  warning: null,
  source: 'CDR-002 §10',
};

/** A metric declared by canon but NOT scorable here, with the reason and the ticket that unblocks it. */
export interface DeferredEvalMetric extends EvalThresholdSpec {
  readonly blockedBy: string;
  readonly reason: string;
}

/** Area 4's second half — real generations from both pinned models, hence gated on the live-model eval ticket. */
export const AREA_4_DEFERRED_METRICS: readonly DeferredEvalMetric[] = [
  {
    metric: 'rubric_distinct_triples',
    hard: 0.9,
    warning: 0.95,
    source: 'CDR-002 §10',
    blockedBy: 'ACBP-P2-011',
    reason:
      'Scoring rubric-distinct triples requires real strategy generations from the ADR-019 pinned models (metered, ' +
      'both models per the backlog row). No live-provider path exists in this repository, so the metric is declared, ' +
      'not measured.',
  },
];

/** One seeded evaluation case: an option set with a KNOWN number of deliberately-planted cosmetic variants. */
export interface DistinctnessEvalCase {
  readonly id: string;
  /** The canon shape this case is derived from. Synthetic throughout — CDR-002 §8 forbids real tenant data. */
  readonly provenance: string;
  readonly options: readonly StrategyOptionFields[];
  /** How many options are deliberately planted near-duplicates (options matching another on ALL three axes). */
  readonly seededDuplicates: number;
  readonly expectedDistinct: number;
  readonly expectedResult: SimilarityCheckResult;
}

/** Build a complete 16-field option (PRD §11.3). Values are synthetic placeholders; only the axes carry meaning. */
function option(over: Partial<Record<StrategyOptionField, string>>): StrategyOptionFields {
  const base = {} as Record<StrategyOptionField, string>;
  for (const f of STRATEGY_OPTION_FIELDS) base[f] = `${f}-value`;
  return { ...base, ...over };
}

/**
 * The versioned seeded dataset. Cases are derived from PRD J-07 ("options differ on customer/offer/model") and the
 * MASTER-PRD §103 anti-pattern ("the same plan with different titles"). Zero real tenant data by construction.
 *
 * The set deliberately mixes SEEDED cases (planted cosmetic variants that MUST be rejected) with CONTROL cases (zero
 * planted duplicates that MUST survive untouched). Controls are what stop a checker that simply rejects everything
 * from scoring 100%: a control whose outcome does not match is a case failure, and any case failure fails the area.
 */
export const STRATEGY_DISTINCTNESS_CASES: readonly DistinctnessEvalCase[] = [
  {
    id: 'control-three-genuinely-distinct',
    provenance: 'PRD J-07 — three options differing on all three axes',
    options: [
      option({ customer: 'independent retailers', offer: 'self-serve stock tool', business_model: 'monthly subscription' }),
      option({ customer: 'regional wholesalers', offer: 'managed rollout service', business_model: 'annual contract' }),
      option({ customer: 'individual makers', offer: 'mobile listing app', business_model: 'freemium' }),
    ],
    seededDuplicates: 0,
    expectedDistinct: 3,
    expectedResult: 'distinct',
  },
  {
    id: 'control-differs-on-one-axis-only',
    provenance: 'STRAT-001 — differing on ONE axis is already genuinely distinct',
    options: [
      option({ customer: 'independent retailers', offer: 'self-serve stock tool', business_model: 'monthly subscription' }),
      option({ customer: 'independent retailers', offer: 'self-serve stock tool', business_model: 'one-time licence' }),
      option({ customer: 'independent retailers', offer: 'guided onboarding', business_model: 'monthly subscription' }),
    ],
    seededDuplicates: 0,
    expectedDistinct: 3,
    expectedResult: 'distinct',
  },
  {
    id: 'seeded-all-three-cosmetic-variants',
    provenance: 'MASTER-PRD §103 — the same plan with different titles',
    options: [
      option({ customer: 'independent retailers', offer: 'self-serve stock tool', business_model: 'monthly subscription', description: 'Fast Track' }),
      option({ customer: 'independent retailers', offer: 'self-serve stock tool', business_model: 'monthly subscription', description: 'Growth Path' }),
      option({ customer: 'independent retailers', offer: 'self-serve stock tool', business_model: 'monthly subscription', description: 'Momentum Plan' }),
    ],
    seededDuplicates: 2,
    expectedDistinct: 1,
    expectedResult: 'insufficient_distinct',
  },
  {
    id: 'seeded-one-duplicate-among-four',
    provenance: 'PRD J-07 — a viable triple survives after one cosmetic variant is rejected',
    options: [
      option({ customer: 'independent retailers', offer: 'self-serve stock tool', business_model: 'monthly subscription' }),
      option({ customer: 'independent retailers', offer: 'self-serve stock tool', business_model: 'monthly subscription', description: 'reworded twin' }),
      option({ customer: 'regional wholesalers', offer: 'managed rollout service', business_model: 'annual contract' }),
      option({ customer: 'individual makers', offer: 'mobile listing app', business_model: 'freemium' }),
    ],
    seededDuplicates: 1,
    expectedDistinct: 3,
    expectedResult: 'distinct',
  },
  {
    id: 'seeded-case-and-whitespace-variants',
    provenance: 'CDR-035 §1 — normalization (case-fold, trim, collapse) catches trivial rewording of axis values',
    options: [
      option({ customer: 'Independent Retailers', offer: 'Self-Serve Stock Tool', business_model: 'Monthly Subscription' }),
      option({ customer: '  independent   retailers ', offer: 'self-serve stock tool', business_model: 'MONTHLY SUBSCRIPTION' }),
      option({ customer: 'regional wholesalers', offer: 'managed rollout service', business_model: 'annual contract' }),
    ],
    seededDuplicates: 1,
    expectedDistinct: 2,
    expectedResult: 'insufficient_distinct',
  },
];

export interface EvalMetricResult extends EvalThresholdSpec {
  /** The measured value as a fraction in [0,1]. */
  readonly observed: number;
  readonly numerator: number;
  readonly denominator: number;
  readonly verdict: EvalVerdict;
}

export interface EvalCaseOutcome {
  readonly id: string;
  readonly passed: boolean;
  readonly expected: { readonly distinct: number; readonly rejected: number; readonly result: SimilarityCheckResult };
  readonly actual: { readonly distinct: number; readonly rejected: number; readonly result: SimilarityCheckResult };
}

export interface EvalAreaReport {
  readonly area: 4;
  readonly areaName: string;
  readonly datasetVersion: string;
  readonly caseCount: number;
  readonly metrics: readonly EvalMetricResult[];
  readonly deferred: readonly DeferredEvalMetric[];
  readonly cases: readonly EvalCaseOutcome[];
  readonly failures: readonly string[];
  readonly verdict: EvalVerdict;
}

/** The check under evaluation. Injectable so the suite can prove the eval goes RED against a broken checker. */
export type DistinctnessChecker = (options: readonly StrategyOptionFields[]) => DistinctnessResult;

/**
 * The three axes, and the normalization CDR-035 §1 defines (case-fold, trim, collapse internal whitespace),
 * DELIBERATELY re-derived here rather than imported from the contract.
 *
 * This function validates the DATASET, not the checker. Importing `distinctnessKey` would make the guard move in
 * lockstep with the very code the eval measures — a change to the contract's normalization would silently redefine
 * what counts as a "planted duplicate", and the seeds would agree with the checker by construction. Written out, the
 * two must agree on canon's definition independently.
 */
const DATASET_AXES = ['customer', 'offer', 'business_model'] as const satisfies readonly StrategyOptionField[];
function axisSignature(o: StrategyOptionFields): string {
  return DATASET_AXES.map((a) => o[a].trim().toLowerCase().replace(/\s+/g, ' ')).join('\u0000');
}

/**
 * Assert the seeded dataset actually contains what it claims, and THROW if it does not.
 *
 * This exists because the area's hard gate is 100% rejection: a case that declares a planted near-duplicate it does
 * not contain would score as a perfect rejection while rejecting nothing, and the whole area would read green on an
 * empty proof. The guard throws rather than returning a verdict so a malformed dataset can never be scored at all.
 */
export function assertEvalDatasetWellFormed(cases: readonly DistinctnessEvalCase[]): void {
  const seenIds = new Set<string>();
  let seededTotal = 0;

  for (const c of cases) {
    if (seenIds.has(c.id)) throw new Error(`eval dataset: duplicate case id ${c.id}`);
    seenIds.add(c.id);

    for (const [i, opt] of c.options.entries()) {
      for (const f of STRATEGY_OPTION_FIELDS) {
        if (typeof opt[f] !== 'string' || opt[f].trim() === '') {
          throw new Error(`eval dataset: case ${c.id} option ${i} is missing the required field "${f}" (PRD §11.3)`);
        }
      }
    }

    const signatures = new Set(c.options.map(axisSignature));
    const actualDuplicates = c.options.length - signatures.size;

    if (actualDuplicates !== c.seededDuplicates) {
      throw new Error(
        `eval dataset: case ${c.id} declares ${c.seededDuplicates} seeded near-duplicate(s) but contains ` +
          `${actualDuplicates} — a declared seed that is not planted would score as a rejection of nothing`,
      );
    }
    if (signatures.size !== c.expectedDistinct) {
      throw new Error(
        `eval dataset: case ${c.id} declares expectedDistinct=${c.expectedDistinct} but contains ${signatures.size} ` +
          `genuinely distinct option(s)`,
      );
    }

    const impliedResult: SimilarityCheckResult =
      c.expectedDistinct >= MIN_DISTINCT_OPTIONS ? 'distinct' : 'insufficient_distinct';
    if (c.expectedResult !== impliedResult) {
      throw new Error(
        `eval dataset: case ${c.id} declares expectedResult=${c.expectedResult}, but ${c.expectedDistinct} distinct ` +
          `option(s) implies ${impliedResult} (STRAT-001 needs ${MIN_DISTINCT_OPTIONS})`,
      );
    }

    seededTotal += c.seededDuplicates;
  }

  if (seededTotal === 0) {
    throw new Error(
      'eval dataset: no seeded near-duplicates in the whole set — a 100% rejection rate over zero seeds is vacuous',
    );
  }
}

export interface ScoreOptions {
  readonly cases?: readonly DistinctnessEvalCase[];
  readonly checker?: DistinctnessChecker;
}

/**
 * Score area 4's model-free half over the seeded dataset.
 *
 * A seeded near-duplicate counts as REJECTED only when its whole case matches expectation (distinct set size, rejected
 * count and verdict). That definition is what makes over-rejection visible: a checker that collapses genuinely distinct
 * options fails its control cases instead of quietly scoring 100%.
 */
export function scoreStrategyDistinctness(opts: ScoreOptions = {}): EvalAreaReport {
  const cases = opts.cases ?? STRATEGY_DISTINCTNESS_CASES;

  /*
   * THE GUARD RUNS HERE, NOT ONLY IN THE COMMAND, AND ITS ABSENCE MADE ITS OWN DOCSTRING FALSE.
   *
   * `assertEvalDatasetWellFormed` says it throws "so a malformed dataset can never be scored at all". That was
   * true of `pnpm eval:area-4`, which calls it before scoring — and false of this function, which is the only
   * way the CI suite scores anything and which accepts a CALLER-SUPPLIED `opts.cases`. Scoring a malformed
   * dataset was one argument away.
   *
   * It matters because the area's hard gate is 100% rejection: a case declaring a planted near-duplicate it does
   * not contain scores as a perfect rejection while rejecting nothing, and the area reads green on an empty
   * proof. Calling it here makes the sentence in its docstring true of every path that scores.
   */
  assertEvalDatasetWellFormed(cases);

  const check = opts.checker ?? dedupeByDistinctness;
  const outcomes: EvalCaseOutcome[] = [];
  const failures: string[] = [];
  let seededTotal = 0;
  let seededRejected = 0;

  for (const c of cases) {
    const actual = check(c.options);
    const passed =
      actual.distinct.length === c.expectedDistinct &&
      actual.duplicatesRejected === c.seededDuplicates &&
      actual.result === c.expectedResult;

    seededTotal += c.seededDuplicates;
    if (passed) seededRejected += c.seededDuplicates;

    outcomes.push({
      id: c.id,
      passed,
      expected: { distinct: c.expectedDistinct, rejected: c.seededDuplicates, result: c.expectedResult },
      actual: { distinct: actual.distinct.length, rejected: actual.duplicatesRejected, result: actual.result },
    });

    if (!passed) {
      failures.push(
        `case ${c.id}: expected distinct=${c.expectedDistinct} rejected=${c.seededDuplicates} result=${c.expectedResult}; ` +
          `got distinct=${actual.distinct.length} rejected=${actual.duplicatesRejected} result=${actual.result}`,
      );
    }
  }

  const observed = seededTotal === 0 ? 0 : seededRejected / seededTotal;
  const metric: EvalMetricResult = {
    ...AREA_4_SEEDED_REJECTION_THRESHOLD,
    observed,
    numerator: seededRejected,
    denominator: seededTotal,
    verdict: observed >= AREA_4_SEEDED_REJECTION_THRESHOLD.hard ? 'pass' : 'fail',
  };

  if (metric.verdict === 'fail') {
    failures.push(`metric ${metric.metric}: observed ${observed} below hard threshold ${metric.hard} (${metric.source})`);
  }

  return {
    area: 4,
    areaName: 'three-option strategy generation',
    datasetVersion: STRATEGY_EVAL_DATASET_VERSION,
    caseCount: cases.length,
    metrics: [metric],
    deferred: AREA_4_DEFERRED_METRICS,
    cases: outcomes,
    failures,
    verdict: failures.length === 0 ? 'pass' : 'fail',
  };
}
