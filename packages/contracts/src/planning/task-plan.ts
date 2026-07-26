// @acbp/contracts — task planning + chat steering (ACBP-P4-003; CDR-040; PLAN-001/002). Zero-dep, provider-neutral.
//
// Two model-facing shapes, because the two use cases answer different questions:
//   - `planning.tasks.output@1`      — autonomous planning. Returns tasks (or an honest partial). PLAN-001 requires
//                                      3+ tasks, so fewer is only acceptable when the model FLAGS it partial.
//   - `planning.task_steering.output@1` — a natural-language request. Returns ONE of three honest outcomes: tasks, a
//                                      CLARIFYING question, or a REFUSAL. Those three are all *successful* answers —
//                                      conflating any of them with a gateway/parse failure would report an honest
//                                      model answer as a system fault (PLAN-002's acceptance + failure clauses).
//
// Every task names the milestone it serves BY ORDINAL within the roadmap the model was shown, so a task can never
// dangle (ROAD-001 "generated tasks trace to milestones"; the DB FK is the second line of defence). Parsing is
// deny-by-default: one malformed member rejects the whole payload rather than being silently dropped.

const FAIL = { ok: false } as const;

/**
 * The closed initial task-type set (MASTER-PRD-v1 "Initial task types"). Closed deliberately (CDR-040 §8-G2): the PRD
 * calls them "initial", so the set may grow, and widening a closed set later is additive while narrowing is not.
 */
export const TASK_TYPES = [
  'market_research',
  'competitor_research',
  'customer_segment_analysis',
  'business_model_comparison',
  'business_plan_generation',
  'landing_page_copy',
  'internal_product_requirements',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export function isTaskType(v: unknown): v is TaskType {
  return typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v);
}

/** The gateway output-schema refs (the composition dispatches validateOutput on these). */
export const TASK_PLAN_SCHEMA = 'planning.tasks.output@1';
export const TASK_STEERING_SCHEMA = 'planning.task_steering.output@1';

export const PLANNED_TASK_TITLE_MAX = 200;
export const PLANNED_TASK_DESCRIPTION_MAX = 4_000;
export const STEERING_REQUEST_MAX = 2_000;
export const STEERING_MESSAGE_MAX = 1_000;
/** A bound on how many tasks one planning run may propose — a plan, not a dump. */
export const PLANNED_TASKS_MAX = 50;
/** PLAN-001: "Planning produces 3+ prioritized tasks" (CDR-040 §8-G10 — autonomous generation only). */
export const PLANNED_TASKS_MIN = 3;

/**
 * One planned task as the model proposes it. `priority` is the platform-assigned RANK (the model's own ordering), NOT
 * a scale — an invented high/medium/low would be the fabricated precision ADR-019 forbids (CDR-040 §8-G1).
 */
export interface PlannedTaskInput {
  readonly title: string;
  readonly description: string | null;
  readonly taskType: TaskType | null;
  /** The milestone this task serves, by ordinal within the roadmap shown to the model. Never dangling. */
  readonly milestoneOrdinal: number;
}

export interface TaskPlanOutput {
  readonly tasks: readonly PlannedTaskInput[];
  readonly partial: boolean;
}
export type TaskPlanParse = { readonly ok: true; readonly value: TaskPlanOutput } | { readonly ok: false };

/** The three honest steering answers (PLAN-002). All are SUCCESSFUL outcomes — none is a failure. */
export type SteeringOutput =
  | { readonly outcome: 'tasks'; readonly tasks: readonly PlannedTaskInput[]; readonly intent: string }
  // "Ambiguous requests trigger clarification, not guessed execution."
  | { readonly outcome: 'clarification'; readonly question: string }
  // "relevant tasks or an honest refusal."
  | { readonly outcome: 'refusal'; readonly reason: string };
export type SteeringParse = { readonly ok: true; readonly value: SteeringOutput } | { readonly ok: false };

// ── shared field helpers (deny-by-default: undefined means "unusable", never "absent") ────────────────────
function title(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 || t.length > PLANNED_TASK_TITLE_MAX ? undefined : t;
}
function description(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t.length > PLANNED_TASK_DESCRIPTION_MAX) return undefined;
  return t.length === 0 ? null : t;
}
/** A bounded non-blank message (a clarifying question, a refusal reason, or the interpreted intent). */
function message(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 || t.length > max ? undefined : t;
}

