// @acbp/core — roadmap generation (ACBP-P4-001; CDR-039; ROAD-001; ADR-015/019).
//
// Turn the DECIDED strategy into a plan: goals + milestones sequenced by ORDER (never by an invented date — ADR-019).
// P4-001 plans NO tasks (task generation is P4-003, CDR-039 §7-G3); it makes ROAD-001's "tasks trace to milestones"
// ENFORCEABLE instead, via the migration-0026 tasks→milestones FK.
//
// The planning GATE (J-08 "decision recorded before any planning") is NOT "a decision exists": STRAT-006 requires a
// decision record for a REJECTION too, which is why P3-005 snapshots `decisions.mode`. Planning requires the company's
// LATEST decision to be non-reject (CDR-039 §7-G1) — a later rejection re-blocks planning exactly as a later
// understanding correction re-blocks strategy. The gate is RE-VERIFIED inside the persist transaction, so a decision
// that changes during the model call yields `stale_decision` and persists nothing.
//
// The model call runs BETWEEN scoped transactions (never in a held tx) and is metered by the gateway itself. Partial
// honesty (CDR-029's rule): a gateway failure or malformed output persists NOTHING — only a successfully-parsed,
// model-flagged output is `partial`. "Retry available" needs no machinery: a retry is another call producing a new
// version, and everything upstream is immutable, so ROAD-001's "generation failure preserves the approved strategy"
// holds automatically.
import { PlanningRepository, StrategyRepository, writeAuditEvent, type DatabaseClient, type AuditScope, type AuditWriteContext, type RoadmapRow, type GoalRow, type MilestoneRow, type DecisionRow } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  roadmapGenerated,
  narrowRoadmapOutput,
  resolveTemplateRef,
  renderTemplateSegments,
  templateRef,
  timeoutClassForTask,
  ROADMAP_SCHEMA,
  type AuditEvent,
  type ModelContextPart,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type RoadmapDTO,
  type GoalDTO,
  type MilestoneDTO,
  type RoadmapStatus,
  type RoadmapOrigin,
  type GoalStatus,
  type MilestoneStatus,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

type AuditWriteFn = (scope: AuditScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;
export type ModelGateway = (request: ModelGatewayRequest, options?: { readonly correlationId?: string }) => Promise<ModelGatewayResult>;

const DECISION_PROMPT_MAX = 12_000;

export interface GenerateRoadmapParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}
export interface RoadmapGenerationDeps {
  readonly gateway: ModelGateway;
  readonly logger?: Logger;
}
export interface RoadmapGenerationOptions {
  readonly correlationId?: string;
  /** TEST SEAM ONLY: override the in-tx audit writer to force a failure (prove the version rolls back). */
  readonly auditWriter?: AuditWriteFn;
  /** TEST SEAM ONLY: run between the model call and the persist transaction (to simulate a concurrent decision). */
  readonly beforePersist?: () => Promise<void>;
}

export type GenerateRoadmapResult =
  | { readonly status: 'ok'; readonly roadmap: RoadmapDTO }
  | { readonly status: 'forbidden' }
  // No decision has been recorded for this company yet — planning is blocked (J-08).
  | { readonly status: 'no_decision' }
  // The company's latest decision REJECTED the strategy — planning stays blocked until a positive decision is recorded.
  | { readonly status: 'decision_rejected' }
  // The latest decision changed during the model call — a plan built on a superseded decision is never persisted.
  | { readonly status: 'stale_decision' }
  | { readonly status: 'generation_failed' };

/** Render the decided strategy into the bounded `{{decision}}` prompt text (the model's planning input). */
export function formatDecisionForPlanning(input: { readonly mode: string; readonly understandingVersion: number; readonly fields: Record<string, string> }): string {
  const lines = Object.entries(input.fields).map(([k, v]) => `${k}: ${v}`);
  return [`Decision mode: ${input.mode}`, `Understanding version: ${input.understandingVersion}`, ...lines].join('\n').slice(0, DECISION_PROMPT_MAX);
}

