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
 * `timeout` — row 1 calls a model timeout a *"pure call — safe"*. `worker_lost` — row 4 resumes from checkpointed
 * steps, which are idempotent by design. `provider_error` — row 2/3, the call is safe to repeat.
 *
 * DELIBERATELY SHORT. Anything not listed is reported unsafe, which is the direction that cannot cause a double
 * execution: `policy_blocked` would hit the same policy, and `internal_error` is by definition a state we did not
 * understand, so we cannot promise repeating it is harmless.
 */
export const RETRY_SAFE_CATEGORIES: readonly RunFailureCategory[] = ['timeout', 'worker_lost', 'provider_error'];

/**
 * Which categories are worth retrying at all.
 *
 * A `policy_blocked` run is a DECISION, not a fault — retrying re-runs the same decision. Showing a founder
 * "1 of 3 attempts used" would invite them to wait for a retry that is never coming (CDR-059 G4).
 */
const RETRY_ELIGIBLE_CATEGORIES: readonly ReportedFailureCategory[] = ['timeout', 'worker_lost', 'provider_error'];

/** What happens next. Three real answers, so none of them has to be inferred from a number. */
export type NextAttempt = 'scheduled' | 'exhausted' | 'not_eligible';

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

/** An attempt count from a database column. Degrades to the honest floor of 1 rather than producing nonsense. */
function usableAttempt(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, max);
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

  const attemptsAllowed = Number.isInteger(policy?.maxAttempts) && policy.maxAttempts > 0 ? policy.maxAttempts : DEFAULT_RETRY_POLICY.maxAttempts;
  const attemptsUsed = usableAttempt(input.attempt, attemptsAllowed);

  const eligible = RETRY_ELIGIBLE_CATEGORIES.includes(category);
  const nextAttempt: NextAttempt = !eligible ? 'not_eligible' : attemptsUsed >= attemptsAllowed ? 'exhausted' : 'scheduled';

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