/**
 * Parse one proposed task. `milestoneOrdinal` MUST resolve inside the roadmap the model was shown, so a task can never
 * be persisted against a milestone that does not exist (ROAD-001 traceability, enforced before the DB FK ever sees it).
 */
function plannedTask(raw: unknown, milestoneCount: number): PlannedTaskInput | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const t = title((raw as { title?: unknown }).title);
  const d = description((raw as { description?: unknown }).description);
  if (t === undefined || d === undefined) return undefined;
  // PLAN-001 requires a type on every task; an UNKNOWN type is null rather than a guess (ADR-019) — the use case
  // surfaces it as explicitly missing (TASK-002) instead of inventing one.
  const rawType = (raw as { task_type?: unknown }).task_type;
  let taskType: TaskType | null = null;
  if (rawType !== undefined && rawType !== null) {
    if (!isTaskType(rawType)) return undefined; // a MALFORMED type is a rejection, not a silent null
    taskType = rawType;
  }
  const rawOrdinal = (raw as { milestone_ordinal?: unknown }).milestone_ordinal;
  if (typeof rawOrdinal !== 'number' || !Number.isInteger(rawOrdinal) || rawOrdinal < 0 || rawOrdinal >= milestoneCount) return undefined;
  return { title: t, description: d, taskType, milestoneOrdinal: rawOrdinal };
}

/** Every task list must be non-empty, bounded, and (for autonomous planning) meet PLAN-001's 3+ unless flagged partial. */
function taskListOk(tasks: readonly PlannedTaskInput[], partial: boolean, enforceMinimum: boolean): boolean {
  if (tasks.length === 0) return false;
  if (tasks.length > PLANNED_TASKS_MAX) return false;
  if (enforceMinimum && tasks.length < PLANNED_TASKS_MIN && !partial) return false;
  return true;
}

/**
 * Parse an autonomous planning output (the gateway shape-validator for `planning.tasks.output@1`). DENY-BY-DEFAULT:
 * one malformed task rejects the WHOLE plan. `partial` is strict (absent → complete; non-boolean → reject, never
 * coerced), so PLAN-001's 3+ can only be relaxed by the model honestly saying it could not plan further.
 */
export function parseTaskPlanOutput(raw: string, milestoneCount: number): TaskPlanParse {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return FAIL;
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return FAIL;
  const obj = root as { tasks?: unknown; partial?: unknown };
  const rawPartial = obj.partial;
  if (rawPartial !== undefined && typeof rawPartial !== 'boolean') return FAIL;
  const partial = rawPartial === true;
  if (!Array.isArray(obj.tasks)) return FAIL;
  const tasks: PlannedTaskInput[] = [];
  for (const t of obj.tasks) {
    const parsed = plannedTask(t, milestoneCount);
    if (parsed === undefined) return FAIL;
    tasks.push(parsed);
  }
  if (!taskListOk(tasks, partial, true)) return FAIL;
  return { ok: true, value: { tasks, partial } };
}

/**
 * Parse a steering output (`planning.task_steering.output@1`). The `outcome` discriminator is CLOSED and required —
 * an absent or unknown outcome is a rejection, never a defaulted "tasks", because guessing which answer the model
 * meant is exactly the "guessed execution" PLAN-002 forbids.
 */
export function parseSteeringOutput(raw: string, milestoneCount: number): SteeringParse {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return FAIL;
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return FAIL;
  const obj = root as { outcome?: unknown; tasks?: unknown; intent?: unknown; question?: unknown; reason?: unknown };

  if (obj.outcome === 'clarification') {
    const q = message(obj.question, STEERING_MESSAGE_MAX);
    return q === undefined ? FAIL : { ok: true, value: { outcome: 'clarification', question: q } };
  }
  if (obj.outcome === 'refusal') {
    const r = message(obj.reason, STEERING_MESSAGE_MAX);
    return r === undefined ? FAIL : { ok: true, value: { outcome: 'refusal', reason: r } };
  }
  if (obj.outcome !== 'tasks') return FAIL;

  // The interpreted intent is what PLAN-002 requires be PREVIEWED ("intent and effect are previewed before task
  // creation"). It is returned to the caller and never persisted (CDR-040 §8-G8).
  const intent = message(obj.intent, STEERING_MESSAGE_MAX);
  if (intent === undefined) return FAIL;
  if (!Array.isArray(obj.tasks)) return FAIL;
  const tasks: PlannedTaskInput[] = [];
  for (const t of obj.tasks) {
    const parsed = plannedTask(t, milestoneCount);
    if (parsed === undefined) return FAIL;
    tasks.push(parsed);
  }
  // No 3+ minimum on steering: "relevant tasks or an honest refusal" — one relevant task is a legitimate answer.
  if (!taskListOk(tasks, false, false)) return FAIL;
  return { ok: true, value: { outcome: 'tasks', tasks, intent } };
}

