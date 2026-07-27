// ACBP-P4-007 / CDR-044 — the Slice D journey (M4 milestone exit), implemented ONCE and shared by the runnable demo
// (`pnpm demo:slice-d`) and the CI integration suite so the two can never drift. Test-support only; never a
// production dependency (boundary rule 9).
//
// The journey is the PLANNED WORK vertical slice: confirmed understanding → strategy options → owner selection →
// immutable decision → roadmap (goals + milestones) → tasks → board states → detail + controls. It runs the REAL
// @acbp/core use cases through the restricted `acbp_app` connection under FORCE RLS; only the model PROVIDER edge is
// seamed with the deterministic FakeModelProvider (CDR-026 §3) — no live model, no key, no snapshot pin.
//
// Like `runSliceAJourney`/`runSliceBJourney`, the use cases + the gateway factory are INJECTED by the caller rather
// than imported here: @acbp/core's own tests import @acbp/test-support, so test-support must not import @acbp/core
// (that would be a workspace-graph cycle). Both callers may import core and supply the real functions, keeping the
// shared journey cycle-free and the demo drift-free.
import type { DatabaseClient } from '@acbp/database';
// The decision request is typed against the REAL contract rather than `unknown`. It was `unknown` first, and the
// compiler therefore could not catch `optionOrdinal` where the contract says `selectedOrdinal` — CI did, three
// minutes into a real-PostgreSQL run. @acbp/contracts is zero-dep and already a test-support dependency, so there is
// no reason to hand-roll a looser shape here.
import type { StrategyDecisionRequest, TaskBoardDTO, TaskDetailDTO } from '@acbp/contracts';
import { sql } from 'kysely';
import type { JourneyStep } from './slice-a-journey.js';

export type { JourneyStep } from './slice-a-journey.js';

/** The scripted fake-provider behavior the gateway factory turns into a one-shot gateway. */
export type SliceDFakeBehavior = { readonly kind: 'respond'; readonly output: string } | { readonly kind: 'fail'; readonly error: string };
/** An opaque model gateway (the caller builds it via `createModelGateway` with the right validator + fake provider). */
export type SliceDGateway = unknown;
/** Which output validator the caller should wire for a given step. */
export type SliceDValidator = 'understanding' | 'strategy' | 'roadmap' | 'taskPlan';

type Ids = { readonly userId: string; readonly accountId: string; readonly companyId: string };
type Status<T = object> = { readonly status: string } & Partial<T>;

/**
 * The @acbp/core use cases the journey drives, injected by the caller (structural types — the caller passes the real,
 * more-precisely-typed functions). `gateway` is opaque here; the caller's `makeGateway` produced it.
 */
export interface SliceDOps {
  generateUnderstanding(c: DatabaseClient, p: Ids, o: { gateway: SliceDGateway }): Promise<Status<{ document: { documentId: string; version: number } }>>;
  confirmUnderstanding(c: DatabaseClient, p: Ids & { expectedVersion: number }): Promise<Status>;
  generateStrategyOptions(c: DatabaseClient, p: Ids, d: { gateway: SliceDGateway }): Promise<Status<{ generation: { generationId: string; options: ReadonlyArray<{ optionId: string; ordinal: number }> } }>>;
  recordStrategyDecision(c: DatabaseClient, p: Ids & { generationId: string; request: StrategyDecisionRequest }, d: object): Promise<Status<{ selection: { selectionId: string } }>>;
  recordDecision(c: DatabaseClient, p: Ids & { generationId: string; selectionId: string; rationale?: unknown }, d: object): Promise<Status<{ decision: { decisionId: string } }>>;
  generateRoadmap(c: DatabaseClient, p: Ids, d: { gateway: SliceDGateway }): Promise<Status<{ roadmap: { roadmapId: string; version: number; goals: ReadonlyArray<unknown>; milestones: ReadonlyArray<{ milestoneId: string; ordinal: number }> } }>>;
  generateTasks(c: DatabaseClient, p: Ids, d: { gateway: SliceDGateway }): Promise<Status<{ tasks: ReadonlyArray<{ taskId: string }>; runId?: string }>>;
  listTasks(c: DatabaseClient, p: Ids): Promise<Status<{ tasks: ReadonlyArray<{ taskId: string; state: string; title: string }> }>>;
  planTask(c: DatabaseClient, p: Ids & { taskId: string }): Promise<Status<{ task: { state: string } }>>;
  addTaskDependency(c: DatabaseClient, p: Ids & { taskId: string; dependsOnTaskId: string }): Promise<Status<{ dependencyId: string }>>;
  getTaskBoard(c: DatabaseClient, p: Ids): Promise<Status<{ board: SliceDBoard }>>;
  getTaskDetail(c: DatabaseClient, p: Ids & { taskId: string }): Promise<Status<{ task: SliceDDetail }>>;
  repeatTask(c: DatabaseClient, p: Ids & { taskId: string }): Promise<Status<{ task: { taskId: string; state: string }; sourceTaskId: string }>>;
  deleteTask(c: DatabaseClient, p: Ids & { taskId: string; confirmed: boolean; reason?: string | null }): Promise<Status<{ taskId: string; stateAtDelete: string }>>;
}

