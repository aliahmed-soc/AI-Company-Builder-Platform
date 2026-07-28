// @acbp/contracts — failure detail and visible retries (ACBP-P5-013; CDR-059; TASK-006; TASK-010; ACT-005).
// Zero-dep and PURE. Derived entirely from columns `task_runs` already has; there is no failure-detail table, because
// a stored copy of a run's own facts could disagree with the run.
//
// TASK-006 IS THREE WORDS: *"No blank failures."* Everything below exists to make that true for inputs nobody
// intended — a category that was never written because the process died first, a value from a future version of the
// schema, an attempt count that arrived as a string. Each of those is a real row a founder can land on.
import { RUN_FAILURE_CATEGORIES, isRunFailureCategory, type RunFailureCategory } from './run.js';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../jobs/retry.js';

/** The category as a founder sees it: the closed set, plus the honest fallback for "we cannot say". */
export type ReportedFailureCategory = RunFailureCategory | 'unknown';

/**
 * One fixed plain-language sentence per category.
 *
 * DERIVED, NEVER PROVIDER TEXT. A provider's exception message is unbounded, may carry internal detail, and is not
 * ours to show (ADR-017, and the standing rule that provider exception text never leaves the boundary). These
 * sentences say what happened in terms of the platform's own vocabulary.
 *
 * IN CODE, NOT IN THE DATABASE (CDR-059 §3): every company gets the same sentence for the same category, and a
 * missing row would render a failure blank — the one thing TASK-006 forbids.
 */
export const FAILURE_SUMMARIES: Readonly<Record<ReportedFailureCategory, string>> = {
  worker_lost: 'The worker running this task stopped responding, so the run was ended and can be attempted again.',
  timeout: 'This run went past the time it is allowed to take and was stopped.',
  provider_error: 'The AI provider could not complete this request.',
  policy_blocked: 'A policy stopped this run before it could finish.',
  internal_error: 'Something went wrong on our side while running this task.',
  // THE POINT OF THE WHOLE TICKET. A run can fail before anything records why — a crash between the state transition
  // and the category write — and "unknown" is the truthful answer to that. "Error", an empty string, or a hidden
  // field would each be a way of not answering.
  unknown: 'This run failed and the cause could not be determined.',
};

/**
 * The categories that are SAFE to retry, per `FAILURE-AND-RECOVERY`'s idempotency column.
 *
 * EXACTLY ONE MEMBER, and it is the only unconditional *"safe"* in that table: row 1's model timeout, *"pure call —
 * safe"*.
 *
 * NARROWED after review. The first version also listed `worker_lost` and `provider_error`, and both were more
 * permissive than canon actually establishes:
 *
 * - **`worker_lost`** — row 4's idempotency cell reads *"Checkpointed steps idempotent"*. That is a REQUIREMENT ON A
 *   DESIGN, conditional on checkpoints existing. There are none in this codebase: `reclaimLostRuns` fails the run
 *   outright rather than resuming it, so a worker lost mid-step may already have performed a side effect. Canon's
 *   own global rule is *"non-idempotent actions are never retried without a safe idempotency mechanism"*.
 * - **`provider_error`** — rows 2 and 3 do say `Safe`, but in THIS codebase `provider_error` is the catch-all the
 *   worker runtime assigns to any thrown step. That bucket includes row 8, tool/API failure, whose idempotency cell
 *   reads **`Required`** and whose retry cell reads *"Only idempotent-keyed calls"*. A thrown tool call would have
 *   been reported safe to retry.
 *
 * Nothing consumes this yet, so no double execution could have occurred — but this is precisely the value a future
 * retry trigger would trust, and a docstring claiming a canon derivation canon does not support is how that trust
 * gets misplaced. Widening it again needs either real checkpoints or a category split that separates a provider
 * fault from a thrown tool call.
 */
export const RETRY_SAFE_CATEGORIES: readonly RunFailureCategory[] = ['timeout'];

/**
 * Which categories are worth retrying at all.
 *
 * A `policy_blocked` run is a DECISION, not a fault — retrying re-runs the same decision. Showing a founder
 * "1 of 3 attempts used" would invite them to wait for a retry that is never coming (CDR-059 G4).
 */
const RETRY_ELIGIBLE_CATEGORIES: readonly ReportedFailureCategory[] = ['timeout', 'worker_lost', 'provider_error'];