/**
 * Defensively re-enter the gateway's ALREADY-VALIDATED planning output (no raw re-parse). It re-applies the same
 * PERSISTABILITY invariants as the parse — the gateway is injected, so a caller wiring a different or missing
 * validator must not be able to persist a plan the parser exists to reject (the CDR-039 §7-G10 lesson).
 */
export function narrowTaskPlanOutput(validated: unknown, milestoneCount: number, enforceMinimum = true): TaskPlanOutput | undefined {
  if (typeof validated !== 'object' || validated === null) return undefined;
  const v = validated as { tasks?: unknown; partial?: unknown };
  if (!Array.isArray(v.tasks) || typeof v.partial !== 'boolean') return undefined;
  const tasks = narrowTasks(v.tasks, milestoneCount);
  if (tasks === undefined || !taskListOk(tasks, v.partial, enforceMinimum)) return undefined;
  return { tasks, partial: v.partial };
}

/** Defensive re-entry for a steering output — same reasoning as `narrowTaskPlanOutput`. */
export function narrowSteeringOutput(validated: unknown, milestoneCount: number): SteeringOutput | undefined {
  if (typeof validated !== 'object' || validated === null) return undefined;
  const v = validated as { outcome?: unknown; tasks?: unknown; intent?: unknown; question?: unknown; reason?: unknown };
  if (v.outcome === 'clarification') {
    return typeof v.question === 'string' && v.question.length > 0 && v.question.length <= STEERING_MESSAGE_MAX ? { outcome: 'clarification', question: v.question } : undefined;
  }
  if (v.outcome === 'refusal') {
    return typeof v.reason === 'string' && v.reason.length > 0 && v.reason.length <= STEERING_MESSAGE_MAX ? { outcome: 'refusal', reason: v.reason } : undefined;
  }
  if (v.outcome !== 'tasks') return undefined;
  if (typeof v.intent !== 'string' || v.intent.length === 0 || v.intent.length > STEERING_MESSAGE_MAX) return undefined;
  if (!Array.isArray(v.tasks)) return undefined;
  const tasks = narrowTasks(v.tasks, milestoneCount);
  if (tasks === undefined || !taskListOk(tasks, false, false)) return undefined;
  return { outcome: 'tasks', tasks, intent: v.intent };
}

function narrowTasks(raw: readonly unknown[], milestoneCount: number): PlannedTaskInput[] | undefined {
  const tasks: PlannedTaskInput[] = [];
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) return undefined;
    const { title: ti, description: d, taskType, milestoneOrdinal: o } = t as { title?: unknown; description?: unknown; taskType?: unknown; milestoneOrdinal?: unknown };
    if (typeof ti !== 'string' || ti.length === 0 || ti.length > PLANNED_TASK_TITLE_MAX) return undefined;
    if (d !== null && (typeof d !== 'string' || d.length === 0 || d.length > PLANNED_TASK_DESCRIPTION_MAX)) return undefined;
    if (taskType !== null && !isTaskType(taskType)) return undefined;
    if (typeof o !== 'number' || !Number.isInteger(o) || o < 0 || o >= milestoneCount) return undefined;
    tasks.push({ title: ti, description: d, taskType, milestoneOrdinal: o });
  }
  return tasks;
}

/** The bounded natural-language request an owner types into the steering surface (PLAN-002). */
export function normalizeSteeringRequest(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 || t.length > STEERING_REQUEST_MAX ? undefined : t;
}
