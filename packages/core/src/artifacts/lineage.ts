// @acbp/core — the revision lineage READ (ACBP-P5-012; CDR-064; TASK-005 lineage; J-13).
//
// The backlog's acceptance criteria for this ticket are exactly two: "revision lineage visible; both versions
// retained." Slices 2 and 3 made the lineage exist. This makes it visible.
//
// THE LINK IS WALKED, NOT STORED (CDR-064 G1). There is no `revision_of_artifact_id` column on `artifacts`. To answer
// "what was this a revision of", this reads the artifact's run, takes that run's TASK, and asks which revision
// request created that task. Three hops instead of one column — and in exchange the answer can never disagree with
// the request that caused it, and a revision run that wrote three artifacts gives all three the same honest ancestor
// without anything having to remember to set a field three times.
import { ArtifactRepository, ArtifactRevisionRepository, TaskRunRepository, type DatabaseClient } from '@acbp/database';
import type { ArtifactRevisionDTO } from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface ReadLineageOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export interface ReadLineageParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly artifactId: string;
}

/** The artifact itself, reduced to what a lineage view needs. The full document read is P5-011's surface. */
export interface LineageArtifactDTO {
  readonly artifactId: string;
  readonly title: string;
  readonly format: string;
  readonly runId: string;
  readonly createdAt: string;
}

export type ReadLineageResult =
  | {
      readonly status: 'ok';
      readonly artifact: LineageArtifactDTO;
      /** What this artifact was a revision OF — `null` when it is an original. Derived, never stored. */
      readonly revisedFrom: ArtifactRevisionDTO | null;
      /** Revisions asked OF this artifact, newest first. Empty is empty — never conflated with "unknown". */
      readonly revisions: readonly ArtifactRevisionDTO[];
    }
  | { readonly status: 'forbidden' }
  | { readonly status: 'artifact_not_found' };

/** How many revisions of one artifact a single read returns. A founder-facing list, not a bulk export. */
export const MAX_REVISIONS_RETURNED = 50;

function opts(o: ReadLineageOptions): { correlationId?: string; logger?: Logger } {
  return { ...(o.correlationId !== undefined ? { correlationId: o.correlationId } : {}), ...(o.logger !== undefined ? { logger: o.logger } : {}) };
}

function toRevisionDTO(row: { id: string; original_artifact_id: string; new_task_id: string; guidance: string; created_at: Date }): ArtifactRevisionDTO {
  return {
    revisionId: row.id,
    originalArtifactId: row.original_artifact_id,
    newTaskId: row.new_task_id,
    guidance: row.guidance,
    requestedAt: row.created_at.toISOString(),
  };
}

/**
 * Read one artifact's revision lineage: what it came from, and what has been asked of it.
 *
 * A MEMBER READ. `API-CONTRACTS.md:55` scopes the Documents row "Member (read), owner (revise)" — a viewer may see
 * the document and its history; only the owner may spend a credit revising it. That split is why `artifact:revise`
 * is a separate action from this read, which rides `task:read`.
 *
 * RLS-CONFINED: an artifact in another company reads as ABSENT, not as a refusal that would confirm it exists.
 */
export async function readArtifactLineage(client: DatabaseClient, params: ReadLineageParams, options: ReadLineageOptions = {}): Promise<ReadLineageResult> {
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReadLineageResult> => {
      if (checkAuthorization(role, 'task:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const artifact = await new ArtifactRepository(scope.db).findById(params.artifactId);
      if (artifact === undefined) return { status: 'artifact_not_found' };

      const revisions = new ArtifactRevisionRepository(scope.db);

      // BACKWARD: artifact -> its run -> that run's TASK -> the request that created the task. A missing link at any
      // hop means "this is an original", which is the honest answer — not an error, and not a guess.
      const run = await new TaskRunRepository(scope.db).findById(artifact.run_id);
      const ancestor = run === undefined ? undefined : await revisions.findByTask(run.task_id);

      // FORWARD: what has been asked of this artifact.
      const asked = await revisions.listForArtifact(artifact.id, MAX_REVISIONS_RETURNED);

      return {
        status: 'ok',
        artifact: {
          artifactId: artifact.id,
          title: artifact.title,
          format: artifact.format,
          runId: artifact.run_id,
          createdAt: artifact.created_at.toISOString(),
        },
        revisedFrom: ancestor === undefined ? null : toRevisionDTO(ancestor),
        revisions: asked.map(toRevisionDTO),
      };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}
