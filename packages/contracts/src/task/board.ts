// @acbp/contracts — the task board projection (ACBP-P4-004; CDR-042; TASK-001 views). Zero-dep, provider-neutral.
//
// TASK-001 names six states — To Do, Recurring, In Progress, Completed, Rejected, Failed (plus Cancelled) — while
// ACBP-P4-002 implemented ELEVEN internal states and server-enforced transitions. That is not a contradiction: the
// backlog scopes this ticket to `TASK-001 (views)`, and `raw-audit/evidence/task-states.csv` records four of the six
// as EMPTY TABS ("existence observed; instances unknown"). What was directly observed is a set of board TABS, not six
// persisted states.
//
// So this module is a PROJECTION from the internal machine onto the observed buckets. It defines no state, no
// transition and no storage: inventing a `recurring` or `rejected` state to make the wording literally true would
// fabricate a mechanism the evidence never observed (CDR-042 §2).
import { isTaskState } from './task.js';
import type { TaskDTO } from './task.js';

/**
 * The board's buckets, in the order the reference product showed them, then the two this platform must add to stay
 * honest: `cancelled` (named by TASK-001 itself) and `held` (see {@link placeOnBoard}).
 */
export const TASK_BOARD_BUCKETS = ['to_do', 'recurring', 'in_progress', 'completed', 'rejected', 'failed', 'cancelled', 'held'] as const;
export type TaskBoardBucket = (typeof TASK_BOARD_BUCKETS)[number];
export function isTaskBoardBucket(v: unknown): v is TaskBoardBucket {
  return typeof v === 'string' && (TASK_BOARD_BUCKETS as readonly string[]).includes(v);
}

/**
 * Whether a bucket can hold anything IN THIS VERSION.
 *
 * Two cannot, for different reasons, and both say so rather than rendering as an ordinary empty column:
 *   - `recurring` — nothing can enter it at all. Recurrence is `PLAN-003` (recurring scheduled planning cycles) and
 *     `TASK-003` (scheduled autonomous work windows), and BOTH are Post-MVP.
 *   - `rejected` — the reject CONTROL is ACBP-P4-005 (TASK-008), which has not landed.
 *
 * Omitting them would misrepresent the product as lacking the concept; showing them unlabelled would imply the owner
 * simply has no such work. Neither is true, so the distinction is surfaced (CDR-042 §3-G2/G3).
 */
export const BUCKET_AVAILABILITY: Readonly<Record<TaskBoardBucket, 'available' | 'not_in_this_version'>> = {
  to_do: 'available',
  recurring: 'not_in_this_version',
  in_progress: 'available',
  completed: 'available',
  rejected: 'not_in_this_version',
  failed: 'available',
  cancelled: 'available',
  held: 'available',
};

/**
 * Where a task sits on the board.
 *
 * `off_board` is a first-class answer, not an absence: a `draft` is the planning PREVIEW, deliberately not on the
 * board (CDR-033 §4, CDR-040 §2), and saying so is different from failing to classify it. `unknown` is the
 * fail-honest branch — an unrecognized value is NEVER folded into a healthy bucket (the `toTaskDisplayPhase`
 * precedent), because a task shown as fine when we cannot tell is worse than one shown as unclassifiable.
 */
export type BoardPlacement =
  | { readonly kind: 'bucket'; readonly bucket: TaskBoardBucket }
  | { readonly kind: 'off_board'; readonly reason: 'draft' }
  | { readonly kind: 'unknown' };

const IN_BUCKET = (bucket: TaskBoardBucket): BoardPlacement => ({ kind: 'bucket', bucket });

/**
 * Project one internal state onto the board. TOTAL over `TASK_STATES` — every state resolves to a bucket or to an
 * explicit `off_board`, so a task can never silently vanish from every column. A task in the wrong bucket is a bug;
 * a task in no bucket is invisible, which is worse.
 *
 * The HELD states get their own bucket rather than being counted as In Progress. A task waiting on the owner, on an
 * approval, or on a policy decision is STALLED, not progressing — folding it into In Progress would make the exact
 * situation the Decision Room exists to surface indistinguishable from healthy running work, and TASK-001's failure
 * clause ("stuck tasks time out to Failed with reason") shows canon treats stuck-ness as first-class (CDR-042 §3-G4).
 */
