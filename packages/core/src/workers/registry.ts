// @acbp/core — the worker registry (ACBP-P5-004; CDR-056; WORK-001/006; ADR-012; trust-critical #4).
//
// THIS CLOSES THE ALLOWLIST GAP. `CDR-054 §1-G3` and `CDR-055` both deferred the same thing: where the dispatcher's
// tool allowlist comes from. The dispatcher always enforced it — no allowlist supplied ⇒ deny — but the list was a
// caller-supplied parameter, which made WORK-005's *"server-enforced"* true mechanically and not yet authoritatively.
// After this, trust-critical #4's *"allowlists versioned in worker definitions"* is literally where it lives.
import { WorkerRepository, WorkerRunRepository, TaskRunRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type WorkerDefinitionRow } from '@acbp/database';
import { isWorkerState, workerAcceptsTasks, isMvpSafeAllowlist, workerStateChanged, taskCancelled, type WorkerState } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface RegistryOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

interface ScopeParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

export interface WorkerDefinitionDTO {
  readonly workerId: string;
  readonly version: number;
  readonly capabilities: readonly string[];
  readonly allowedTools: readonly string[];
  readonly maxSpendMicros: number;
  readonly maxDurationMs: number;
  readonly retryCategories: readonly string[];
  readonly approvalThresholdRiskClass: string | null;
  readonly modelTaskClass: string;
}

function toDTO(row: WorkerDefinitionRow): WorkerDefinitionDTO {
  return {
    workerId: row.worker_id,
    version: row.version,
    capabilities: row.capabilities,
    allowedTools: row.allowed_tools,
    maxSpendMicros: row.max_spend_micros,
    maxDurationMs: row.max_duration_ms,
    retryCategories: row.retry_categories,
    approvalThresholdRiskClass: row.approval_threshold_risk_class,
    modelTaskClass: row.model_task_class,
  };
}

export interface ResolveWorkerParams extends ScopeParams {
  readonly workerId: string;
}

export type ResolveWorkerResult =
  // Cleared. `allowlist` is what the dispatcher enforces — the whole point of this ticket.
  | { readonly status: 'ok'; readonly definition: WorkerDefinitionDTO; readonly allowlist: readonly string[] }
  | { readonly status: 'forbidden' }
  // WORK-001: "Unregistered workers cannot receive tasks." NEVER an empty allowlist — the dispatcher already
  // distinguishes `no_allowlist` from `not_allowlisted`, and an unknown worker is neither of those things.
  | { readonly status: 'unknown_worker' }
  // WORK-006: "Disabled workers receive no new tasks; their queued tasks are held visibly." HELD, not cancelled —
  // nothing here transitions a task, and the state is carried so a read path can say which of the two it is.
  | { readonly status: 'not_accepting'; readonly state: WorkerState }
  // ADR-012's MVP boundary: this definition's allowlist reaches past `internal_reversible`. Found in review pass 1 —
  // CDR-056 §2-G4 CLAIMED this boundary was structural while nothing enforced it, which is worse than not claiming it.
  | { readonly status: 'mvp_boundary_violation'; readonly offendingTools: readonly string[] };

/**
 * Resolve a worker to the allowlist the dispatcher will enforce.
 *
 * A refusal is never a narrower allowlist. Returning `[]` for a paused worker would make it look like a worker that
 * legitimately may use no tools, and the dispatcher would report `not_allowlisted` — sending whoever reads the record
 * to look for a missing tool rather than at the pause the owner applied.
 */
