// @acbp/core — task generation and chat steering (ACBP-P4-003; CDR-040; PLAN-001/002; STRAT-005; ADR-019).
//
// Two entry points over one shared pipeline:
//   - `generateTasks`      — autonomous planning (PLAN-001). Produces 3+ prioritized, typed tasks traced to
//                            milestones, or an honest partial.
//   - `steerTaskPlanning`  — the owner directs planning in natural language (PLAN-002). Answers with tasks, a
//                            CLARIFYING question, or an honest REFUSAL — three distinct SUCCESSFUL outcomes.
//
// THE PREVIEW IS THE `draft` STATE, not a new mechanism. Canon already routes both paths through `draft`
// (diagrams/06 + WORKFLOW §4), and CDR-033 §4 defines a draft as "not on the board, no audit". So tasks are minted in
// `draft` — visible to the owner, absent from the board, writing no `task.created` — and confirming a preview is the
// existing `planTask` draft→planned transition. This use case therefore writes NO audit event of its own.
//
// THE STRAT-005 PHASE BOUNDARY IS ENFORCED HERE. CDR-037 §5 recorded P3-004's `phase_scope` as a flag and explicitly
// deferred "generates tasks solely for that phase / violations blocked server-side" to this ticket. The model is only
// ever shown the in-scope milestones, and every returned ordinal is re-checked against that same set server-side —
// an out-of-scope task is refused, never silently re-pointed.
import { PlanningRepository, StrategyRepository, TaskRepository, type DatabaseClient, type TaskRow, type MilestoneRow, type DecisionRow, type RoadmapRow, type TenantScope } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import type { MemberRole } from '../members/roles.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  narrowTaskPlanOutput,
  narrowSteeringOutput,
  normalizeSteeringRequest,
  countMissingType,
  resolveTemplateRef,
  renderTemplateSegments,
  templateRef,
  timeoutClassForTask,
  TASK_PLAN_SCHEMA,
  TASK_STEERING_SCHEMA,
  type ModelContextPart,
  type ModelGatewayRequest,
  type ModelGatewayResult,
  type PlannedTaskInput,
  type TaskDTO,
} from '@acbp/contracts';
import { classifyPlanningGate } from './roadmap-generation.js';
import { toTaskDTO } from '../tasks/task-management.js';
import type { Logger } from '@acbp/observability';

export type ModelGateway = (request: ModelGatewayRequest, options?: { readonly correlationId?: string }) => Promise<ModelGatewayResult>;

const ROADMAP_PROMPT_MAX = 12_000;

export interface GenerateTasksParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}
export interface SteerTaskPlanningParams extends GenerateTasksParams {
  /** The owner's natural-language request (PLAN-002). Bounded; blank/over-long is `invalid`. */
  readonly request: unknown;
}
export interface TaskPlanningDeps {
  readonly gateway: ModelGateway;
  readonly logger?: Logger;
}
export interface TaskPlanningOptions {
  readonly correlationId?: string;
  /** TEST SEAM ONLY: run between the model call and the persist transaction (to simulate a concurrent change). */
  readonly beforePersist?: () => Promise<void>;
}

/** The outcomes shared by both entry points. */
type PlanningFailure =
  | { readonly status: 'forbidden' }
  // No decision recorded yet — planning is blocked (J-08).
  | { readonly status: 'no_decision' }
  // The company's latest decision REJECTED the strategy; planning stays blocked (CDR-039 §7-G1).
  | { readonly status: 'decision_rejected' }
  // A decision exists but no roadmap has been generated — there are no milestones to trace tasks to.
  | { readonly status: 'no_roadmap' }
  // The approved phase contains no milestones, so there is nothing in scope to plan against (STRAT-005).
  | { readonly status: 'no_milestones_in_scope' }
  // The decision or the roadmap head changed during the model call — nothing is persisted.
  | { readonly status: 'stale_decision' }
  | { readonly status: 'stale_roadmap' }
  // The gateway failed, or its output was unusable. NOTHING is persisted — "no phantom tasks".
  | { readonly status: 'generation_failed' };

