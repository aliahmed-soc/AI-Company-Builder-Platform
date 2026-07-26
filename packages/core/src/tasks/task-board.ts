// @acbp/core — the task board (ACBP-P4-004; CDR-042; TASK-001 views).
//
// A pure READ. It adds no state, no transition, no audit event and no storage: TASK-001's six buckets are a VIEW over
// the eleven-state machine P4-002 already built (CDR-042 §2), so everything here is projection and derivation.
//
// The board renders EVERY bucket, including the two that cannot hold anything in this version. Rendering only the
// populated ones would let the board silently change shape as work moves, and would hide that `recurring` and
// `rejected` are unavailable rather than merely empty.
import { TaskRepository, type DatabaseClient, type TaskRow, type TaskDependencyRow } from '@acbp/database';
import {
  TASK_BOARD_BUCKETS,
  BUCKET_AVAILABILITY,
  placeOnBoard,
  isDependencyBlocked,
  emptyBoardCounts,
  type BoardBucketDTO,
  type BoardTaskDTO,
  type TaskBoardDTO,
  type TaskBoardBucket,
} from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { toTaskDTO } from './task-management.js';
import type { Logger } from '@acbp/observability';

export interface GetTaskBoardParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** Bounded page over the company's tasks. The board reports `truncated` rather than implying it showed everything. */
  readonly limit?: number;
}
export interface TaskBoardOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}
export type GetTaskBoardResult = { readonly status: 'ok'; readonly board: TaskBoardDTO } | { readonly status: 'forbidden' };

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * Assemble the board from the task rows and the company's dependency edges.
 *
 * Exported and model-free so the projection can be tested without a database: every honesty property here (totality,
 * the derived blocked flag, the off-board draft count) is a pure function of its inputs.
 */
export function buildTaskBoard(rows: readonly TaskRow[], edges: readonly TaskDependencyRow[], truncated: boolean): TaskBoardDTO {
  // Edge indexes. Both directions are built because the board shows what a task waits on AND what waits on it — a
  // stuck task's true cost is the set of tasks behind it, which is invisible from the prerequisite direction alone.
  const dependsOn = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  for (const e of edges) {
    (dependsOn.get(e.task_id) ?? dependsOn.set(e.task_id, []).get(e.task_id)!).push(e.depends_on_task_id);
    (blocks.get(e.depends_on_task_id) ?? blocks.set(e.depends_on_task_id, []).get(e.depends_on_task_id)!).push(e.task_id);
  }

  // Prerequisite states are read from the SAME page of rows. A prerequisite outside the page is deliberately treated
  // as unknown by `isDependencyBlocked` (fail closed) rather than assumed complete: claiming a task is ready because
  // we did not fetch its prerequisite would be the dishonest direction.
  const stateById = new Map<string, string>(rows.map((r) => [r.id, r.state]));

  const byBucket = new Map<TaskBoardBucket, BoardTaskDTO[]>(TASK_BOARD_BUCKETS.map((b) => [b, []]));
  const counts = emptyBoardCounts();
  let draftsOffBoard = 0;
  let unplaceable = 0;

  for (const row of rows) {
    const placed = placeOnBoard(row.state);
    if (placed.kind === 'off_board') {
      draftsOffBoard += 1;
      continue;
    }
    if (placed.kind === 'unknown') {
      unplaceable += 1;
      continue;
    }
    const prerequisites = dependsOn.get(row.id) ?? [];
    byBucket.get(placed.bucket)!.push({
      task: toTaskDTO(row),
      dependsOnTaskIds: prerequisites,
      blocksTaskIds: blocks.get(row.id) ?? [],
      // `stateById.get` returns undefined for a prerequisite outside this page — which blocks, by design.
      dependencyBlocked: isDependencyBlocked(prerequisites.map((id) => stateById.get(id))),
    });
    counts[placed.bucket] += 1;
  }

  const buckets: BoardBucketDTO[] = TASK_BOARD_BUCKETS.map((bucket) => ({
    bucket,
    availability: BUCKET_AVAILABILITY[bucket],
    tasks: byBucket.get(bucket)!,
  }));
  return { buckets, counts, draftsOffBoard, unplaceable, truncated };
}

/**
 * The company's task board (owner + viewer, `task:read`). RLS-confined: a foreign company's tasks and edges are
 * invisible, not filtered out in application code.
 */
export async function getTaskBoard(client: DatabaseClient, params: GetTaskBoardParams, options: TaskBoardOptions = {}): Promise<GetTaskBoardResult> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(options.logger !== undefined ? { logger: options.logger } : {}) };

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetTaskBoardResult> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const tasks = new TaskRepository(scope.db);
      // Read one MORE than the limit purely to detect truncation honestly, then drop it. Reporting `truncated` from
      // `rows.length === limit` would false-positive on a company holding exactly `limit` tasks.
      const rows = await tasks.list({ limit: limit + 1 });
      const truncated = rows.length > limit;
      const page = truncated ? rows.slice(0, limit) : rows;
      const edges = await tasks.listAllDependencies(params.companyId);
      return { status: 'ok', board: buildTaskBoard(page, edges, truncated) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
