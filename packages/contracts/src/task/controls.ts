// @acbp/contracts — task detail controls (ACBP-P4-005; CDR-043; TASK-002/TASK-008). Zero-dep, provider-neutral.
//
// TASK-002: "Each task exposes type, creation time, structured description, and CONTROLS APPROPRIATE TO ITS STATE."
// TASK-008: "Tasks can be repeated (re-queued as a new task) or deleted, with confirmation for delete." Its failure
// clause is explicit: "Delete of a running task is refused; cancel first."
//
// THERE IS NO TASK REJECT CONTROL (CDR-043 §2). The backlog Objective's "repeat/delete/reject" is shorthand that
// nothing supports: no requirement defines task rejection (the `reject` verb belongs to UNDER-003, STRAT-003 and
// APPR-007 — different objects), the same backlog row's own Acceptance criteria say "Controls behave per state;
// repeat links lineage", and `raw-audit/04-task-and-agent-system.md` lists task rejection under "Controls not
// exercised" while recording the observed detail controls as Delete, Repeat and (for Todo) Run now. Building it would
// mean inventing a state transition and a user-facing control from one word in a summary field.
import { isTaskState, type TaskState } from './task.js';

/** The controls this ticket defines. `run_now` is TASK-004 (needs the credit preflight) and is NOT here. */
export const TASK_CONTROLS = ['repeat', 'delete'] as const;
export type TaskControl = (typeof TASK_CONTROLS)[number];
export function isTaskControl(v: unknown): v is TaskControl {
  return typeof v === 'string' && (TASK_CONTROLS as readonly string[]).includes(v);
}

/**
 * Why a control is unavailable. A closed set, because a UI has to render these and an open-ended string would become
 * an unreviewable message surface.
 *
 * `cancel_first` is TASK-008's own remedy wording; `not_finished` covers work that has not reached an outcome;
 * `unknown_state` is the fail-closed branch.
 */
export const CONTROL_UNAVAILABLE_REASONS = ['cancel_first', 'not_finished', 'unknown_state'] as const;
export type ControlUnavailableReason = (typeof CONTROL_UNAVAILABLE_REASONS)[number];

/**
 * One control's verdict for one task state. `reason` is non-null EXACTLY when unavailable: a control that is hidden
 * with no explanation is the failure TASK-002's "controls appropriate to its state" exists to prevent — the owner
 * should be told "cancel the running task first", not shown a greyed-out button.
 */
export interface ControlVerdict {
  readonly control: TaskControl;
  readonly available: boolean;
  readonly reason: ControlUnavailableReason | null;
}

/** States in which a task is actively mid-flight, so deleting it would interrupt work already under way. */
const IN_FLIGHT: ReadonlySet<TaskState> = new Set<TaskState>(['running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused']);

/** States in which a task has reached an outcome — the only ones a REPEAT can meaningfully re-run. */
const FINISHED: ReadonlySet<TaskState> = new Set<TaskState>(['completed', 'failed', 'cancelled']);

const OK = (control: TaskControl): ControlVerdict => ({ control, available: true, reason: null });
const NO = (control: TaskControl, reason: ControlUnavailableReason): ControlVerdict => ({ control, available: false, reason });

/**
 * Which controls this state allows, and why not when it does not. TOTAL over `TASK_CONTROLS`: every control gets a
 * verdict for every state, so a UI can always explain itself.
 *
 * DELETE is refused while in-flight — TASK-008's "cancel first". Extended beyond `running` to the four hold states
 * because a task waiting on an approval or blocked by policy is equally mid-flight: it has a place in the queue, may
 * hold resources, and TASK-007 owns bringing it to a safe stop. A `queued` task has not started, so it deletes
 * cleanly.
 *
 * REPEAT requires a FINISHED task. "Re-queued as a new task" is the recovery control the audit observed on a failed
 * task; offering it on work that is still running or still queued would silently create a second task doing the same
 * thing, with no signal to the owner that they now have two.
 *
 * An unrecognized state offers NOTHING. Fail closed: if we cannot tell what the task is doing, offering to delete or
 * duplicate it is the unsafe guess.
 */
export function controlAvailability(state: unknown): readonly ControlVerdict[] {
  if (!isTaskState(state)) return TASK_CONTROLS.map((c) => NO(c, 'unknown_state'));
  return [FINISHED.has(state) ? OK('repeat') : NO('repeat', 'not_finished'), IN_FLIGHT.has(state) ? NO('delete', 'cancel_first') : OK('delete')];
}

/** Just the usable controls, for callers that do not need the reasons. Derived from {@link controlAvailability}. */
export function availableControls(state: unknown): readonly TaskControl[] {
  return controlAvailability(state)
    .filter((v) => v.available)
    .map((v) => v.control);
}