export type GenerateTasksResult =
  | {
      readonly status: 'ok';
      readonly tasks: readonly TaskDTO[];
      readonly partial: boolean;
      /**
       * How many of the returned tasks carry NO type. PLAN-001 wants a type on every task, but ADR-019/TASK-002 forbid
       * inventing one, so a shortfall is reported explicitly rather than absorbed silently — "planning failure is
       * visible with reason" applies to a partial shortfall too.
       */
      readonly tasksMissingType: number;
      /**
       * In-scope milestones the prompt budget could not fit, so the model never saw them. Non-zero forces `partial`:
       * the plan covers only a PREFIX of the approved phase, and reporting that as complete is the same
       * fabricated-completeness failure one level up from a task traced to an unseen milestone.
       */
      readonly milestonesOmitted: number;
    }
  | PlanningFailure;

export type SteerTaskPlanningResult =
  | { readonly status: 'ok'; readonly tasks: readonly TaskDTO[]; readonly intent: string; readonly tasksMissingType: number; readonly milestonesOmitted: number }
  // "Ambiguous requests trigger clarification, not guessed execution" — a SUCCESSFUL answer, not a failure.
  | { readonly status: 'clarification_needed'; readonly question: string }
  // "relevant tasks or an honest refusal" — also a SUCCESSFUL answer.
  | { readonly status: 'refused'; readonly reason: string }
  | { readonly status: 'invalid' }
  | PlanningFailure;

/**
 * Render the in-scope milestones into the bounded `{{roadmap}}` prompt text.
 *
 * Returns the milestones ACTUALLY INCLUDED alongside the text, and the caller uses THAT array as the ordinal space.
 * A blind `.slice(ROADMAP_PROMPT_MAX)` would silently desynchronize the two: with enough long descriptions the tail of
 * the list would be cut from the prompt while the parser still accepted its ordinals, so tasks could persist —
 * complete and unflagged — traced to milestones the model never read. That is fabricated traceability (ADR-019), so
 * "shown" and "resolvable" are made the same set by construction: whole milestones are added until the budget is
 * exhausted, never a half one.
 */
export function formatMilestonesForPlanning(roadmap: RoadmapRow, milestones: readonly MilestoneRow[]): { readonly prompt: string; readonly shown: readonly MilestoneRow[] } {
  const head = `Roadmap version ${roadmap.version}${roadmap.status === 'partial' ? ' (partial)' : ''}`;
  const shown: MilestoneRow[] = [];
  const lines: string[] = [];
  let used = head.length;
  for (const m of milestones) {
    const line = `Milestone ${shown.length}: ${m.title}${m.description === null ? '' : ` — ${m.description}`}`;
    if (used + line.length + 1 > ROADMAP_PROMPT_MAX) break; // whole milestones only — never a truncated one
    shown.push(m);
    lines.push(line);
    used += line.length + 1;
  }
  return { prompt: [head, ...lines].join('\n'), shown };
}

function buildRequest(family: 'planning.tasks@1' | 'planning.task_steering@1', schemaRef: string, input: { accountId: string; companyId: string; values: Record<string, string>; correlationId?: string }): ModelGatewayRequest {
  const def = resolveTemplateRef(family);
  const contextParts: ModelContextPart[] = renderTemplateSegments(def, input.values).map((s) => ({ role: s.role, content: s.text }));
  return {
    taskClass: def.taskClass,
    templateRef: templateRef(def),
    contextParts,
    outputSchemaRef: schemaRef,
    timeoutClass: timeoutClassForTask(def.taskClass),
    companyId: input.companyId,
    accountId: input.accountId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  };
}

/**
 * The STRAT-005 phase boundary (CDR-040 §8-G3). `whole_plan` (or no recorded scope) plans against every milestone;
 * `first_phase` restricts to the FIRST GOAL's milestones — or, when the roadmap has no goals, the single
 * lowest-ordinal milestone. Canon defines no "phase" object (CDR-037 §5 says so explicitly), so this is the narrowest
 * honest reading, and STRAT-005's "violations are blocked server-side" argues for the restrictive interpretation.
 */
