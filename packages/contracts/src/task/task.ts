// @acbp/contracts — provider-neutral task lifecycle contract (ACBP-P4-002; CDR-033; TASK-001; ADR-008;
// WORKFLOW-STATE-MACHINES §4). Transport- and provider-neutral; zero-dependency like the rest of @acbp/contracts.
//
// Defines WHAT a task is at the contract level: the CLOSED, canonical state set, the server-enforced legal-transition
// map (so illegal transitions are rejected uniformly — TASK-001 "invalid transitions are rejected and audited"), the
// honest display projection, and the redacted client DTO. It knows nothing about execution (durable runs, credit
// reservation, policy, workers) — those effects live in later P5/P6 tickets. The FULL machine is defined now so every
// illegal transition is rejected from day one (the `interview.ts` precedent); P4-002 implements only the effect-free
// pre-execution transitions (create→draft, draft→planned).

/**
 * The CLOSED, canonical task states (WORKFLOW §4, verbatim). Core lifecycle `draft → planned → queued → running →
 * completed | failed | cancelled` plus the four holds `waiting_for_input`, `waiting_for_approval`, `blocked_by_policy`,
 * `paused`. Order is canonical; it is NOT used for comparison (transitions are explicit, not ordinal).
 */
export type TaskState =
  | 'draft'
  | 'planned'
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'blocked_by_policy'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
export const TASK_STATES: readonly TaskState[] = ['draft', 'planned', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused', 'completed', 'failed', 'cancelled'];
export function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && (TASK_STATES as readonly string[]).includes(value);
}

/** The state a newly-created task is minted with (server-selected). `planTask` then performs `draft → planned`. */
export const INITIAL_TASK_STATE: TaskState = 'draft';

/**
 * Server-enforced legal transitions (WORKFLOW §4). An unlisted `(from, to)` pair is illegal and MUST be rejected +
 * auditable (TASK-001 "transition-table conformance 100%"). Terminal states have no outgoing transition.
 * `blocked_by_policy → running` is the documented resume ("not retryable until policy/limits change", WORKFLOW §4).
 */
const LEGAL_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ['planned'],
  planned: ['queued'],
  queued: ['running', 'cancelled'],
  running: ['waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused', 'completed', 'failed', 'cancelled'],
  waiting_for_input: ['running'],
  waiting_for_approval: ['running', 'cancelled'],
  blocked_by_policy: ['running'],
  paused: ['running'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** True IFF `from → to` is a legal task transition. Deny-by-default: unknown states yield false. */
export function isLegalTaskTransition(from: TaskState, to: TaskState): boolean {
  const allowed = LEGAL_TRANSITIONS[from] as readonly TaskState[] | undefined;
  return allowed !== undefined && allowed.includes(to);
}

/** The legal successor states of `from` (a defensive copy; empty for a terminal state). */
export function legalTaskSuccessors(from: TaskState): readonly TaskState[] {
  return [...(LEGAL_TRANSITIONS[from] ?? [])];
}

/** A task is OPEN while it is not in a terminal state (`completed`/`failed`/`cancelled`). */
export function isTerminalTaskState(state: TaskState): boolean {
  return legalTaskSuccessors(state).length === 0;
}
/**
 * The terminal states, DERIVED from the transition table rather than restated. Consumers that need the closed set as
 * data (e.g. a SQL `not in (...)` filter) must use this — a hand-copied list silently misclassifies a task as "open"
 * the day a terminal state is added.
 */
export const TERMINAL_TASK_STATES: readonly TaskState[] = TASK_STATES.filter((s) => legalTaskSuccessors(s).length === 0);

export function isOpenTaskState(state: TaskState): boolean {
  return !isTerminalTaskState(state);
}

/** A task is HELD (visibly paused, awaiting an external resolution) in one of the four hold states. */
const HOLD_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused']);
export function isTaskHold(state: TaskState): boolean {
  return HOLD_STATES.has(state);
}

/**
 * Honest display projection (transparency; mirrors the interview/company precedent). Maps the raw state to a
 * client-facing phase; an unrecognized value renders as `'unknown'` — NEVER a fabricated healthy phase.
 */
export type TaskDisplayPhase = 'draft' | 'planned' | 'queued' | 'running' | 'held' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export function toTaskDisplayPhase(state: unknown): TaskDisplayPhase {
  switch (state) {
    case 'draft':
      return 'draft';
    case 'planned':
      return 'planned';
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'waiting_for_input':
    case 'waiting_for_approval':
    case 'blocked_by_policy':
    case 'paused':
      return 'held';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

/** Bounds (also the DB column widths in migration 0021). */
export const TASK_TITLE_MAX = 200;
export const TASK_DESCRIPTION_MAX = 4_000;

/**
 * The redacted, client-facing task view. Exposes ONLY approved fields — no accountId, actor/membership ids, internal
 * SQL errors, stack traces, or secrets. Timestamps are ISO-8601 strings.
 */
export interface TaskDTO {
  readonly taskId: string;
  readonly companyId: string;
  readonly state: TaskState;
  readonly phase: TaskDisplayPhase;
  readonly title: string;
  readonly description: string | null;
  readonly milestoneId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