/** Build the roadmap gateway request (pins the registered template + output schema). */
export function buildRoadmapRequest(input: { accountId: string; companyId: string; decision: string; correlationId?: string }): ModelGatewayRequest {
  const def = resolveTemplateRef('planning.roadmap@1');
  const contextParts: ModelContextPart[] = renderTemplateSegments(def, { decision: input.decision }).map((s) => ({ role: s.role, content: s.text }));
  return {
    taskClass: def.taskClass,
    templateRef: templateRef(def),
    contextParts,
    outputSchemaRef: ROADMAP_SCHEMA,
    timeoutClass: timeoutClassForTask(def.taskClass),
    companyId: input.companyId,
    accountId: input.accountId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

/**
 * The planning gate (CDR-039 §7-G1). Reads the company's LATEST decision and classifies it. Exported so the persist
 * transaction can re-apply exactly the same rule it used on the read — one definition, no drift.
 */
export function classifyPlanningGate(decision: DecisionRow | undefined): { readonly kind: 'open'; readonly decision: DecisionRow } | { readonly kind: 'no_decision' } | { readonly kind: 'rejected' } {
  if (decision === undefined) return { kind: 'no_decision' };
  // STRAT-006 records rejections too, so the mere existence of a decision must never unlock planning.
  if (decision.mode === 'reject') return { kind: 'rejected' };
  return { kind: 'open', decision };
}

type PreRead = { readonly kind: 'ready'; readonly decision: DecisionRow; readonly prompt: string; readonly nextVersion: number; readonly supersedes: string | null } | { readonly kind: 'forbidden' } | { readonly kind: 'no_decision' } | { readonly kind: 'rejected' };

export async function generateRoadmap(client: DatabaseClient, params: GenerateRoadmapParams, deps: RoadmapGenerationDeps, options: RoadmapGenerationOptions = {}): Promise<GenerateRoadmapResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  // 1. Gate + read the planning input (own scope; roadmap:generate authz).
  const read = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<PreRead> => {
      if (checkAuthorization(role, 'roadmap:generate', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { kind: 'forbidden' };
      const strategy = new StrategyRepository(scope.db);
      const gate = classifyPlanningGate(await strategy.latestDecisionForCompany(params.companyId));
      if (gate.kind !== 'open') return gate.kind === 'no_decision' ? { kind: 'no_decision' } : { kind: 'rejected' };
      // The decided option's content is the planning input. A `select` decision points at an option; an edit/combine
      // decision authored its own fields on the selection.
      const selection = await strategy.findSelection(gate.decision.selection_id);
      const fields = selection?.chosen_fields ?? (selection?.selected_option_id !== undefined && selection?.selected_option_id !== null ? (await strategy.findOption(selection.selected_option_id))?.fields : undefined);
      const planning = new PlanningRepository(scope.db);
      const latest = await planning.latestRoadmap(params.companyId);
      return {
        kind: 'ready',
        decision: gate.decision,
        prompt: formatDecisionForPlanning({ mode: gate.decision.mode, understandingVersion: gate.decision.understanding_version, fields: fields ?? {} }),
        nextVersion: (latest?.version ?? 0) + 1,
        supersedes: latest?.id ?? null,
      };
    },
    optsBase,
  );
  if (read.kind !== 'ran') return { status: 'forbidden' };
  const pre = read.value;
  if (pre.kind === 'forbidden') return { status: 'forbidden' };
  if (pre.kind === 'no_decision') return { status: 'no_decision' };
  if (pre.kind === 'rejected') return { status: 'decision_rejected' };

  // 2. Call the gateway (external; its own usage-metering tx). Model call BETWEEN scoped operations.
  const request = buildRoadmapRequest({ accountId: params.accountId, companyId: params.companyId, decision: pre.prompt, ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
  const result = await deps.gateway(request, options.correlationId !== undefined ? { correlationId: options.correlationId } : {});

  // 3. A gateway failure OR malformed output persists NOTHING — a failure must never masquerade as a partial roadmap.
  if (result.outcome !== 'ok') return { status: 'generation_failed' };
  const parsed = narrowRoadmapOutput(result.validatedOutput);
  if (parsed === undefined) return { status: 'generation_failed' };
  const status: RoadmapStatus = parsed.partial ? 'partial' : 'complete';

  if (options.beforePersist !== undefined) await options.beforePersist();

  // 4. Persist the version + goals + milestones + the audit in ONE company-scoped transaction (audit-or-nothing). The
  //    gate is RE-VERIFIED here: the decision may have been superseded (notably by a rejection) during the model call.
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GenerateRoadmapResult> => {
      if (checkAuthorization(role, 'roadmap:generate', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const strategy = new StrategyRepository(scope.db);
      const gate = classifyPlanningGate(await strategy.latestDecisionForCompany(params.companyId));
      if (gate.kind !== 'open' || gate.decision.id !== pre.decision.id) return { status: 'stale_decision' };
      const planning = new PlanningRepository(scope.db);
      // Another writer may have created a version during the model call — re-derive rather than reuse a stale number.
      const latest = await planning.latestRoadmap(params.companyId);
      if ((latest?.id ?? null) !== pre.supersedes) return { status: 'stale_decision' };

      const roadmap = await planning.insertRoadmap({
        accountId: params.accountId,
        companyId: params.companyId,
        version: pre.nextVersion,
        decisionId: gate.decision.id,
        status,
        origin: 'generated',
        supersedesRoadmapId: pre.supersedes,
        editReason: null,
        modelFlaggedPartial: parsed.partial,
        createdByUserId: params.userId,
      });

      const goalRows: GoalRow[] = [];
      for (let i = 0; i < parsed.goals.length; i += 1) {
        const g = parsed.goals[i]!;
        goalRows.push(await planning.insertGoal({ accountId: params.accountId, companyId: params.companyId, roadmapId: roadmap.id, ordinal: i, title: g.title, description: g.description }));
      }
      const milestoneRows: MilestoneRow[] = [];
      for (let i = 0; i < parsed.milestones.length; i += 1) {
        const m = parsed.milestones[i]!;
        // The parse already bounded goalOrdinal to the goals present, so this resolves or is deliberately unlinked.
        const goalId = m.goalOrdinal === null ? null : (goalRows[m.goalOrdinal]?.id ?? null);
        milestoneRows.push(await planning.insertMilestone({ accountId: params.accountId, companyId: params.companyId, roadmapId: roadmap.id, goalId, ordinal: i, title: m.title, description: m.description }));
      }

      // roadmap.generated in the SAME transaction — an audit failure rolls the whole version back.
      await audit(
        scope,
        roadmapGenerated({ roadmapId: roadmap.id, roadmapVersion: roadmap.version, goalCount: goalRows.length, milestoneCount: milestoneRows.length, status, modelFlaggedPartial: parsed.partial }),
        options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
      );
      deps.logger?.info('roadmap.generated', { metadata: { accountId: params.accountId, companyId: params.companyId, roadmapVersion: roadmap.version, goalCount: goalRows.length, milestoneCount: milestoneRows.length, status } });
      return { status: 'ok', roadmap: toRoadmapDTO(roadmap, goalRows, milestoneRows) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── reads (roadmap:read) ─────────────────────────────────────────────────────────────────────────────────
export interface RoadmapReadParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}
export type LatestRoadmapResult = { readonly status: 'ok'; readonly roadmap: RoadmapDTO | null } | { readonly status: 'forbidden' };

/** The company's CURRENT (highest-version) roadmap + its goals and milestones, or null when none exists yet. */
export async function getLatestRoadmap(client: DatabaseClient, params: RoadmapReadParams, options: RoadmapGenerationOptions = {}): Promise<LatestRoadmapResult> {
  const optsBase: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) optsBase.correlationId = options.correlationId;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<LatestRoadmapResult> => {
      if (checkAuthorization(role, 'roadmap:read', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
      const planning = new PlanningRepository(scope.db);
      const roadmap = await planning.latestRoadmap(params.companyId);
      if (roadmap === undefined) return { status: 'ok', roadmap: null };
      return { status: 'ok', roadmap: toRoadmapDTO(roadmap, await planning.listGoals(roadmap.id), await planning.listMilestones(roadmap.id)) };
    },
    optsBase,
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── mapping ──────────────────────────────────────────────────────────────────────────────────────────────
export function toRoadmapDTO(row: RoadmapRow, goals: readonly GoalRow[], milestones: readonly MilestoneRow[]): RoadmapDTO {
  return {
    roadmapId: row.id,
    companyId: row.company_id,
    version: row.version,
    decisionId: row.decision_id,
    status: row.status as RoadmapStatus,
    origin: row.origin as RoadmapOrigin,
    supersedesRoadmapId: row.supersedes_roadmap_id,
    editReason: row.edit_reason,
    modelFlaggedPartial: row.model_flagged_partial,
    goals: goals.map(toGoalDTO),
    milestones: milestones.map(toMilestoneDTO),
    createdAt: new Date(row.created_at).toISOString(),
  };
}
function toGoalDTO(row: GoalRow): GoalDTO {
  return { goalId: row.id, ordinal: row.ordinal, title: row.title, description: row.description, status: row.status as GoalStatus };
}
function toMilestoneDTO(row: MilestoneRow): MilestoneDTO {
  return { milestoneId: row.id, ordinal: row.ordinal, goalId: row.goal_id, title: row.title, description: row.description, status: row.status as MilestoneStatus };
}
