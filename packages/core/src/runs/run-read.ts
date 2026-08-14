// @acbp/core — the run read (ACBP-API-003; CDR-089).
//
// A DOMAIN ADDITION, not an exposure. CDR-087 and CDR-088 both shipped under a "no new domain logic" framing;
// CDR-089 §0 states that framing does NOT carry here, and this file is why: the use cases below did not exist.
//
// A RUN IS ALWAYS A RUN OF A TASK. The table is `task_runs` — there is no free-standing run entity — but a run
// IS addressable by its own id, because `TaskRunRepository` exposes both `findById` and `listForTask`. That is
// what makes the already-shipped `runs/{runId}/artifacts` route (CDR-088) consistent rather than anomalous.
import { TaskRunRepository, type DatabaseClient, type TaskRunRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

/**
 * What a run looks like ON THE WIRE.
 *
 * AN ALLOWLIST, NOT A REDACTION — CDR-089 §2, following the approvals inbox, whose equivalent guard is the one
 * cleanly mutation-proven kill in slice 2 (run `31638284349`). Spreading the row and deleting unwanted keys would
 * silently publish the next column added to `task_runs`; naming eleven fields means a new column stays invisible
 * until a human puts it here.
 *
 * `account_id` and `company_id` are DELIBERATELY ABSENT: internal scoping the caller already knows, and echoing
 * tenant ids back is how they reach client logs and URLs.
 *
 * `failureCategory` IS published, and that is deliberate. The schema documents it as a CLOSED category, never
 * worker exception text, and TASK-006 is precisely that a founder must be able to see why a run failed —
 * withholding it would defeat the read's purpose while protecting nothing.
 */
export interface TaskRunDTO {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly state: string;
  readonly failureCategory: string | null;
  readonly startedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly stopRequestedAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Timestamps cross the boundary as ISO strings; a null stays null rather than becoming an epoch. */
const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function toTaskRunDTO(row: TaskRunRow): TaskRunDTO {
  return {
    runId: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    state: row.state,
    failureCategory: row.failure_category,
    startedAt: iso(row.started_at),
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    stopRequestedAt: iso(row.stop_requested_at),
    endedAt: iso(row.ended_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface RunReadOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}
function opts(options: RunReadOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}

export interface GetTaskRunParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly runId: string;
}
export type GetTaskRunResult =
  | { readonly status: 'ok'; readonly run: TaskRunDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' };

/**
 * One run's detail (`run:read` → owner + viewer).
 *
 * RLS-confined: a foreign run is `not_found`, and it is INDISTINGUISHABLE from an unknown id because both read as
 * `undefined` here. That is enforced by row-level security rather than by a decision in this function — which is
 * exactly why CDR-089 §5 says not to spend mutation runs on it (demonstrated by run `31643354339`).
 */
export async function getTaskRun(client: DatabaseClient, params: GetTaskRunParams, options: RunReadOptions = {}): Promise<GetTaskRunResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetTaskRunResult> => {
      if (checkAuthorization(role, 'run:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const row = await new TaskRunRepository(scope.db).findById(params.runId);
      if (row === undefined) return { status: 'not_found' };
      return { status: 'ok', run: toTaskRunDTO(row) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

export interface ListTaskRunsParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
}
export type ListTaskRunsResult =
  | { readonly status: 'ok'; readonly runs: readonly TaskRunDTO[] }
  | { readonly status: 'forbidden' };

/**
 * Every run of one task, newest first (`run:read` → owner + viewer).
 *
 * NO `not_found` ARM, and that is honest rather than lazy: `listForTask` cannot distinguish an unknown task from a
 * task with no runs — both are an empty list. Inventing a 404 here would claim a distinction the query does not
 * make. A caller needing that difference reads the task itself, which has its own `not_found`.
 */
export async function listTaskRuns(client: DatabaseClient, params: ListTaskRunsParams, options: RunReadOptions = {}): Promise<ListTaskRunsResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ListTaskRunsResult> => {
      if (checkAuthorization(role, 'run:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const rows = await new TaskRunRepository(scope.db).listForTask(params.taskId);
      return { status: 'ok', runs: rows.map(toTaskRunDTO) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
