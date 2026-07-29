// @acbp/core — task completion (ACBP-P5-011; TASK-005; EVENT-CATALOG line 180; WORKFLOW-STATE-MACHINES line 60).
//
// THE PLACE `validateCompletionEvidence` IS ACTUALLY APPLIED. A contract that makes the forbidden shape
// unrepresentable is worth nothing if no code path calls it — a guard written and never applied is the single defect
// pattern this repo has hit most often, so this module exists to be that path.
//
// `WORKFLOW-STATE-MACHINES` line 60 states the guard on `running → completed` as *"artifact persisted (TASK-005 —
// persistence failure ⇒ failed, never hollow success)"*. Three things follow, and all three are enforced here rather
// than described:
//
//   1. The evidence must be one of canon's two shapes — artifacts, or an explicit reason there are none.
//   2. Every cited artifact must EXIST, in THIS company, produced by THIS run. A completion citing another task's
//      artifact would satisfy a naive count check while proving nothing about the work this task did.
//   3. The state change and its audit row are ONE transaction (ADR-015, audit-or-nothing). A completion nobody can
//      later account for is the record failing at the one moment it matters.
import { ArtifactRepository, TaskRepository, TaskRunRepository, writeAuditEvent, type DatabaseClient } from '@acbp/database';
import { completionArtifactCount, isLegalTaskTransition, isTaskState, taskCompleted, validateCompletionEvidence, type CompletionEvidence, type CompletionRefusal } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface CompleteTaskOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

export interface CompleteTaskParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
  /** `unknown` deliberately: this arrives from a worker's structured output, and the declared type is only a promise. */
  readonly evidence: unknown;
}

export type CompleteTaskResult =
  | { readonly status: 'ok'; readonly artifactCount: number }
  | { readonly status: 'forbidden' }
  | { readonly status: 'task_not_found' }
  | { readonly status: 'run_not_found' }
  /** The run belongs to a different task — the linkage `task.completed` asserts must actually hold. */
  | { readonly status: 'run_mismatch' }
  /** The run has not succeeded. A run that failed or is still going cannot complete its task. */
  | { readonly status: 'run_not_succeeded'; readonly runState: string }
  | { readonly status: 'illegal_transition'; readonly from: string }
  | { readonly status: 'refused'; readonly reason: CompletionRefusal }
  /** One or more cited artifacts do not exist in this company, or were produced by a different run. */
  | { readonly status: 'unknown_artifact' };

function optionsFor(options: CompleteTaskOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}

/**
 * Complete a task on evidence.
 *
 * THE ARTIFACT CHECK IS AGAINST THE DATABASE, not against what the caller says it produced. `validateCompletionEvidence`
 * proves the SHAPE is one canon permits; only a read can prove the artifacts are real, are this company's, and came
 * from this run. Skipping it would let a worker complete a task by citing three ids it invented, and the audit row
 * would faithfully record `artifact_count: 3`.
 */
export async function completeTask(client: DatabaseClient, params: CompleteTaskParams, options: CompleteTaskOptions = {}): Promise<CompleteTaskResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const validated = validateCompletionEvidence(params.evidence);
  if (!validated.ok) return { status: 'refused', reason: validated.reason };
  const evidence: CompletionEvidence = validated.evidence;

  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<CompleteTaskResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, optionsFor(options)).kind === 'deny') return { status: 'forbidden' };

      const run = await new TaskRunRepository(scope.db).findById(params.runId);
      if (run === undefined) return { status: 'run_not_found' };
      if (run.task_id !== params.taskId) return { status: 'run_mismatch' };
      if (run.state !== 'succeeded') return { status: 'run_not_succeeded', runState: run.state };

      const tasks = new TaskRepository(scope.db);
      const task = await tasks.findById(params.taskId);
      if (task === undefined) return { status: 'task_not_found' };
      if (!isTaskState(task.state) || !isLegalTaskTransition(task.state, 'completed')) return { status: 'illegal_transition', from: task.state };

      if (evidence.kind === 'artifacts') {
        // EVERY id, checked. RLS confines the read to this company, and the run comparison closes the other half:
        // an artifact this company owns but a different run produced is not evidence that THIS run did the work.
        const produced = await new ArtifactRepository(scope.db).listForRun(params.runId);
        const own = new Set(produced.map((a) => a.id));
        if (!evidence.artifactIds.every((id) => own.has(id))) return { status: 'unknown_artifact' };
      }

      // GUARDED on the state we read. A concurrent cancel or failure between the read and the write must lose, not be
      // silently overwritten with a completion.
      const updated = await tasks.updateState(params.taskId, task.state, 'completed');
      if (updated !== 1) return { status: 'illegal_transition', from: task.state };

      const artifactCount = completionArtifactCount(evidence);
      await audit(scope, taskCompleted({ taskId: params.taskId, runId: params.runId, artifactCount, hasNoArtifactRationale: evidence.kind === 'no_artifact' }));
      return { status: 'ok', artifactCount };
    },
    optionsFor(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}