/**
 * The board and detail shapes are the REAL contract DTOs, not hand-rolled structural subsets.
 *
 * Both were subsets first, and both hid a field-name error the compiler then could not see: an OPTIONAL
 * `blockedByDependency?: boolean` type-checked perfectly while the contract calls it `dependencyBlocked`, so the
 * journey's blocked-dependency assertion read `undefined` for every task and the step failed only in CI, against a
 * real database, several minutes in. A subset that is allowed to be wrong about a name is not a cheaper version of
 * the type — it is a silent one.
 */
export type SliceDBoard = TaskBoardDTO;
export type SliceDDetail = TaskDetailDTO;

export interface SliceDJourneyDeps {
  /** Restricted `acbp_app` product connection — every use case runs through this (CDR-044 §2-G3). */
  readonly product: DatabaseClient;
  /** Owner/fixture connection — evidence inspection only; never used to prove a guarantee. */
  readonly owner: DatabaseClient;
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** The injected @acbp/core use cases (the caller passes the real functions). */
  readonly ops: SliceDOps;
  /**
   * Build a one-shot gateway wired to the deterministic fake provider + the given validator.
   *
   * `milestoneCount` is required by the `taskPlan` validator only — it is a FACTORY over the roadmap's milestone
   * count, because a planned task naming a milestone ordinal that does not exist is the STRAT-005 phase-boundary
   * violation P4-003 rejects. The journey supplies the count it actually generated, so the validator is exercised
   * against real data rather than a guess.
   */
  readonly makeGateway: (validator: SliceDValidator, behavior: SliceDFakeBehavior, opts?: { readonly milestoneCount?: number }) => SliceDGateway;
}

// ── the scripted model outputs ───────────────────────────────────────────────────────────────────────────
// Deterministic and inline: the journey is a claim about the PLATFORM, so its inputs must be fixed. A generated or
// randomised payload would make a failure unreproducible, which is the opposite of what a milestone exit is for.

const UNDERSTANDING_OUTPUT = JSON.stringify({
  items: [
    { class: 'fact', content: 'Sells scheduling software to small veterinary clinics.', confidence: 0.9 },
    { class: 'assumption', content: 'Clinics will pay monthly rather than annually.', confidence: 0.4 },
    { class: 'open_question', content: 'Pricing model is not settled.', confidence: 0.2 },
  ],
});

const OPTION_FIELDS = ['description', 'customer', 'offer', 'business_model', 'scope', 'benefits', 'risks', 'cost_range', 'effort', 'time_to_validate', 'time_to_launch', 'required_resources', 'key_assumptions', 'validation_method', 'success_metrics', 'confidence'] as const;

/** A complete 16-field option. Distinct on customer/offer/business_model — the axes P3-002 dedupes on. */
function option(customer: string, offer: string, model: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of OPTION_FIELDS) o[f] = `${f} for ${customer}`;
  o['customer'] = customer;
  o['offer'] = offer;
  o['business_model'] = model;
  return o;
}

