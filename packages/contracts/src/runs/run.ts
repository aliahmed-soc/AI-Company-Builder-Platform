// @acbp/contracts — the task-run lifecycle (ACBP-P5-002; CDR-053; TASK-007; NFR-005; ADR-008). Zero-dep and PURE:
// the clock is a PARAMETER, never read here, so every liveness decision is reproducible and testable.
//
// A RUN IS ONE EXECUTION ATTEMPT OF A TASK, which is why `attempt` is part of its identity and why its state set is
// small. The richer set in WORKFLOW-STATE-MACHINES §4 — waiting_for_input, waiting_for_approval, blocked_by_policy,
// paused — are TASK states (each emits a `task.*` event) owned by P4-002's `tasks.state`. Collapsing the two would
// make "which attempt failed, and why?" unanswerable. See CDR-053 §2.
import { isTaskState, isLegalTaskTransition } from '../task/task.js';

/** CLOSED. `DATA-ARCHITECTURE`: "queued→running→succeeded/failed/cancelled". */
export const RUN_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RunState = (typeof RUN_STATES)[number];

/** States a run never leaves. A retried task gets a NEW run with the next attempt number. */
export const RUN_TERMINAL_STATES = ['succeeded', 'failed', 'cancelled'] as const satisfies readonly RunState[];

/** Why a run failed. CLOSED — a category, never provider or worker exception text. `worker_lost` is canon's. */
export const RUN_FAILURE_CATEGORIES = ['worker_lost', 'timeout', 'provider_error', 'policy_blocked', 'internal_error'] as const;
export type RunFailureCategory = (typeof RUN_FAILURE_CATEGORIES)[number];

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value);
}
export function isTerminalRunState(value: unknown): boolean {
  return typeof value === 'string' && (RUN_TERMINAL_STATES as readonly string[]).includes(value);
}
export function isRunFailureCategory(value: unknown): value is RunFailureCategory {
  return typeof value === 'string' && (RUN_FAILURE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The CLOSED transition table. Deny-by-default: an unlisted pair is refused, and an unknown state is refused rather
 * than treated as permissive.
 *
 * A QUEUED run cannot succeed or fail — it never ran, so it has no outcome to report; the only way out is
 * cancellation. Nothing leaves a terminal state.
 */
const ALLOWED: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransitionRun(from: unknown, to: unknown): boolean {
  if (!isRunState(from) || !isRunState(to)) return false;
  return ALLOWED[from].includes(to);
}

/**
 * What cancelling a run in this state MEANS — the acceptance clause's two halves, kept distinct on purpose.
 *
 * *"Cancel queued instant; running safe-stop bounded"*. A queued run has not started, so cancellation is immediate
 * and total. A running run is mid-flight, so cancellation is a REQUEST the worker honours at its next safe point
 * (§4: "current tool call completes/aborts safely, then halt"). Modelling both as one operation would either make
 * queued cancellation wait on a worker that may never answer, or make running cancellation abandon work mid-call.
 */
export type CancellationKind = { readonly kind: 'immediate' } | { readonly kind: 'safe_stop_requested' } | { readonly kind: 'already_terminal' };

export function classifyCancellation(state: unknown): CancellationKind {
  if (state === 'queued') return { kind: 'immediate' };
  if (state === 'running') return { kind: 'safe_stop_requested' };
  // Terminal, or unrecognised. Both answer "there is nothing here to cancel", which is the safe direction: the
  // alternative would be attempting to stop something whose state we do not understand.
  return { kind: 'already_terminal' };
}

/**
 * May an execution attempt be STARTED for a task in this state? (review pass 2.)
 *
 * A run is one attempt at a task, so a task that cannot be executing must not acquire one. Without this, a coordinator
 * would happily claim an attempt against a `completed`, `failed` or `cancelled` task and put it straight into
 * `running` — the AI beginning work the owner already finished or called off.
 *
 * DERIVED from canon's own task transition table rather than restated as a list: startable means the task is already
 * `running` (a retry attempt while the task itself stays running) or can legally reach `running` from where it is. A
 * hand-copied set would silently go wrong the day a twelfth task state is added; this cannot.
 *
 * Deny-by-default: an unknown or non-string state is never startable.
 */
export function canStartRunForTask(taskState: unknown): boolean {
  if (!isTaskState(taskState)) return false;
  return taskState === 'running' || isLegalTaskTransition(taskState, 'running');
}

/**
 * The bounded grace after which a silent run is presumed lost (FAILURE-AND-RECOVERY: *"bounded grace"*).
 * Ninety seconds is long enough to survive a slow step or a brief pause, short enough that a dead worker's task does
 * not sit unreclaimed for minutes.
 */
export const DEFAULT_HEARTBEAT_GRACE_MS = 90_000;

export interface RunLivenessInput {
  readonly state: string;
  readonly lastHeartbeatAt: Date | null;
  /** When the run went `running`. Used before the first heartbeat arrives. */
  readonly startedAt?: Date | null;
}

/**
 * Is this run lost? A pure comparison of timestamps, deliberately NOT a background timer.
 *
 * Liveness is a timestamp the worker advances, and lostness is a question any reader can answer by looking. A timer
 * would live in some process — and the process most likely to die is the one running the work, which is exactly the
 * failure this exists to detect (CDR-053 §3-G4).
 *
 * FAILS CLOSED: a running run with neither a heartbeat nor a start time has unknown liveness, and unknown liveness is
 * treated as lost. The cost of being wrong is a reclaimed run that gets retried; the cost of the opposite is a task
 * wedged forever behind a worker that is never coming back.
 */
export function isRunLost(input: RunLivenessInput, now: Date, graceMs: number = DEFAULT_HEARTBEAT_GRACE_MS): boolean {
  // Only a RUNNING run has liveness to lose. A queued run is waiting for pickup; a terminal one already reported.
  if (input.state !== 'running') return false;
  // ACBP-P7-008 MUTATION PROBE - DO NOT MERGE: no silent worker is ever past the grace.
  const grace = (Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : DEFAULT_HEARTBEAT_GRACE_MS) * 1e9;
  const reference = input.lastHeartbeatAt ?? input.startedAt ?? null;
  if (reference === null) return true;
  const referenceMs = reference.getTime();
  if (!Number.isFinite(referenceMs)) return true;
  // A heartbeat in the future (clock skew) yields a negative age, which is < grace, so the run reads as alive rather
  // than producing nonsense. The grace is bounded and a sane clock resolves it; what must not happen is a crash.
  return now.getTime() - referenceMs > grace;
}
