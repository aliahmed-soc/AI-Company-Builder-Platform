/*
 * ACBP-FE-014 — the task board, mapped without undoing the contract's honesty.
 *
 * `TaskBoardDTO` states five things a board screen normally throws away, and each one exists because the
 * server refused to let an absence pass for an answer:
 *
 *   availability    — `recurring` and `rejected` are `not_in_this_version`. An empty column there does NOT
 *                     mean "no tasks of this kind"; it means nothing was built to put any there. Two empty
 *                     columns, two meanings, and only one of them is a fact about this company.
 *   draftsOffBoard  — drafts are held OFF the board by design (CDR-033 §4). An owner who generated a plan and
 *                     sees an empty board must be told the drafts exist, or they conclude planning failed.
 *   unplaceable     — the DTO's own words: "Should always be 0; surfaced so that if it is ever non-zero the
 *                     board says so instead of quietly showing fewer tasks than the page contained."
 *   truncated       — the board is a PAGE.
 *   counts          — a per-bucket total that can exceed the rows actually sent.
 *
 * SO THE COUNT AN UNAVAILABLE BUCKET GETS IS AN EM DASH, NOT A ZERO — the same rule the Decision Room's
 * tri-state sections follow, for the same reason: a zero is an answer, and the server did not give one.
 */
import { BUCKET_AVAILABILITY, TASK_BOARD_BUCKETS } from '@acbp/contracts';
import type { BoardTaskDTO, TaskBoardBucket, TaskBoardDTO } from '@acbp/contracts';

export type BucketTone = 'has_tasks' | 'empty' | 'unavailable';

export interface BoardRowView {
  readonly taskId: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: string;
  readonly phase: string;
  /** `null` when the task was not produced by planning. Otherwise "1st in the plan" — a RANK, not a score. */
  readonly rankLabel: string | null;
  /** "Not stated" rather than a guess, when the planner recorded no type (TASK-002 / ADR-019). */
  readonly taskTypeLabel: string;
  readonly dependencyBlocked: boolean;
  readonly dependsOnCount: number;
  readonly blocksCount: number;
  readonly milestoneId: string | null;
}

export interface BucketView {
  readonly bucket: TaskBoardBucket;
  readonly label: string;
  readonly tone: BucketTone;
  /** The server's total for this bucket, or null when the bucket cannot hold anything in this version. */
  readonly count: number | null;
  /** What to show where a number goes. An em dash when there is no number to give. */
  readonly countLabel: string;
  /** How many rows were actually sent. Not the same claim as `count`. */
  readonly shownCount: number;
  readonly countMismatch: boolean;
  readonly note: string;
  readonly tasks: readonly BoardRowView[];
}

export interface BoardView {
  readonly buckets: readonly BucketView[];
  /** Summed over AVAILABLE buckets only — an unavailable one contributes nothing it could have. */
  readonly totalOnBoard: number;
  readonly isEmpty: boolean;
  readonly emptyNote: string;
  readonly draftsOffBoard: number;
  readonly unplaceable: number;
  /** Non-null only when the board is knowingly showing less than the server had. */
  readonly integrityWarning: string | null;
  readonly truncated: boolean;
}

function labelForBucket(bucket: string): string {
  return bucket.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * "1st in the plan" from rank 0.
 *
 * THE CONTRACT IS EXPLICIT THAT THIS IS NOT A SCALE: "The planning RANK (0 = first) ... Not a scale."
 * Rendering it raw shows a founder "Priority: 0" for the MOST important task, which reads as none at all.
 */
function rankLabelFor(priority: number | null): string | null {
  if (priority === null) return null;
  const n = priority + 1;
  const rem100 = n % 100;
  const rem10 = n % 10;
  const suffix = rem100 >= 11 && rem100 <= 13 ? 'th' : rem10 === 1 ? 'st' : rem10 === 2 ? 'nd' : rem10 === 3 ? 'rd' : 'th';
  return `${String(n)}${suffix} in the plan`;
}

function toRowView(row: BoardTaskDTO): BoardRowView {
  return {
    taskId: row.task.taskId,
    title: row.task.title,
    description: row.task.description,
    state: row.task.state,
    phase: row.task.phase,
    rankLabel: rankLabelFor(row.task.priority),
    taskTypeLabel: row.task.taskType ?? 'Not stated',
    dependencyBlocked: row.dependencyBlocked,
    dependsOnCount: row.dependsOnTaskIds.length,
    // BOTH DIRECTIONS. The DTO surfaces dependents "so an owner can see the cost of a stuck task", which is
    // invisible if only the task's own blockers are shown.
    blocksCount: row.blocksTaskIds.length,
    milestoneId: row.task.milestoneId,
  };
}

export function toBoardView(board: TaskBoardDTO): BoardView {
  const byBucket = new Map(board.buckets.map((b) => [b.bucket, b]));

  // ITERATED OVER THE CONTRACT'S BUCKET LIST, not over what the server happened to send: "Every bucket,
  // always — including the unavailable ones, which state why they are empty." A bucket missing from the
  // response must still appear, or the board silently narrows.
  const buckets: readonly BucketView[] = TASK_BOARD_BUCKETS.map((bucket) => {
    const dto = byBucket.get(bucket);
    const availability = dto?.availability ?? BUCKET_AVAILABILITY[bucket];
    const tasks = (dto?.tasks ?? []).map(toRowView);
    const label = labelForBucket(bucket);

    if (availability === 'not_in_this_version') {
      return {
        bucket,
        label,
        tone: 'unavailable' as const,
        // NULL, NOT ZERO. A zero would say the server looked and found none.
        count: null,
        countLabel: '—',
        shownCount: tasks.length,
        countMismatch: false,
        note: 'This part of the board is not built in this version of the platform. It is empty because nothing can reach it yet, which is not the same as there being none.',
        tasks,
      };
    }

    const count = board.counts[bucket];
    return {
      bucket,
      label,
      tone: tasks.length > 0 ? ('has_tasks' as const) : ('empty' as const),
      count,
      countLabel: String(count),
      shownCount: tasks.length,
      // The server's total and the rows it sent are two claims. When they disagree the list is a sample.
      countMismatch: count !== tasks.length,
      note: tasks.length === 0 ? 'Nothing is in this part of the board.' : '',
      tasks,
    };
  });

  const totalOnBoard = TASK_BOARD_BUCKETS.filter((b) => BUCKET_AVAILABILITY[b] === 'available').reduce((n, b) => n + board.counts[b], 0);
  const isEmpty = buckets.every((b) => b.tasks.length === 0) && totalOnBoard === 0;

  return {
    buckets,
    totalOnBoard,
    isEmpty,
    emptyNote: isEmpty
      ? board.draftsOffBoard > 0
        ? `Nothing is on the board yet, but ${String(board.draftsOffBoard)} planned ${board.draftsOffBoard === 1 ? 'task is' : 'tasks are'} waiting as a draft. Drafts are held off the board until they are confirmed — the plan was produced, it is just not live work yet.`
        : 'Nothing is on the board, and no drafts are waiting either.'
      : '',
    draftsOffBoard: board.draftsOffBoard,
    unplaceable: board.unplaceable,
    // THE ONE WARNING THAT IS ABOUT THE BOARD ITSELF rather than about the company's work.
    integrityWarning:
      board.unplaceable > 0
        ? `${String(board.unplaceable)} ${board.unplaceable === 1 ? 'task' : 'tasks'} could not be placed in any part of the board, so this shows fewer tasks than the server actually returned. That is a defect rather than a state of your plan.`
        : null,
    truncated: board.truncated,
  };
}
