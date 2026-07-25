// @acbp/core — versioned roadmap edit (ACBP-P4-001; CDR-039; ROAD-002).
//
// ROAD-002: "Roadmaps are versioned and editable; changes flag affected tasks and record rationale." Acceptance:
// "Edits create versions with author and reason; affected open tasks are flagged for review." Fail: "Version write
// failure blocks the edit rather than losing history."
//
// An edit does NOT mutate the current version — it writes a NEW version row that supersedes it, carrying the owner's
// required reason and author. Because the tables are append-only, "blocks the edit rather than losing history" is
// structural: there is no code path that could damage the previous version, and the new version + its goals +
// milestones + the affected-task flags + `roadmap.edited` all land in ONE transaction (audit-or-nothing).
//
// OWNER-ONLY (`roadmap:edit`; API-CONTRACTS "Owner (edit)"). "Affected open tasks" (CDR-039 §7-G7): tasks whose
// milestone belongs to the SUPERSEDED version, whose state is not terminal. No model call is involved — the owner
// authors the content.
import { PlanningRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type GoalRow, type MilestoneRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { roadmapEdited, normalizeEditReason, parseRoadmapOutput, type AuditEvent, type RoadmapDTO, type RoadmapStatus } from '@acbp/contracts';
import { toRoadmapDTO } from './roadmap-generation.js';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

export interface EditRoadmapParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** The version being revised. Must be the company's CURRENT version — editing a superseded one is refused. */
  readonly expectedRoadmapId: string;
  /**
   * The revised plan, in the same shape the generator produces (goals + milestones + optional goal links). Supplied by
   * the OWNER — no model call. Validated by the same deny-by-default parser, so an owner edit can never introduce a
   * shape the platform would have rejected from a model.
   */
  readonly plan: string;
  /** REQUIRED (ROAD-002 "record rationale"). */
  readonly reason: unknown;
}
export interface RoadmapEditDeps {
  readonly logger?: Logger;
}
export interface RoadmapEditOptions {
  readonly correlationId?: string;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove the new version rolls back). */
  readonly auditWriter?: AuditWriteFn;
}

export type EditRoadmapResult =
  | { readonly status: 'ok'; readonly roadmap: RoadmapDTO; readonly flaggedTaskCount: number }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  // `expectedRoadmapId` is not the company's current version — the owner is editing a stale view (API-CONTRACTS
  // "version-guarded"). Nothing is written; the caller should re-read and retry.
  | { readonly status: 'stale_version' }
  // A missing/blank/over-long reason, or a plan that fails the shape parse.
  | { readonly status: 'invalid' };

export async function editRoadmap(
  client: DatabaseClient,
  params: EditRoadmapParams,
  deps: RoadmapEditDeps = {},
  options: RoadmapEditOptions = {},
): Promise<EditRoadmapResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<EditRoadmapResult> => {
      // Owner-only: a viewer may generate and read the plan, but only the owner revises it.
      if (checkAuthorization(role, 'roadmap:edit', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      // AUTHZ FIRST, then input validation — an unauthorized caller never learns whether their input would have parsed.
      const reason = normalizeEditReason(params.reason);
      if (reason === undefined) return { status: 'invalid' };
      const parsed = parseRoadmapOutput(params.plan);
      if (!parsed.ok) return { status: 'invalid' };

      const planning = new PlanningRepository(scope.db);
      const current = await planning.latestRoadmap(params.companyId);
      if (current === undefined) return { status: 'not_found' };
      // Version guard: the owner must be revising the version they actually read.
      if (current.id !== params.expectedRoadmapId) return { status: 'stale_version' };

      // The tasks to flag are read BEFORE the new version exists, so they are unambiguously the ones tied to the
      // version being superseded (CDR-039 §7-G7).
      const affected = await planning.listAffectedOpenTasks(current.id);

      const roadmap = await planning.insertRoadmap({
        accountId: params.accountId,
        companyId: params.companyId,
        version: current.version + 1,
        // An edit re-plans the SAME decision — a new decision would require a new generation, not an edit.
        decisionId: current.decision_id,
        // An owner edit is authored content, so it is never "model-flagged partial"; its completeness is the owner's.
        status: 'complete' satisfies RoadmapStatus,
        origin: 'edited',
        supersedesRoadmapId: current.id,
        editReason: reason,
        modelFlaggedPartial: false,
        createdByUserId: params.userId,
      });

      const goalRows: GoalRow[] = [];
      for (let i = 0; i < parsed.value.goals.length; i += 1) {
        const g = parsed.value.goals[i]!;
        goalRows.push(await planning.insertGoal({ accountId: params.accountId, companyId: params.companyId, roadmapId: roadmap.id, ordinal: i, title: g.title, description: g.description }));
      }
      const milestoneRows: MilestoneRow[] = [];
      for (let i = 0; i < parsed.value.milestones.length; i += 1) {
        const m = parsed.value.milestones[i]!;
        const goalId = m.goalOrdinal === null ? null : (goalRows[m.goalOrdinal]?.id ?? null);
        milestoneRows.push(await planning.insertMilestone({ accountId: params.accountId, companyId: params.companyId, roadmapId: roadmap.id, goalId, ordinal: i, title: m.title, description: m.description }));
      }

      // ROAD-002 "affected open tasks are flagged for review" — in the SAME transaction as the version, so a flag can
      // never exist without its version (nor a version without its flags).
      for (const task of affected) {
        await planning.insertTaskReviewFlag({ accountId: params.accountId, companyId: params.companyId, taskId: task.id, roadmapId: roadmap.id, reason: 'roadmap revised' });
      }

      await audit(
        scope,
        roadmapEdited({ roadmapId: roadmap.id, roadmapVersion: roadmap.version, supersedesVersion: current.version, affectedTaskCount: affected.length, hasReason: true }),
        options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
      );
      deps.logger?.info('roadmap.edited', { metadata: { accountId: params.accountId, companyId: params.companyId, roadmapVersion: roadmap.version, supersedesVersion: current.version, affectedTaskCount: affected.length } });
      return { status: 'ok', roadmap: toRoadmapDTO(roadmap, goalRows, milestoneRows), flaggedTaskCount: affected.length };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
