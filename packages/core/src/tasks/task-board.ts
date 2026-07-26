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
 * Hard cap on dependency edges loaded for one board render.
 *
 * Page-scoping bounds the query's PREDICATE but not its result: one task may carry unlimited edges, and the ids
 * harvested from those rows then feed an `in (...)` state lookup, which fails outright past Postgres' bind-parameter
 * ceiling. Generous enough that no plausible real board reaches it, low enough that a scripted edge explosion cannot
 * turn one cheap read into an unbounded fetch.
 */
const MAX_EDGES = 5_000;

/**
 * Assemble the board from the task rows and the company's dependency edges.
 *
 * Exported and model-free so the projection can be tested without a database: every honesty property here (totality,
 * the derived blocked flag, the off-board draft count) is a pure function of its inputs.
 */
export interface BuildTaskBoardInput {
  /** The page of BOARD rows — drafts are excluded upstream, so the page budget bounds visible work. */
  readonly rows: readonly TaskRow[];
  readonly edges: readonly TaskDependencyRow[];
  /** Drafts held off the board, COUNTED by a separate query rather than paged (CDR-033 §4). */
  readonly draftsOffBoard: number;
  /** States of tasks referenced by edges but absent from `rows` (older prerequisites, or drafts). */
  readonly offPageStates: ReadonlyMap<string, string>;
  readonly truncated: boolean;
}

export function buildTaskBoard(input: BuildTaskBoardInput): TaskBoardDTO {
  const { rows, edges, draftsOffBoard, offPageStates, truncated } = input;

  // Every state we know, page first then off-page resolutions. Built BEFORE the edge indexes so both can consult it.
  const stateById = new Map<string, string>(offPageStates);
  for (const r of rows) stateById.set(r.id, r.state);

  // An id is SHOWABLE when it is a real, non-draft task. CDR-042 §3-G1 keeps drafts off the board, so surfacing
  // `blocksTaskIds: ['<draft-id>']` would put unconfirmed planning-preview work back on it by the side door.
  //
  // This governs DISPLAY ONLY. It must never gate the blocked derivation: filtering a prerequisite out before the
  // derivation makes `isDependencyBlocked([])` return false, so an unresolvable — or merely unconfirmed —
  // prerequisite would UNBLOCK its dependent. That is fail-OPEN, and strictly worse than showing a draft's id: the
  // board would report work as ready to run while its input does not exist yet (violating §3-G7 and §3-G12).
  const showable = (id: string): boolean => {
    const state = stateById.get(id);
    return state !== undefined && state !== 'draft';
  };

  // Both directions: the board shows what a task waits on AND what waits on it — a stuck task's true cost is the set
  // of tasks behind it, which the prerequisite direction alone cannot show. Kept UNFILTERED here; filtering happens
  // per-field below, so the derivation always sees every prerequisite.
  const dependsOn = new Map<string, string[]>();
  const blocks = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const existing = map.get(key);
    if (existing === undefined) map.set(key, [value]);
    else existing.push(value);
  };
  for (const e of edges) {
    push(dependsOn, e.task_id, e.depends_on_task_id);
    // The reverse index is display-only (nothing is derived from it), so a non-showable dependent is dropped here.
    if (showable(e.task_id)) push(blocks, e.depends_on_task_id, e.task_id);
  }

  const byBucket = new Map<TaskBoardBucket, BoardTaskDTO[]>(TASK_BOARD_BUCKETS.map((b) => [b, []]));
  const counts = emptyBoardCounts();
  let unplaceable = 0;

  for (const row of rows) {
    const placed = placeOnBoard(row.state);
    if (placed.kind === 'off_board') {
      // Unreachable: `listBoardPage` filters drafts out. Counted rather than dropped so a future query change cannot
      // make a task silently disappear from both the buckets and the totals.
      unplaceable += 1;
      continue;
    }
    if (placed.kind === 'unknown') {
      unplaceable += 1;
      continue;
    }
    // EVERY prerequisite, including drafts and ids we could not resolve.
    const prerequisites = dependsOn.get(row.id) ?? [];
    byBucket.get(placed.bucket)!.push({
      task: toTaskDTO(row),
      // Filtered for DISPLAY (§3-G14) — the derivation below still sees the full set.
      dependsOnTaskIds: prerequisites.filter(showable),
      blocksTaskIds: blocks.get(row.id) ?? [],
      // Derived over the FULL set: an off-page prerequisite is normally resolved (so this is a fact, not a guess),
      // but a draft prerequisite is not `completed` and therefore blocks, and an id that resolves to nothing at all
      // blocks too. Hiding an id must never change the answer.
      dependencyBlocked: isDependencyBlocked(prerequisites.map((id) => stateById.get(id))),
    });
    counts[placed.bucket] += 1;
  }

  const buckets: BoardBucketDTO[] = TASK_BOARD_BUCKETS.map((bucket) => ({
    bucket,
    availability: BUCKET_AVAILABILITY[bucket],
    tasks: byBucket.get(bucket)!,
  }));
  // Clamped: the count is now an input rather than something derived here, so a caller could otherwise put a
  // negative or fractional value straight into the DTO.
  return { buckets, counts, draftsOffBoard: Math.max(0, Math.trunc(draftsOffBoard)), unplaceable, truncated };
}