export function placeOnBoard(state: unknown): BoardPlacement {
  // Narrow BEFORE the switch. Switching on `state as TaskState` would never narrow `state` itself, so the `default`
  // branch could not be exhaustiveness-checked — the switch would compile happily after a twelfth state was added.
  if (!isTaskState(state)) return { kind: 'unknown' };
  switch (state) {
    // The planning preview: accepted work only reaches the board via `planTask` (draft -> planned).
    case 'draft':
      return { kind: 'off_board', reason: 'draft' };
    // "To Do" was observed as "queued task" — work accepted and awaiting a start.
    case 'planned':
    case 'queued':
      return IN_BUCKET('to_do');
    case 'running':
      return IN_BUCKET('in_progress');
    case 'waiting_for_input':
    case 'waiting_for_approval':
    case 'blocked_by_policy':
    case 'paused':
      return IN_BUCKET('held');
    case 'completed':
      return IN_BUCKET('completed');
    case 'failed':
      return IN_BUCKET('failed');
    // Cancelled is NOT failed: one is the owner's choice, the other is the platform falling over. Merging them would
    // make the platform look less reliable than it is, or hide a real failure behind a deliberate stop.
    case 'cancelled':
      return IN_BUCKET('cancelled');
    default: {
      // COMPILE-EXHAUSTIVE: a `TaskState` no case above handles is assigned to `never`, so adding a twelfth state
      // FAILS THE BUILD here rather than silently routing it to `unknown` and into the board's `unplaceable` counter.
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * Is this task blocked by its dependencies? DERIVED from the prerequisites' states, never stored — a stored flag
 * would drift from the edges it summarizes (the `isFullyExplained` precedent, CDR-041).
 *
 * Only `completed` satisfies a prerequisite. A `failed` or `cancelled` prerequisite is terminal but NOT satisfied:
 * the dependency exists because the work was needed, and a prerequisite that never delivered it leaves the dependent
 * task just as unable to proceed. Treating "terminal" as "done" would silently unblock work whose input never arrived.
 *
 * An unrecognized prerequisite state BLOCKS (fail closed): if we cannot tell whether the input arrived, claiming the
 * task is ready is the dishonest direction.
 */
export function isDependencyBlocked(prerequisiteStates: readonly unknown[]): boolean {
  return prerequisiteStates.some((s) => s !== 'completed');
}

/** One task as the board shows it: the redacted task plus its dependency edges and the DERIVED blocked indicator. */
export interface BoardTaskDTO {
  readonly task: TaskDTO;
  /** Prerequisites — this task depends on these. */
  readonly dependsOnTaskIds: readonly string[];
  /** Dependents — these wait on this task. Surfaced so an owner can see the cost of a stuck task. */
  readonly blocksTaskIds: readonly string[];
  readonly dependencyBlocked: boolean;
}

export interface BoardBucketDTO {
  readonly bucket: TaskBoardBucket;
  readonly availability: 'available' | 'not_in_this_version';
  readonly tasks: readonly BoardTaskDTO[];
}

export interface TaskBoardDTO {
  /** Every bucket, always — including the unavailable ones, which state why they are empty. */
  readonly buckets: readonly BoardBucketDTO[];
  readonly counts: BoardCounts;
  /**
   * Drafts held OFF the board (CDR-033 §4). Counted rather than hidden: an owner who generated a plan and sees an
   * empty board deserves to know the drafts exist and are awaiting confirmation.
   */
  readonly draftsOffBoard: number;
  /**
   * Tasks whose state this version could not classify. Should always be 0; surfaced so that if it is ever non-zero
   * the board says so instead of quietly showing fewer tasks than the company has.
   */
  readonly unplaceable: number;
  /** True when the task list was truncated by `limit` — the board is a page, and says so rather than implying totality. */
  readonly truncated: boolean;
}

/** A zero count for every bucket, so a bucket is never simply absent from a rendered board. */
export type BoardCounts = Record<TaskBoardBucket, number>;
export function emptyBoardCounts(): BoardCounts {
  // Built fresh per call: a shared mutable zero map would leak counts between companies.
  const counts = {} as BoardCounts;
  for (const bucket of TASK_BOARD_BUCKETS) counts[bucket] = 0;
  return counts;
}