export async function resolveWorkerAllowlist(client: DatabaseClient, params: ResolveWorkerParams, options: RegistryOptions = {}): Promise<ResolveWorkerResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ResolveWorkerResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const workers = new WorkerRepository(scope.db);

      const definition = await workers.findActiveDefinition(params.workerId);
      if (definition === undefined) return { status: 'unknown_worker' };

      // No row means the owner has never touched this worker, which is `enabled` — the default in the column too, so
      // the two agree. An unrecognised stored value does NOT read as enabled (`workerAcceptsTasks` refuses it).
      const stored = await workers.findCompanyState(params.workerId);
      const state = stored?.state ?? 'enabled';
      if (!workerAcceptsTasks(state)) return { status: 'not_accepting', state: isWorkerState(state) ? state : 'disabled' };

      // THE MVP BOUNDARY, ENFORCED ON THE PATH THAT MATTERS (review pass 1). It cannot be a CHECK: the allowlist is a
      // `text[]` and the classes live in another table, and PostgreSQL CHECKs cannot subquery. So it is enforced HERE,
      // at the only point where a definition turns into a capability — a violating definition may exist in the
      // registry but can never be used, which is the property canon's "structural, not procedural" actually needs.
      const classes = await workers.toolRiskClasses(definition.allowed_tools);
      const byId = new Map(classes.map((c) => [c.tool_id, c.risk_class]));
      // A tool the registry does not have gets `undefined`, which `resolveRiskClass` maps to the MOST restrictive
      // class — so an allowlist naming an unregistered tool fails the boundary rather than slipping past it.
      const entries = definition.allowed_tools.map((toolId) => ({ toolId, riskClass: byId.get(toolId) }));
      if (!isMvpSafeAllowlist(entries)) {
        const offendingTools = entries.filter((e) => !isMvpSafeAllowlist([e])).map((e) => e.toolId);
        options.logger?.warn('worker.mvp_boundary_violation', { metadata: { companyId: params.companyId, workerId: params.workerId, count: offendingTools.length } });
        return { status: 'mvp_boundary_violation', offendingTools };
      }

      return { status: 'ok', definition: toDTO(definition), allowlist: definition.allowed_tools };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── the registry listing (WORK-001) ─────────────────────────────────────────────────────────────────────────

export interface WorkerListingEntry extends WorkerDefinitionDTO {
  /** This company's state. `enabled` when the owner has never touched it — the column default agrees. */
  readonly state: WorkerState;
  /** Whether the owner gave a reason. The reason TEXT is theirs and is not surfaced here. */
  readonly hasReason: boolean;
}

export type ListWorkersResult = { readonly status: 'ok'; readonly workers: readonly WorkerListingEntry[] } | { readonly status: 'forbidden' };

/**
 * WORK-001's acceptance, literally: *"Registry lists each worker with capabilities and tool allowlist."*
 *
 * Readable by any active member (`run:read` is not a thing; this reuses `task:read`, the member-level read this
 * board-adjacent view belongs beside) — knowing which workers exist and whether they are paused is not a privileged
 * fact, and hiding it from a viewer would make the pause invisible to exactly the people wondering why nothing ran.
 */
export async function listWorkers(client: DatabaseClient, params: ScopeParams, options: RegistryOptions = {}): Promise<ListWorkersResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ListWorkersResult> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const workers = new WorkerRepository(scope.db);
      const [definitions, states] = await Promise.all([workers.listActiveDefinitions(), workers.listCompanyStates()]);
      const byWorker = new Map(states.map((s) => [s.worker_id, s]));

      // `listActiveDefinitions` returns every active version newest-first; the listing shows the one that would
      // actually run, so later versions of the same worker are dropped rather than shown as duplicates.
      const seen = new Set<string>();
      const listing: WorkerListingEntry[] = [];
      for (const d of definitions) {
        if (seen.has(d.worker_id)) continue;
        seen.add(d.worker_id);
        const stored = byWorker.get(d.worker_id);
        const state = stored?.state;
        listing.push({ ...toDTO(d), state: isWorkerState(state) ? state : 'enabled', hasReason: (stored?.reason ?? null) !== null });
      }
      return { status: 'ok', workers: listing };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── the owner's control (WORK-006) ──────────────────────────────────────────────────────────────────────────

export interface SetWorkerStateParams extends ScopeParams {
  readonly workerId: string;
  readonly state: string;
  readonly reason?: string;
}

