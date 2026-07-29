// @acbp/core — request a revision of an artifact (ACBP-P5-012; CDR-064; TASK-005 lineage; J-13).
//
// J-13, verbatim: *"Trigger: revision request with guidance. Flow: new linked task created (lineage to original) →
// re-execution → both versions retained."* So this use case creates a NEW TASK and records what it is revising. It
// does not touch the original artifact, and it does not re-open the original task — `running→completed` is TERMINAL
// in `WORKFLOW-STATE-MACHINES` §4, so that transition does not exist.
//
// IT DOES NOT CHARGE A CREDIT, and that is deliberate (CDR-064 G4, corrected). The backlog says "new run metered",
// and the metering already exists: `WORKFLOW-STATE-MACHINES` §4 puts the credit check on `planned→queued`
// ("preflight shown + credit check (TASK-004)"), which the new task goes through like any other. Reserving here
// would charge TWICE for one revision — the same shape as D9, where a consumption debited what the reservation had
// already taken. Before adding a charge to any new path, find where the lifecycle already charges.
import { ArtifactRepository, ArtifactRevisionRepository, TaskRepository, TaskRunRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext } from '@acbp/database';
import { validateRevisionGuidance, validateRevisionKey, artifactRevisionRequested, type RevisionRefusal, type ArtifactRevisionDTO } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface RequestRevisionOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

export interface RequestRevisionParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** The artifact being revised — the document the founder is looking at (J-12 → J-13). */
  readonly artifactId: string;
  readonly guidance: unknown;
  readonly idempotencyKey: unknown;
}

export type RequestRevisionResult =
  | {
      readonly status: 'ok';
      readonly revision: ArtifactRevisionDTO;
      /** The NEW task created to do the revision. It starts in `draft`, like every other task. */
      readonly newTaskId: string;
      /** True when this key had already requested a revision: the FIRST request is returned, and nothing new was made. */
      readonly deduplicated: boolean;
    }
  | { readonly status: 'forbidden' }
  /** RLS-confined: an artifact in another company reads as ABSENT, never as a refusal that confirms it exists. */
  | { readonly status: 'artifact_not_found' }
  /** The task whose run produced this artifact is gone. There is nothing to re-execute (J-13's "re-execution"). */
  | { readonly status: 'source_task_unavailable' }
  | { readonly status: 'invalid'; readonly reason: RevisionRefusal };

function opts(o: RequestRevisionOptions): { correlationId?: string; logger?: Logger } {
  return { ...(o.correlationId !== undefined ? { correlationId: o.correlationId } : {}), ...(o.logger !== undefined ? { logger: o.logger } : {}) };
}
function auditCtx(o: RequestRevisionOptions): Partial<AuditWriteContext> {
  return { actorType: 'user', ...(o.correlationId !== undefined ? { correlationId: o.correlationId } : {}) };
}

function toDTO(row: { id: string; original_artifact_id: string; new_task_id: string; guidance: string; created_at: Date }): ArtifactRevisionDTO {
  return {
    revisionId: row.id,
    originalArtifactId: row.original_artifact_id,
    newTaskId: row.new_task_id,
    guidance: row.guidance,
    requestedAt: row.created_at.toISOString(),
  };
}

/**
 * Request a revision of an artifact (J-13).
 *
 * OWNER-ONLY (`artifact:revise`), because `API-CONTRACTS.md:55` scopes the Documents row explicitly — "Member
 * (read), owner (revise)" — and because the new task will spend a credit when it is queued.
 *
 * AUDIT-OR-NOTHING (ADR-015): the new task, the revision row and the audit event are ONE transaction. A task with no
 * revision row would be orphaned work nobody asked for; a revision row with no task would be lineage pointing at
 * nothing; either without the audit event would be an unrecorded spend of the founder's credits.
 */