/**
 * What happens next. Three real answers, so none has to be inferred from a number.
 *
 * `retry_eligible`, NOT `scheduled` — renamed after review. Nothing in this system re-runs a failed task yet: there
 * is no retry trigger, `startRun` has no production caller, and CDR-059 §4 says so outright. A value named
 * `scheduled` would have asserted a future event that never happens, which is the exact opposite of G4's own
 * standard ("honest about the future"). Eligibility is what this can actually know.
 */
export type NextAttempt = 'retry_eligible' | 'exhausted' | 'not_eligible';

export interface RunFailureDetail {
  readonly category: ReportedFailureCategory;
  readonly summary: string;
  readonly attemptsUsed: number;
  readonly attemptsAllowed: number;
  readonly retrySafety: 'safe' | 'unsafe';
  readonly nextAttempt: NextAttempt;
}

export interface RunFailureInput {
  readonly state: unknown;
  readonly failureCategory: unknown;
  readonly attempt: unknown;
}

/**
 * An attempt count from a database column. Degrades to the honest floor of 1 rather than producing nonsense.
 *
 * NOT CLAMPED to the cap. An earlier version returned `Math.min(value, max)`, so a seventh attempt was reported as
 * "3 of 3" while the audit event recorded attempt 7 — a wrong number rather than a bounded one, and a disagreement
 * between the screen and the trail. If the count exceeds the cap that is a fact worth showing, and `nextAttempt`
 * already reports `exhausted` for it.
 */
function usableAttempt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 1;
  return value;
}

/**
 * Describe a failed run completely, or return `null` if it did not fail.
 *
 * TOTAL: there is no input for which this throws or leaves a field empty. `null` is reserved for the one honest
 * "no answer" — a run that has not failed — because describing a running run as a failure would be its own kind of
 * blank: a complete answer to a question nobody asked.
 */
export function describeRunFailure(input: RunFailureInput, policy: RetryPolicy = DEFAULT_RETRY_POLICY): RunFailureDetail | null {
  if (input?.state !== 'failed') return null;

  // An unrecognised stored value becomes `unknown` rather than being echoed: it could be provider text, a future
  // category, or anything at all, and none of those should reach a founder or leave the boundary unbounded.
  //
  // EXACT MATCH, no trimming. The database CHECK restricts this column to the closed set, so a value with stray
  // whitespace cannot have been written legitimately — its presence means something bypassed the constraint.
  // Normalizing it would quietly repair evidence of that; reporting `unknown` says what we actually know.
  const category: ReportedFailureCategory = isRunFailureCategory(input.failureCategory) ? input.failureCategory : 'unknown';

  // A MALFORMED POLICY IS EXHAUSTED, not the default. Review pass 1 proved by execution that substituting the
  // default here made this module fail OPEN while `classifyRetryOutcome` — the function that actually governs
  // retries — fails CLOSED on the same input: a caller disabling retries with `maxAttempts: 0` was shown
  // "another attempt is possible" by one and dead-lettered by the other. Two boundaries disagreeing about money-
  // adjacent behaviour is worse than either answer, and the safe direction is the engine's.
  const boundedPolicy = Number.isInteger(policy?.maxAttempts) && policy.maxAttempts > 0;
  const attemptsAllowed = boundedPolicy ? policy.maxAttempts : DEFAULT_RETRY_POLICY.maxAttempts;
  const attemptsUsed = usableAttempt(input.attempt);

  const eligible = RETRY_ELIGIBLE_CATEGORIES.includes(category);
  const nextAttempt: NextAttempt = !eligible ? 'not_eligible' : !boundedPolicy || attemptsUsed >= attemptsAllowed ? 'exhausted' : 'retry_eligible';

  return {
    category,
    summary: FAILURE_SUMMARIES[category],
    attemptsUsed,
    attemptsAllowed,
    // UNSAFE unless canon says otherwise — including for `unknown`, because a cause we cannot name is a cause we
    // certainly cannot call harmless to repeat.
    retrySafety: category !== 'unknown' && RETRY_SAFE_CATEGORIES.includes(category) ? 'safe' : 'unsafe',
    nextAttempt,
  };
}

/** Re-exported so a caller pinning the summary map against the category set does not need two imports. */
export { RUN_FAILURE_CATEGORIES };