export type SetWorkerStateResult =
  // `stopsRequested` is how many RUNNING runs of this worker were asked to stop. Reported rather than hidden, because
  // "did disabling it actually reach the work already in flight?" is the question WORK-006 is asking.
  | { readonly status: 'ok'; readonly workerId: string; readonly state: WorkerState; readonly stopsRequested: number }
  | { readonly status: 'forbidden' }
  | { readonly status: 'unknown_worker' }
  | { readonly status: 'invalid' };

const REASON_MAX = 500;

/**
 * Pause, disable or re-enable a worker for THIS company (WORK-006 — *"Granular emergency control"*).
 *
 * OWNER-ONLY. Canon calls this an emergency control and puts it beside ADMIN-001; a viewer who could disable the
 * research worker could stop the company's work without being able to start any.
 */
export async function setCompanyWorkerState(client: DatabaseClient, params: SetWorkerStateParams, options: RegistryOptions = {}): Promise<SetWorkerStateResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<SetWorkerStateResult> => {
      if (checkAuthorization(role, 'worker:control', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      if (!isWorkerState(params.state)) return { status: 'invalid' };
      const trimmed = params.reason?.trim() ?? '';
      const reason = trimmed.length === 0 ? null : trimmed;
      if (reason !== null && reason.length > REASON_MAX) return { status: 'invalid' };

      const workers = new WorkerRepository(scope.db);
      // Refuse to record a state for a worker that does not exist: a pause on a typo'd id would sit in the table
      // looking like protection while protecting nothing.
      if ((await workers.findActiveDefinition(params.workerId)) === undefined) return { status: 'unknown_worker' };

      const row = await workers.setCompanyState({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        workerId: params.workerId,
        state: params.state,
        reason,
        changedByUserId: params.userId,
      });
      if (row === undefined) throw new Error('worker state upsert wrote nothing — invariant violated');

      // ── THE SAFE STOP (ACBP-P5-005; WORK-006 *"disable during execution triggers safe-stop"*) ──────────────
      //
      // This is the clause `CDR-056 §6` recorded as UNMET, and it was unmet for a structural reason: nothing linked a
      // run to the worker executing it, so "this worker's running work" could not be asked for. `worker_runs` is that
      // link, and this sweep is the clause.
      //
      // IN THE SAME TRANSACTION as the state change. A disable that landed while its stops did not would leave the
      // owner looking at a disabled worker that is still working — the exact failure the control exists to prevent.
      //
      // REQUESTED, NEVER FORCED (CDR-057 §1-G7). The stop is durable on the task run and the worker honours it at its
      // next checkpoint. Killing a call mid-flight is how a half-performed external action happens.
      // EVERY STOP IS AUDITED, with the same event and the same `running_safe_stop` phase `cancelRun` uses. Found in
      // review pass 2: the first version called `requestStop` directly and set a durable stop on N task runs with NO
      // record of it — an owner reading the trail would see the disable and not the stops it caused, which is the
      // half of the story that matters when work goes quiet.
      let stopsRequested = 0;
      if (!workerAcceptsTasks(params.state)) {
        const taskRuns = new TaskRunRepository(scope.db);
        for (const live of await new WorkerRunRepository(scope.db).listRunningForWorker(params.workerId)) {
          // `requestStop` is guarded on a RUNNING task run and idempotent, so a run that ended in between is simply
          // not counted rather than being resurrected.
          const stopped = await taskRuns.requestStop(live.task_run_id);
          if (stopped === undefined) continue;
          await audit(scope, taskCancelled({ taskId: stopped.task_id, runId: stopped.id, phase: 'running_safe_stop' }), auditCtx(options));
          stopsRequested += 1;
        }
      }

      // `has_reason` is a BOOLEAN: whether the owner explained themselves is useful, the text they wrote is theirs.
      await audit(scope, workerStateChanged({ workerId: params.workerId, state: params.state, hasReason: reason !== null }), auditCtx(options));
      options.logger?.info('worker.state_changed', { metadata: { companyId: params.companyId, workerId: params.workerId, state: params.state, stops_requested: stopsRequested } });
      return { status: 'ok', workerId: params.workerId, state: params.state, stopsRequested };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

function auditCtx(options: RegistryOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: RegistryOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