/**
 * The company's task board (owner + viewer, `task:read`). RLS-confined: a foreign company's tasks and edges are
 * invisible, not filtered out in application code.
 */
export async function getTaskBoard(client: DatabaseClient, params: GetTaskBoardParams, options: TaskBoardOptions = {}): Promise<GetTaskBoardResult> {
  // A non-integer limit is REPLACED, not clamped: `Math.min(Math.max(NaN, 1), 500)` is NaN, which reaches SQL and
  // errors on an otherwise authorized read, and a fractional limit is equally meaningless to `LIMIT`.
  const requested = params.limit;
  const limit = Number.isInteger(requested) ? Math.min(Math.max(requested as number, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  // Trimmed once, so the scope resolver and the queries below agree on the id. `runInCompanyScope` trims internally,
  // so an untrimmed value would otherwise yield a valid scope and then a `22P02` on the uuid bind.
  const companyId = typeof params.companyId === 'string' ? params.companyId.trim() : params.companyId;
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(options.logger !== undefined ? { logger: options.logger } : {}) };

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: companyId },
    async (scope, role): Promise<GetTaskBoardResult> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const tasks = new TaskRepository(scope.db);
      // Read one MORE than the limit purely to detect truncation honestly, then drop it. Reporting `truncated` from
      // `rows.length === limit` would false-positive on a company holding exactly `limit` board tasks.
      // Count drafts BEFORE reading the page. Each statement gets its own read-committed snapshot, so a task
      // confirmed (draft → planned) between the two reads is otherwise missed by both — counted as neither a draft
      // nor a board row, and so invisible for that render. Counting first makes the residual skew "briefly visible in
      // both", which is the safe direction: a task shown twice is confusing, a task shown nowhere is a lie.
      const draftsOffBoard = await tasks.countDrafts(companyId);

      const rows = await tasks.listBoardPage({ limit: limit + 1 });
      const truncated = rows.length > limit;
      const page = truncated ? rows.slice(0, limit) : rows;
      const edges = await tasks.listDependenciesForTasks(
        page.map((r) => r.id),
        MAX_EDGES,
      );

      // Resolve prerequisite (and dependent) states that fall OUTSIDE the page. Without this a truncated board reports
      // almost everything as blocked: the page is newest-first, so prerequisites are by construction older than their
      // dependents and are the first rows dropped — turning a safe default into a systematically wrong answer.
      const onPage = new Set(page.map((r) => r.id));
      const missing = [...new Set(edges.flatMap((e) => [e.task_id, e.depends_on_task_id]).filter((id) => !onPage.has(id)))];
      const offPageStates = new Map((await tasks.findStatesByIds(missing)).map((r) => [r.id, r.state]));

      return { status: 'ok', board: buildTaskBoard({ rows: page, edges, draftsOffBoard, offPageStates, truncated }) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