export function milestonesInPhaseScope(phaseScope: string | null, goals: readonly { readonly id: string; readonly ordinal: number }[], milestones: readonly MilestoneRow[]): readonly MilestoneRow[] {
  if (phaseScope !== 'first_phase') return milestones;
  const firstGoal = goals.reduce<{ readonly id: string; readonly ordinal: number } | undefined>((lowest, g) => (lowest === undefined || g.ordinal < lowest.ordinal ? g : lowest), undefined);
  if (firstGoal === undefined) {
    // No goals to phase by — the honest minimum is the single first milestone, not the whole plan.
    return milestones.length === 0 ? [] : [milestones[0]!];
  }
  return milestones.filter((m) => m.goal_id === firstGoal.id);
}

type PreRead =
  | {
      readonly kind: 'ready';
      readonly decision: DecisionRow;
      readonly roadmap: RoadmapRow;
      readonly inScope: readonly MilestoneRow[];
      readonly prompt: string;
      /** In-scope milestones the prompt budget could not fit. Non-zero means the plan CANNOT be complete (§below). */
      readonly milestonesOmitted: number;
    }
  | { readonly kind: 'failure'; readonly result: PlanningFailure };

/** Gate + read the planning input under company scope. Shared by both entry points so the rules cannot drift. */
async function readPlanningInput(client: DatabaseClient, params: GenerateTasksParams, optsBase: Record<string, unknown>): Promise<PreRead | { readonly kind: 'scope_denied' }> {
  const read = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<PreRead> => {
      if (checkAuthorization(role, 'task:generate', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { kind: 'failure', result: { status: 'forbidden' } };
      const strategy = new StrategyRepository(scope.db);
      const gate = classifyPlanningGate(await strategy.latestDecisionForCompany(params.companyId));
      if (gate.kind === 'no_decision') return { kind: 'failure', result: { status: 'no_decision' } };
      if (gate.kind === 'rejected') return { kind: 'failure', result: { status: 'decision_rejected' } };

      const planning = new PlanningRepository(scope.db);
      const roadmap = await planning.latestRoadmap(params.companyId);
      // Every task must trace to a milestone (ROAD-001 / M4 exit); with no roadmap there is nothing to trace to.
      if (roadmap === undefined) return { kind: 'failure', result: { status: 'no_roadmap' } };

      // STRAT-005: the approved phase scope restricts what may be planned at all. FAIL CLOSED if the selection cannot
      // be resolved — an unresolvable selection is not "no phase scope recorded", and defaulting to the whole plan
      // would silently widen the approved boundary.
      const selection = await strategy.findSelection(gate.decision.selection_id);
      if (selection === undefined) return { kind: 'failure', result: { status: 'generation_failed' } };
      const inPhase = milestonesInPhaseScope(selection.phase_scope, await planning.listGoals(roadmap.id), await planning.listMilestones(roadmap.id));
      if (inPhase.length === 0) return { kind: 'failure', result: { status: 'no_milestones_in_scope' } };

      // The ordinal space is exactly what the prompt SHOWS (see formatMilestonesForPlanning) — never a superset.
      const { prompt, shown } = formatMilestonesForPlanning(roadmap, inPhase);
      if (shown.length === 0) return { kind: 'failure', result: { status: 'no_milestones_in_scope' } };
      return { kind: 'ready', decision: gate.decision, roadmap, inScope: shown, prompt, milestonesOmitted: inPhase.length - shown.length };
    },
    optsBase,
  );
  return read.kind === 'ran' ? read.value : { kind: 'scope_denied' };
}

/**
 * Persist the planned tasks as DRAFTS in one company-scoped transaction, after RE-VERIFYING the gate and the roadmap
 * head (the P4-001 pattern). No audit event is written — a draft is not on the board (CDR-033 §4); `task.created`
 * fires when the owner confirms via `planTask`.
 */
async function persistDrafts(
  client: DatabaseClient,
  params: GenerateTasksParams,
  pre: Extract<PreRead, { kind: 'ready' }>,
  planned: readonly PlannedTaskInput[],
  optsBase: Record<string, unknown>,
): Promise<{ readonly status: 'ok'; readonly tasks: readonly TaskDTO[] } | PlanningFailure> {
  const body = async (scope: TenantScope, role: MemberRole): Promise<{ readonly status: 'ok'; readonly tasks: readonly TaskDTO[] } | PlanningFailure> => {
    if (checkAuthorization(role, 'task:generate', { accountId: params.accountId, actorId: params.userId }, optsBase).kind === 'deny') return { status: 'forbidden' };
    const strategy = new StrategyRepository(scope.db);
    const gate = classifyPlanningGate(await strategy.latestDecisionForCompany(params.companyId));
    if (gate.kind !== 'open' || gate.decision.id !== pre.decision.id) return { status: 'stale_decision' };
    const planning = new PlanningRepository(scope.db);
    const latest = await planning.latestRoadmap(params.companyId);
    // A roadmap edit during the model call would leave these tasks pinned to a superseded version — exactly what
    // ROAD-002's affected-task flagging exists to avoid. Persist nothing instead.
    if (latest === undefined || latest.id !== pre.roadmap.id) return { status: 'stale_roadmap' };

    // Server-side phase-boundary re-check (STRAT-005 "violations are blocked server-side"), done for the WHOLE batch
    // BEFORE anything is inserted. The parse already bounded the ordinal to the in-scope set, but that bound comes
    // from an INJECTED validator, so a validator built against a wider milestone count — a wiring mistake, not a model
    // one — would let an out-of-scope ordinal reach here. Re-resolving means a violation can never be silently
    // re-pointed at an in-scope milestone.
    //
    // RESOLVE-THEN-INSERT, deliberately: checking inside the insert loop would mean a late violation is discovered
    // after earlier tasks are already inserted, and simply returning there would COMMIT them — phantom tasks under a
    // "no phantom tasks" result. Rolling back via a throw would also work, but the transaction helper normalizes and
    // re-wraps thrown errors, so control flow would depend on unwrapping a `cause` chain. Resolving first leaves
    // nothing to roll back: on a violation this returns before the first write.
    const resolved: MilestoneRow[] = [];
    for (const t of planned) {
      const milestone = pre.inScope[t.milestoneOrdinal];
      if (milestone === undefined) return { status: 'generation_failed' };
      resolved.push(milestone);
    }

    const tasks = new TaskRepository(scope.db);
    // Ranks continue after whatever planning already produced, so a second run does not restate rank 0. Read the MAX
    // directly rather than scanning a page: a page could miss older ranked rows behind newer unranked (manually
    // created) ones and silently restart at 0.
    //
    // Read HERE, inside the persist transaction, not in the pre-read: the model call sits between the two, so a rank
    // read before it is stale by exactly the width of that call. Two overlapping runs would both see max = -1 and both
    // write ranks 0,1,2 — and since `priority` has no uniqueness constraint nothing would error, leaving the company
    // with a silently ambiguous order under a result that claims to be "prioritized".
    const nextPriority = (await tasks.maxPriority(params.companyId)) + 1;
    const rows: TaskRow[] = [];
    for (let i = 0; i < planned.length; i += 1) {
      const t = planned[i]!;
      rows.push(
        await tasks.insert({
          accountId: params.accountId,
          companyId: params.companyId,
          title: t.title,
          description: t.description,
          milestoneId: resolved[i]!.id,
          taskType: t.taskType,
          priority: nextPriority + i,
          createdByUserId: params.userId,
        }),
      );
    }
    return { status: 'ok', tasks: rows.map(toTaskDTO) };
  };

  const run = await runInCompanyScope(client, { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId }, body, optsBase);
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

/** PLAN-001 — autonomous planning. 3+ prioritized, typed, milestone-traced tasks, or an honest partial. */
export async function generateTasks(client: DatabaseClient, params: GenerateTasksParams, deps: TaskPlanningDeps, options: TaskPlanningOptions = {}): Promise<GenerateTasksResult> {
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  const pre = await readPlanningInput(client, params, optsBase);
  if (pre.kind === 'scope_denied') return { status: 'forbidden' };
  if (pre.kind === 'failure') return pre.result;

  const request = buildRequest('planning.tasks@1', TASK_PLAN_SCHEMA, { accountId: params.accountId, companyId: params.companyId, values: { roadmap: pre.prompt }, ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
  const result = await deps.gateway(request, options.correlationId !== undefined ? { correlationId: options.correlationId } : {});

  // A gateway failure or an unusable output persists NOTHING — "Planning failure visible; no phantom tasks".
  if (result.outcome !== 'ok') return { status: 'generation_failed' };
  const parsed = narrowTaskPlanOutput(result.validatedOutput, pre.inScope.length);
  if (parsed === undefined) return { status: 'generation_failed' };

  if (options.beforePersist !== undefined) await options.beforePersist();

  const persisted = await persistDrafts(client, params, pre, parsed.tasks, optsBase);
  if (persisted.status !== 'ok') return persisted;
  const tasksMissingType = countMissingType(parsed.tasks);
  // A truncated prompt means the model planned against a PREFIX of the approved phase, so the plan cannot honestly be
  // called complete no matter what the model said about itself.
  const partial = parsed.partial || pre.milestonesOmitted > 0;
  deps.logger?.info('planning.tasks_drafted', { metadata: { accountId: params.accountId, companyId: params.companyId, roadmapVersion: pre.roadmap.version, taskCount: persisted.tasks.length, partial, tasksMissingType, inScopeMilestones: pre.inScope.length, milestonesOmitted: pre.milestonesOmitted } });
  return { status: 'ok', tasks: persisted.tasks, partial, tasksMissingType, milestonesOmitted: pre.milestonesOmitted };
}

/** PLAN-002 — the owner steers planning. Answers with tasks, a clarifying question, or an honest refusal. */
export async function steerTaskPlanning(client: DatabaseClient, params: SteerTaskPlanningParams, deps: TaskPlanningDeps, options: TaskPlanningOptions = {}): Promise<SteerTaskPlanningResult> {
  const optsBase = { ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}), ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };

  const pre = await readPlanningInput(client, params, optsBase);
  if (pre.kind === 'scope_denied') return { status: 'forbidden' };
  if (pre.kind === 'failure') return pre.result;
  // Validated AFTER the authz gate inside readPlanningInput, so an unauthorized caller never learns whether their
  // request would have parsed.
  const request = normalizeSteeringRequest(params.request);
  if (request === undefined) return { status: 'invalid' };

  const gatewayRequest = buildRequest('planning.task_steering@1', TASK_STEERING_SCHEMA, { accountId: params.accountId, companyId: params.companyId, values: { roadmap: pre.prompt, steering_request: request }, ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
  const result = await deps.gateway(gatewayRequest, options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
  if (result.outcome !== 'ok') return { status: 'generation_failed' };
  const answer = narrowSteeringOutput(result.validatedOutput, pre.inScope.length);
  if (answer === undefined) return { status: 'generation_failed' };

  // A clarification and a refusal are SUCCESSFUL answers — reporting either as a failure would misrepresent an honest
  // model response as a system fault (PLAN-002's acceptance + failure clauses). Neither persists anything.
  if (answer.outcome === 'clarification') {
    deps.logger?.info('planning.steering_clarification', { metadata: { accountId: params.accountId, companyId: params.companyId } });
    return { status: 'clarification_needed', question: answer.question };
  }
  if (answer.outcome === 'refusal') {
    deps.logger?.info('planning.steering_refused', { metadata: { accountId: params.accountId, companyId: params.companyId } });
    return { status: 'refused', reason: answer.reason };
  }

  if (options.beforePersist !== undefined) await options.beforePersist();

  const persisted = await persistDrafts(client, params, pre, answer.tasks, optsBase);
  if (persisted.status !== 'ok') return persisted;
  // Steered tasks run through the same parse, so they carry the same honesty obligations as the autonomous path.
  const tasksMissingType = countMissingType(answer.tasks);
  deps.logger?.info('planning.steering_drafted', { metadata: { accountId: params.accountId, companyId: params.companyId, roadmapVersion: pre.roadmap.version, taskCount: persisted.tasks.length, tasksMissingType, milestonesOmitted: pre.milestonesOmitted } });
  // The interpreted intent is returned for PREVIEW and never persisted (CDR-040 §8-G8 — the input snapshot is P4-006).
  return { status: 'ok', tasks: persisted.tasks, intent: answer.intent, tasksMissingType, milestonesOmitted: pre.milestonesOmitted };
}