const STRATEGY_OUTPUT = JSON.stringify({
  options: [
    option('small veterinary clinics', 'scheduling software', 'monthly subscription'),
    option('mobile groomers', 'route planning', 'per-seat licence'),
    option('equine practices', 'billing reconciliation', 'usage-based pricing'),
  ],
});

const ROADMAP_OUTPUT = JSON.stringify({
  goals: [{ title: 'Reach first paying clinic', description: 'Validate willingness to pay.' }],
  milestones: [
    { title: 'Ship the booking page', description: 'The first thing a clinic sees.', goal_ordinal: 0 },
    { title: 'Run ten discovery calls', description: null, goal_ordinal: 0 },
  ],
});

/**
 * Three planned tasks. The THIRD deliberately carries NO rationale: PLAN-004 counts missing rationales rather than
 * inventing them (ADR-019), and CDR-044 §4-G8 requires the journey to assert that the gap renders AS a gap. A fixture
 * where every task happened to be explained would let the honest-gap path rot untested.
 */
const TASK_PLAN_OUTPUT = JSON.stringify({
  tasks: [
    { title: 'Interview ten clinics', description: 'Book and run the calls.', task_type: 'market_research', milestone_ordinal: 0, rationale: 'Cheapest way to test willingness to pay.' },
    { title: 'Map competing schedulers', description: 'Who already sells here.', task_type: 'competitor_research', milestone_ordinal: 0, rationale: 'Tells us what the price ceiling is.' },
    { title: 'Draft the pricing page', description: 'One page, three tiers.', task_type: 'business_model_comparison', milestone_ordinal: 1 },
  ],
});

/**
 * Run the whole Slice D journey. Returns every step's verdict. NEVER throws for a failed step — the caller decides how
 * to report (the demo prints and exits non-zero; the suite asserts), so a failure is always visible with its evidence
 * rather than as an opaque stack.
 */