export async function requestRevision(client: DatabaseClient, params: RequestRevisionParams, options: RequestRevisionOptions = {}): Promise<RequestRevisionResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RequestRevisionResult> => {
      if (checkAuthorization(role, 'artifact:revise', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      // VALIDATE BEFORE READING. A malformed request should not disclose whether the artifact exists.
      const guidance = validateRevisionGuidance(params.guidance);
      if (!guidance.ok) return { status: 'invalid', reason: guidance.reason };
      const key = validateRevisionKey(params.idempotencyKey);
      if (!key.ok) return { status: 'invalid', reason: key.reason };

      const revisions = new ArtifactRevisionRepository(scope.db);

      // IDEMPOTENCE FIRST (CDR-064 G3). Checked BEFORE the task is created, so a retry cannot leave a second orphan
      // task behind even though the revision row would have been refused. The ON CONFLICT below is the race backstop.
      const already = await revisions.findByKey(scope.tenant.companyId, key.key);
      if (already !== undefined) return { status: 'ok', revision: toDTO(already), newTaskId: already.new_task_id, deduplicated: true };

      // RLS-confined: a foreign artifact reads as absent rather than as a refusal that confirms it exists.
      const artifact = await new ArtifactRepository(scope.db).findById(params.artifactId);
      if (artifact === undefined) return { status: 'artifact_not_found' };

      // The task to re-execute. `findLive`, so a deleted source is genuinely unavailable rather than silently
      // resurrected — the same reading `repeatTask` takes of a deleted source.
      const sourceRun = await new TaskRunRepository(scope.db).findById(artifact.run_id);
      const tasks = new TaskRepository(scope.db);
      const source = sourceRun === undefined ? undefined : await tasks.findLive(sourceRun.task_id);
      if (source === undefined) return { status: 'source_task_unavailable' };

      // THE NEW LINKED TASK. Content carries over so the worker knows what it is doing; `task_type` carries over so
      // the SAME worker runs it. Provenance does not — priority and rationale are about the original piece of work,
      // and inheriting them would attribute reasoning about one task to a different one (the P4-005 lesson).
      //
      // `repeatedFromTaskId` is deliberately NOT set: the lineage lives in the revision row (CDR-064 G1), and putting
      // it in two places is putting it in two places that can disagree. It is also a different relationship — repeat
      // means "do this again", revision means "do this differently, because of THIS artifact".
      const created = await tasks.insert({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        title: source.title,
        description: source.description,
        milestoneId: source.milestone_id,
        taskType: source.task_type,
        createdByUserId: params.userId,
      });

      const row = await revisions.insert({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        originalArtifactId: artifact.id,
        newTaskId: created.id,
        guidance: guidance.guidance,
        idempotencyKey: key.key,
        requestedByUserId: params.userId,
      });
      if (row === undefined) {
        // The key index fired: a concurrent request committed between the read above and this insert. The FIRST
        // request stands and the caller gets it. Throwing would be wrong — the caller's intent was satisfied.
        const winner = await revisions.findByKey(scope.tenant.companyId, key.key);
        if (winner === undefined) throw new Error('revision request was refused but no prior request exists — invariant violated');
        return { status: 'ok', revision: toDTO(winner), newTaskId: winner.new_task_id, deduplicated: true };
      }

      // Scalars only, and BOTH ends of the lineage. The guidance TEXT never enters the payload (task.deleted's
      // reason-text precedent) — that a revision was asked for is the auditable fact, the words are in the row.
      await audit(scope, artifactRevisionRequested({ revisionId: row.id, originalArtifactId: artifact.id, newTaskId: created.id, hasGuidance: true }), auditCtx(options));
      options.logger?.info('artifact.revision_requested', { metadata: { accountId: params.accountId, companyId: params.companyId } });
      return { status: 'ok', revision: toDTO(row), newTaskId: created.id, deduplicated: false };
    },
    opts(options),
  );
  // A scope that could not be established is a REFUSAL, never a pass-through.
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}
