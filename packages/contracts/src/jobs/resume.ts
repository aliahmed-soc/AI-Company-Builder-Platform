// @acbp/contracts — resume arithmetic (ACBP-P5-001b; CDR-050 §2-G3; NFR-005). Zero-dep and PURE: no database, no
// clock, no job. Resume is a computation over two lists, so it is testable exhaustively without a running job at all.
//
// Canon's sentence is "checkpoint inventory **vs plan**" (FAILURE-AND-RECOVERY row 12), and this is that made
// executable: the caller supplies the ordered plan, the store supplies the completed step names, and what remains is
// the difference. There is deliberately NO stored cursor — a cursor and the checkpoint set can disagree, and then two
// sources both claim to know what ran, which is precisely the ambiguity a resume must not have.

/** A step name that could not be checkpointed, which means a plan containing it must not be started. */
export type PlanFailure = 'duplicate_step' | 'blank_step';

export class InvalidPlanError extends Error {
  readonly reason: PlanFailure;
  constructor(reason: PlanFailure, detail: string) {
    super(`invalid job plan (${reason}): ${detail}`);
    this.name = 'InvalidPlanError';
    this.reason = reason;
  }
}

/**
 * A plan must be checkpointable, and this THROWS rather than returning a result because an uncheckpointable plan is a
 * programming error at the call site, not a runtime condition a caller chooses how to handle.
 *
 * Two steps cannot share a name: the checkpoint key is `(job_id, step_name)`, so completing the first would mark the
 * second complete too, and the second would be skipped forever. That is silent work loss — the mirror image of the
 * double execution this whole sub-scope exists to prevent, and just as bad.
 */
function assertCheckpointablePlan(plan: readonly string[]): void {
  const seen = new Set<string>();
  for (const step of plan) {
    if (typeof step !== 'string' || step.trim().length === 0) {
      throw new InvalidPlanError('blank_step', 'every step needs a non-blank name');
    }
    if (seen.has(step)) {
      throw new InvalidPlanError('duplicate_step', `step "${step}" appears more than once`);
    }
    seen.add(step);
  }
}

/**
 * The steps that still have to run, in PLAN order.
 *
 * Plan order, not checkpoint order: checkpoints arrive in completion order, which after a resume need not match the
 * plan, and a resumed job must execute in the same sequence a fresh one would.
 *
 * Each completed step removes EXACTLY ITSELF — never "everything up to here". A step completed out of plan order (a
 * retry that skipped ahead, a manually repaired job) leaves the earlier steps genuinely unrun, and dropping them would
 * silently skip real work. Symmetrically, a checkpoint naming a step this plan no longer contains is IGNORED rather
 * than treated as an error: the plan changed between the crash and the resume, the stale checkpoint is simply true
 * about a step that no longer applies, and refusing to resume would strand a job that is otherwise fine.
 */
export function remainingSteps(plan: readonly string[], completedStepNames: readonly string[]): string[] {
  assertCheckpointablePlan(plan);
  const done = new Set(completedStepNames);
  return plan.filter((step) => !done.has(step));
}

export interface PlanProgress {
  readonly completed: number;
  readonly total: number;
  readonly remaining: number;
  readonly complete: boolean;
}

/**
 * How far a job got, counted against the PLAN.
 *
 * Checkpoints outside the plan do not count toward `completed`: canon requires partial results be "labeled partial"
 * (row 12), and a count inflated by steps this plan does not contain could report a plan complete when steps of it
 * never ran.
 */
export function planProgress(plan: readonly string[], completedStepNames: readonly string[]): PlanProgress {
  const remaining = remainingSteps(plan, completedStepNames).length;
  const total = plan.length;
  return { completed: total - remaining, total, remaining, complete: remaining === 0 };
}

/** Is every planned step checkpointed? An EMPTY plan is trivially complete — there is nothing left to run. */
export function isPlanComplete(plan: readonly string[], completedStepNames: readonly string[]): boolean {
  return remainingSteps(plan, completedStepNames).length === 0;
}