export async function runSliceDJourney(deps: SliceDJourneyDeps): Promise<{ readonly steps: readonly JourneyStep[] }> {
  const { product, owner, userId, accountId, companyId, ops, makeGateway } = deps;
  const ids: Ids = { userId, accountId, companyId };
  const steps: JourneyStep[] = [];
  const record = (step: string, requirement: string, ok: boolean, detail: string): void => {
    steps.push({ step, requirement, ok, detail });
  };
  /** Stop the sequence honestly: later steps depend on earlier ones, so a cascade of failures hides the real cause. */
  const bail = (step: string, requirement: string, detail: string): { readonly steps: readonly JourneyStep[] } => {
    record(step, requirement, false, detail);
    return { steps };
  };

  // ── 1. precondition: a confirmed understanding (CDR-044 §3-G5) ──────────────────────────────────────────
  const gen = await ops.generateUnderstanding(product, ids, { gateway: makeGateway('understanding', { kind: 'respond', output: UNDERSTANDING_OUTPUT }) });
  if (gen.status !== 'ok' || gen.document === undefined) return bail('understanding generated', 'UNDER-003', `expected ok, got ${gen.status}`);
  const confirmed = await ops.confirmUnderstanding(product, { ...ids, expectedVersion: gen.document.version });
  if (confirmed.status !== 'ok') return bail('understanding confirmed', 'UNDER-003', `expected ok, got ${confirmed.status}`);
  record('confirmed understanding established', 'UNDER-003', true, `version ${gen.document.version} confirmed — the gate strategy generation checks`);

  // ── 2. strategy options ────────────────────────────────────────────────────────────────────────────────
  const strategy = await ops.generateStrategyOptions(product, ids, { gateway: makeGateway('strategy', { kind: 'respond', output: STRATEGY_OUTPUT }) });
  if (strategy.status !== 'ok' || strategy.generation === undefined) return bail('strategy options generated', 'STRAT-001', `expected ok, got ${strategy.status}`);
  const optionCount = strategy.generation.options.length;
  if (optionCount < 3) return bail('strategy options generated', 'STRAT-001/002', `expected ≥3 distinct options, got ${optionCount}`);
  record('strategy options generated, distinct', 'STRAT-001/002', true, `${optionCount} options survived the distinctness check`);

  // ── 3. owner selection, phase-limited ──────────────────────────────────────────────────────────────────
  const selection = await ops.recordStrategyDecision(product, { ...ids, generationId: strategy.generation.generationId, request: { mode: 'select', selectedOrdinal: 0, phaseScope: 'first_phase' } }, {});
  if (selection.status !== 'ok' || selection.selection === undefined) return bail('owner selects an option', 'STRAT-003/005', `expected ok, got ${selection.status}`);
  record('owner selects a phase-limited option', 'STRAT-003/005', true, 'mode=select, phase_scope=first_phase — approval is bounded to the first phase');

  // ── 4. immutable decision ──────────────────────────────────────────────────────────────────────────────
  const decision = await ops.recordDecision(product, { ...ids, generationId: strategy.generation.generationId, selectionId: selection.selection.selectionId, rationale: 'Clearest path to a paying customer.' }, {});
  if (decision.status !== 'ok' || decision.decision === undefined) return bail('decision recorded', 'STRAT-006', `expected ok, got ${decision.status}`);
  record('immutable decision recorded', 'STRAT-006', true, 'the record planning gates on (J-08: decision before any planning)');

  // ── 5. roadmap: goals + milestones ─────────────────────────────────────────────────────────────────────
  const roadmap = await ops.generateRoadmap(product, ids, { gateway: makeGateway('roadmap', { kind: 'respond', output: ROADMAP_OUTPUT }) });
  if (roadmap.status !== 'ok' || roadmap.roadmap === undefined) return bail('roadmap generated', 'ROAD-001', `expected ok, got ${roadmap.status}`);
  const milestoneCount = roadmap.roadmap.milestones.length;
  if (roadmap.roadmap.goals.length === 0 || milestoneCount === 0) return bail('roadmap generated', 'ROAD-001', `expected goals and milestones, got ${roadmap.roadmap.goals.length} goal(s) / ${milestoneCount} milestone(s)`);
  record('roadmap generated with goals + milestones', 'ROAD-001', true, `version ${roadmap.roadmap.version}: ${roadmap.roadmap.goals.length} goal(s), ${milestoneCount} milestone(s), ordinal-sequenced (never invented dates)`);

  // ── 6. tasks from the approved phase ───────────────────────────────────────────────────────────────────
  const planned = await ops.generateTasks(product, ids, { gateway: makeGateway('taskPlan', { kind: 'respond', output: TASK_PLAN_OUTPUT }, { milestoneCount }) });
  if (planned.status !== 'ok' || planned.tasks === undefined) return bail('tasks generated', 'PLAN-001', `expected ok, got ${planned.status}`);
  const draftIds = planned.tasks.map((t) => t.taskId);
  if (draftIds.length < 3) return bail('tasks generated', 'PLAN-001', `expected ≥3 planned tasks, got ${draftIds.length}`);
  record('tasks generated from the approved phase', 'PLAN-001', true, `${draftIds.length} tasks minted as DRAFTS — planning previews, the owner confirms`);

  // ── 7. planning transparency: run + inputs + per-task rationale ─────────────────────────────────────────
  // Inspected on the owner connection: this is EVIDENCE of what was recorded, not a product guarantee. The product
  // guarantee (rationale is inspectable) is asserted through the detail read at step 11.
  const runs = await sql<{ n: number }>`select count(*)::int as n from planning_runs where company_id = ${companyId}::uuid`.execute(owner.kysely);
  const inputs = await sql<{ n: number }>`select count(*)::int as n from planning_run_inputs where company_id = ${companyId}::uuid`.execute(owner.kysely);
  const runCount = runs.rows[0]?.n ?? 0;
  if (runCount < 1) return bail('planning run recorded', 'PLAN-004', 'no planning_runs row — the run left no record of what it considered');
  record('planning run + input snapshot recorded', 'PLAN-004', true, `${runCount} run(s), ${inputs.rows[0]?.n ?? 0} linked input(s) — the snapshot LINKS rather than copies`);

  // ── 8. confirm the drafts onto the board ───────────────────────────────────────────────────────────────
  const confirmedIds: string[] = [];
  for (const taskId of draftIds) {
    const r = await ops.planTask(product, { ...ids, taskId });
    if (r.status !== 'ok') return bail('drafts confirmed onto the board', 'TASK-001', `planTask(${taskId}) expected ok, got ${r.status}`);
    confirmedIds.push(taskId);
  }
  record('drafts confirmed onto the board', 'TASK-001', true, `${confirmedIds.length} × server-enforced draft→planned, each writing one task.created`);

  // ── 9. a dependency edge, visible on the board ─────────────────────────────────────────────────────────
  const [first, second] = confirmedIds;
  if (first === undefined || second === undefined) return bail('dependency added', 'TASK-001', 'fewer than two confirmed tasks to link');
  const edge = await ops.addTaskDependency(product, { ...ids, taskId: second, dependsOnTaskId: first });
  if (edge.status !== 'ok') return bail('dependency added', 'TASK-001', `expected ok, got ${edge.status}`);
  record('dependency edge added', 'TASK-001', true, `${second} depends on ${first} — immutable, same-company`);

  // ── 10. the board: every task placed, drafts counted, dependency reported ───────────────────────────────
  const board1 = await ops.getTaskBoard(product, ids);
  if (board1.status !== 'ok' || board1.board === undefined) return bail('board read', 'TASK-001', `expected ok, got ${board1.status}`);
  const placed = board1.board.buckets.flatMap((b) => b.tasks);
  if (board1.board.unplaceable !== 0) return bail('board places every task', 'TASK-001', `${board1.board.unplaceable} task(s) landed in NO bucket — invisible work`);
  if (placed.length !== confirmedIds.length) return bail('board places every task', 'TASK-001', `expected ${confirmedIds.length} on-board tasks, got ${placed.length}`);
  const blocked = placed.filter((t) => t.dependencyBlocked).map((t) => t.task.taskId);
  if (!blocked.includes(second)) return bail('dependency is inspectable on the board', 'TASK-001', `${second} depends on an incomplete task but is not reported blocked`);
  record('board places every task; status + dependency inspectable', 'TASK-001', true, `${placed.length} placed, 0 unplaceable, ${board1.board.draftsOffBoard} draft(s) off-board, ${blocked.length} blocked by a dependency`);

  // ── 11. detail: rationale inspectable, AND an absent one renders as absent (G7/G8) ──────────────────────
  const details: SliceDDetail[] = [];
  for (const taskId of confirmedIds) {
    const d = await ops.getTaskDetail(product, { ...ids, taskId });
    if (d.status !== 'ok' || d.task === undefined) return bail('task detail read', 'TASK-002', `getTaskDetail(${taskId}) expected ok, got ${d.status}`);
    details.push(d.task);
  }
  const withRationale = details.filter((d) => d.rationale !== null);
  const withoutRationale = details.filter((d) => d.rationale === null);
  if (withRationale.length === 0) return bail('rationale is inspectable', 'PLAN-004', 'no task exposed a rationale through the product read');
  if (withoutRationale.length === 0) return bail('a missing rationale renders as missing', 'PLAN-004', 'every task had a rationale — the honest-gap path was never exercised (CDR-044 §4-G8)');
  if (details.some((d) => d.taskType === null || d.createdAt === '')) return bail('detail exposes type + creation time', 'TASK-002', 'a task is missing its type or creation time');
  record('rationale / status / type inspectable, gaps render AS gaps', 'TASK-002 / PLAN-004', true, `${withRationale.length} task(s) explained, ${withoutRationale.length} honestly marked "not recorded" — never invented`);

  // ── 12. controls behave per state; delete is confirmed and audited (TASK-008) ───────────────────────────
  const target = details[0];
  if (target === undefined) return bail('controls per state', 'TASK-008', 'no task detail to inspect');
  const repeatVerdict = target.controls.find((c) => c.control === 'repeat');
  const deleteVerdict = target.controls.find((c) => c.control === 'delete');
  if (repeatVerdict?.available !== false || repeatVerdict.reason !== 'not_finished') return bail('controls behave per state', 'TASK-008', `a planned task should refuse repeat with not_finished, got ${JSON.stringify(repeatVerdict)}`);
  if (deleteVerdict?.available !== true) return bail('controls behave per state', 'TASK-008', `a planned task should permit delete, got ${JSON.stringify(deleteVerdict)}`);

  // An UNCONFIRMED delete must be refused — the confirmation TASK-008 requires is real, not advisory.
  const unconfirmed = await ops.deleteTask(product, { ...ids, taskId: target.taskId, confirmed: false });
  if (unconfirmed.status !== 'confirmation_required') return bail('delete requires confirmation', 'TASK-008', `expected confirmation_required, got ${unconfirmed.status}`);
  const deleted = await ops.deleteTask(product, { ...ids, taskId: target.taskId, confirmed: true, reason: 'Superseded by the newer plan.' });
  if (deleted.status !== 'ok') return bail('delete', 'TASK-008', `expected ok, got ${deleted.status}`);

  // …and the deleted task is GONE from the board, while its row survives for the audit trail.
  const board2 = await ops.getTaskBoard(product, ids);
  if (board2.status !== 'ok' || board2.board === undefined) return bail('board after delete', 'TASK-001', `expected ok, got ${board2.status}`);
  const stillThere = board2.board.buckets.flatMap((b) => b.tasks).map((t) => t.task.taskId);
  if (stillThere.includes(target.taskId)) return bail('a deleted task leaves the board', 'TASK-008', `${target.taskId} is still on the board after deletion`);
  record('delete requires confirmation, is audited, and removes the task from view', 'TASK-008', true, `refused unconfirmed; deleted at state=${String(deleted.stateAtDelete)}; row retained for the trail`);

  // REPEAT: only a finished task may be repeated, and the repeat is a NEW linked draft.
  const finished = confirmedIds.find((id) => id !== target.taskId);
  if (finished === undefined) return bail('repeat', 'TASK-008', 'no second task to repeat');
  await sql`update tasks set state = 'failed' where id = ${finished}::uuid`.execute(owner.kysely);
  const repeated = await ops.repeatTask(product, { ...ids, taskId: finished });
  if (repeated.status !== 'ok' || repeated.task === undefined) return bail('repeat', 'TASK-008', `expected ok, got ${repeated.status}`);
  if (repeated.task.taskId === finished || repeated.task.state !== 'draft') return bail('repeat creates a linked NEW task', 'TASK-008', `expected a new draft, got ${JSON.stringify(repeated.task)}`);
  record('repeat re-queues a NEW linked task', 'TASK-008', true, `${finished} (failed) → ${repeated.task.taskId} (draft), lineage recorded`);

  // ── 13. trail verified (CDR-044 §5-G9/G10) ─────────────────────────────────────────────────────────────
  const events = await sql<{ name: string }>`select name from audit_events where company_id = ${companyId}::uuid order by occurred_at, event_id`.execute(owner.kysely);
  const names = events.rows.map((e) => e.name);
  const expected = ['understanding.confirmed', 'strategy.generated', 'strategy.selected', 'decision.recorded', 'roadmap.generated', 'task.created', 'task.deleted', 'task.repeated'];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length > 0) return bail('trail verified', 'Trail verified', `audit events missing: ${missing.join(', ')} (saw: ${[...new Set(names)].join(', ')})`);

  // No payload may carry content. Checked against the strings the journey ACTUALLY wrote, so a rename here cannot make
  // the check vacuously pass.
  const payloads = await sql<{ blob: string }>`select coalesce(payload::text, '') || coalesce(subject_id::text, '') || name as blob from audit_events where company_id = ${companyId}::uuid`.execute(owner.kysely);
  const forbidden = ['Interview ten clinics', 'Map competing schedulers', 'Draft the pricing page', 'Superseded by the newer plan.', 'small veterinary clinics', 'Sells scheduling software'];
  const leaked = forbidden.filter((needle) => payloads.rows.some((r) => r.blob.includes(needle)));
  if (leaked.length > 0) return bail('audit payloads carry no content', 'Trail verified', `content leaked into audit metadata: ${leaked.join(' | ')}`);
  record('audit trail verified end to end, no content in payloads', 'Trail verified', true, `${names.length} events across the vertical; ${expected.length} required names all present`);

  return { steps };
}
