// ACBP-P7-009 / CDR-085 — the MVP loop journey, implemented ONCE and shared by the runnable demo
// (`pnpm demo:mvp-loop`) and the CI integration suite so the two can never drift. Test-support only; never a
// production dependency (boundary rule 9).
//
// WHAT THIS ADDS THAT SLICES A–F DO NOT.
// Every earlier journey establishes its own preconditions and then proves one vertical: Slice B runs an interview,
// Slice C starts from an understanding IT confirms, Slice D from a decision IT records, Slice E from a task IT
// creates with `createTask`. Each is sound, and each begins mid-river. What none of them shows is that the river
// is continuous — that the document a founder finally revises descends, hop by hop, from the answer they typed.
//
// So this journey creates NOTHING it can inherit. The understanding is generated after the interview wrote memory;
// the strategy is generated because that understanding was confirmed; the roadmap comes from that decision; the
// tasks come from that roadmap; and — the hop that matters most — THE TASK THAT RUNS IS ONE PLANNING PRODUCED,
// never a fresh `createTask`. The final step walks the chain back from the revised document to the account and
// refuses to pass unless every link resolves inside one tenant.
//
// It runs the REAL @acbp/core use cases through the restricted `acbp_app` connection under FORCE RLS; only the
// three edges outside the trust boundary are seamed (model provider, research fetcher, object storage). Like every
// earlier journey the use cases are INJECTED rather than imported: @acbp/core's own tests import
// @acbp/test-support, so test-support must not import @acbp/core (that would be a workspace-graph cycle).
//
// WHAT IT DOES NOT PROVE, stated because a green run reads like proof of more than it is:
//   1. It is HEADLESS. It drives use cases, not a browser, so it says nothing about whether a founder could
//      actually complete this loop in the UI. The staging-real half of ACBP-P7-009 needs P7-006 and is not here.
//   2. It does not re-prove the mechanisms. Distinctness, phase bounding, citation certification, settlement and
//      the negative sets are proven in Slices B–E; re-asserting them here would be duplication, not coverage.
//      What this file asserts is that they COMPOSE into one continuous line of descent.
//   3. Two hops run on the OWNER connection because NO use case implements them: `planned→queued` and
//      `queued→running` (CDR-065 §3-G5c). They are preconditions, not demonstrations, and are marked as such.
import type { DatabaseClient } from '@acbp/database';
// Real contract values wherever one exists — a hand-listed copy type-checks perfectly while being wrong about a
// field NAME, which is how two earlier slices lost CI runs against a real database.
import { CREDITS_PER_MANUAL_RUN, STRATEGY_OPTION_FIELDS } from '@acbp/contracts';
import type { ArtifactRevisionDTO, StrategyDecisionRequest } from '@acbp/contracts';
import { sql } from 'kysely';
import type { JourneyStep } from './slice-a-journey.js';

export type { JourneyStep } from './slice-a-journey.js';

/** The scripted fake-provider behavior the caller's gateway factory turns into a one-shot gateway. */
export type MvpLoopFakeBehavior = { readonly kind: 'respond'; readonly output: string } | { readonly kind: 'fail'; readonly error: string };
/** An opaque model gateway — the caller built it via `createModelGateway` with the matching validator. */
export type MvpLoopGateway = unknown;
/** Which output validator the caller should wire for a given stage. */
export type MvpLoopValidator = 'interview' | 'understanding' | 'strategy' | 'roadmap' | 'taskPlan' | 'research';

type Ids = { readonly userId: string; readonly accountId: string; readonly companyId: string };
type Status<T = object> = { readonly status: string } & Partial<T>;

/**
 * The artifact shape `runResearch` and `listRunArtifacts` return (core's `ArtifactDTO`).
 *
 * NOTE THE `id`. It is NOT `artifactId` — that is the LINEAGE read's field name (see {@link MvpLoopLineageArtifact}),
 * and the two really do differ. Writing `artifactId` here type-checks against nothing and yields `undefined` at
 * runtime, which is why both shapes are spelled out separately rather than shared.
 */
export interface MvpLoopArtifact {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
}

/** What `readArtifactLineage` returns for the artifact itself — a DIFFERENT shape, keyed `artifactId`. */
export interface MvpLoopLineageArtifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly title: string;
}

/** Mirrors `FetchedSource` from @acbp/contracts — restated so the caller can build sources without importing it. */
export interface MvpLoopSource {
  readonly url: string;
  readonly title: string;
  readonly retrievedAt: string;
  readonly content: string;
}

/**
 * The @acbp/core use cases the journey drives, injected by the caller (structural types — the caller passes the
 * real, more-precisely-typed functions). Every signature here is copied from the slice journey that already proves
 * it against a real database, so this interface introduces no new guesses about shapes.
 */
export interface MvpLoopOps {
  // ── discovery (Slice B) ────────────────────────────────────────────────────────────────────────────────
  startInterviewSession(c: DatabaseClient, p: Ids): Promise<Status<{ session: { sessionId: string; state: string } }>>;
  addInterviewQuestion(c: DatabaseClient, p: Ids & { sessionId: string; prompt: string }): Promise<Status<{ question: { questionId: string } }>>;
  evaluateAnswer(c: DatabaseClient, p: Ids & { sessionId: string; questionId: string; answerText: string }, o: { gateway: MvpLoopGateway }): Promise<Status<{ verdict: string }>>;
  listMemoryItems(c: DatabaseClient, p: Ids): Promise<Status<{ items: ReadonlyArray<{ type: string; sourceType: string; content: string }> }>>;
  // ── understanding (Slice B/C) ──────────────────────────────────────────────────────────────────────────
  generateUnderstanding(c: DatabaseClient, p: Ids, o: { gateway: MvpLoopGateway }): Promise<Status<{ document: { documentId: string; version: number } }>>;
  confirmUnderstanding(c: DatabaseClient, p: Ids & { expectedVersion: number }): Promise<Status>;
  isCurrentUnderstandingConfirmed(c: DatabaseClient, p: Ids): Promise<Status<{ confirmed: boolean; version: number | null }>>;
  // ── strategy (Slice C/D) ───────────────────────────────────────────────────────────────────────────────
  generateStrategyOptions(c: DatabaseClient, p: Ids, d: { gateway: MvpLoopGateway }): Promise<Status<{ generation: { generationId: string; options: ReadonlyArray<{ optionId: string; ordinal: number }> } }>>;
  recordStrategyDecision(c: DatabaseClient, p: Ids & { generationId: string; request: StrategyDecisionRequest }, d: object): Promise<Status<{ selection: { selectionId: string } }>>;
  recordDecision(c: DatabaseClient, p: Ids & { generationId: string; selectionId: string; rationale?: unknown }, d: object): Promise<Status<{ decision: { decisionId: string } }>>;
  // ── planning (Slice D) ─────────────────────────────────────────────────────────────────────────────────
  generateRoadmap(c: DatabaseClient, p: Ids, d: { gateway: MvpLoopGateway }): Promise<Status<{ roadmap: { roadmapId: string; version: number; goals: ReadonlyArray<unknown>; milestones: ReadonlyArray<{ milestoneId: string; ordinal: number }> } }>>;
  generateTasks(c: DatabaseClient, p: Ids, d: { gateway: MvpLoopGateway }): Promise<Status<{ tasks: ReadonlyArray<{ taskId: string }>; runId?: string }>>;
  planTask(c: DatabaseClient, p: Ids & { taskId: string }): Promise<Status<{ task: { state: string } }>>;
  // ── execution (Slice E) ────────────────────────────────────────────────────────────────────────────────
  preflightRun(c: DatabaseClient, p: Ids): Promise<Status<{ balance: number; cost: number; affordable: boolean }>>;
  startRun(c: DatabaseClient, p: Ids & { taskId: string; attempt: number }): Promise<Status<{ run: { id: string; state: string; attempt: number } }>>;
  reserveCredit(c: DatabaseClient, p: Ids & { taskRunId: string; idempotencyKey: string }): Promise<Status<{ balanceAfter: number }>>;
  runResearch(
    c: DatabaseClient,
    p: Ids & { runId: string; taskType: string; question: string; workerVersion: number; modelVersion: string },
    d: { gateway: MvpLoopGateway; fetcher: unknown; storage: unknown },
  ): Promise<Status<{ artifact: MvpLoopArtifact; sourcedClaims: number; unverifiedClaims: number; reason: string }>>;
  listRunArtifacts(c: DatabaseClient, p: Ids & { runId: string }): Promise<readonly MvpLoopArtifact[] | 'forbidden'>;
  succeedRun(c: DatabaseClient, p: Ids & { runId: string }): Promise<Status<{ run: { state: string } }>>;
  completeTask(c: DatabaseClient, p: Ids & { taskId: string; runId: string; evidence: unknown }): Promise<Status<{ artifactCount: number; reason: string }>>;
  settleRun(c: DatabaseClient, p: Ids & { taskRunId: string }): Promise<Status<{ settlement: string; balanceAfter: number }>>;
  // ── revision (Slice E) ─────────────────────────────────────────────────────────────────────────────────
  requestRevision(c: DatabaseClient, p: Ids & { artifactId: string; guidance: string; idempotencyKey: string }): Promise<Status<{ revision: ArtifactRevisionDTO; newTaskId: string; deduplicated: boolean }>>;
  readArtifactLineage(c: DatabaseClient, p: Ids & { artifactId: string }): Promise<Status<{ artifact: MvpLoopLineageArtifact; revisedFrom: ArtifactRevisionDTO | null; revisions: readonly ArtifactRevisionDTO[] }>>;
}

export interface MvpLoopJourneyDeps {
  /** Restricted `acbp_app` product connection — every use case runs through this. */
  readonly product: DatabaseClient;
  /** Owner/fixture connection — evidence inspection and the two preconditions the product role cannot reach. */
  readonly owner: DatabaseClient;
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** A company in a DIFFERENT account, used to prove the continuity walk is falsifiable rather than vacuous. */
  readonly foreignAccountId: string;
  readonly ops: MvpLoopOps;
  /**
   * Build a one-shot gateway wired to the deterministic fake provider + the given validator.
   *
   * `milestoneCount` is required by the `taskPlan` validator only — it is a factory over the roadmap's milestone
   * count, because a planned task naming a milestone ordinal that does not exist is the STRAT-005 phase-boundary
   * violation. The journey supplies the count it actually generated, so the validator sees real data.
   */
  readonly makeGateway: (validator: MvpLoopValidator, behavior: MvpLoopFakeBehavior, opts?: { readonly milestoneCount?: number }) => MvpLoopGateway;
  /** Build a fresh in-memory fetcher already seeded with the journey's sources for `question`. */
  readonly makeFetcher: (question: string, sources: readonly MvpLoopSource[]) => unknown;
  /** Build a fresh in-memory object storage. */
  readonly makeStorage: () => unknown;
}

// ── the scripted inputs ──────────────────────────────────────────────────────────────────────────────────
// Deterministic and inline. This journey is a claim about the PLATFORM, so its inputs are fixed: a randomised
// payload would make a failure unreproducible, which is the opposite of what an MVP-loop proof is for.

/**
 * The founder's own words, and the marker traced through the rest of the loop.
 *
 * The marker is what makes the first hop falsifiable. Asserting merely that "a user_fact appeared" would pass
 * against a memory item the platform invented; asserting that the item CARRIES this phrase is what proves the
 * typed answer is the thing that flowed into memory.
 */
const ANSWER_TEXT = 'Small veterinary clinics in Leeds, mostly two- or three-vet practices.';
const ANSWER_MARKER = 'veterinary clinics in Leeds';

const UNDERSTANDING_OUTPUT = JSON.stringify({
  items: [
    { class: 'fact', content: 'Sells to small veterinary clinics in Leeds.', confidence: 0.9 },
    { class: 'assumption', content: 'Clinics will pay monthly rather than annually.', confidence: 0.4 },
    { class: 'open_question', content: 'Pricing model is not settled.', confidence: 0.2 },
  ],
});

/** A complete option over the CONTRACT's field list. Distinct on the three axes the generator dedupes on. */
function option(customer: string, offer: string, model: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f} for ${customer}`;
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
  goals: [{ title: 'Reach the first paying clinic', description: 'Validate willingness to pay.' }],
  milestones: [
    { title: 'Ship the booking page', description: 'The first thing a clinic sees.', goal_ordinal: 0 },
    { title: 'Run ten discovery calls', description: null, goal_ordinal: 0 },
  ],
});

/**
 * The planned tasks. THREE, because PLAN-001 mints three or more or refuses (a two-task plan returns
 * `generation_failed`, which is how this fixture was first wrong).
 *
 * The FIRST is `market_research` deliberately: it is the one this journey will execute, and the research worker is
 * the only worker that exists, so the loop's executable hop has to be a research task.
 */
const TASK_TYPE = 'market_research';
const TASK_PLAN_OUTPUT = JSON.stringify({
  tasks: [
    { title: 'Size the Leeds veterinary clinic market', description: 'How many clinics, and how many are independent.', task_type: TASK_TYPE, milestone_ordinal: 0, rationale: 'Cheapest way to test whether the segment is big enough.' },
    { title: 'Map competing schedulers', description: 'Who already sells here.', task_type: 'competitor_research', milestone_ordinal: 0, rationale: 'Tells us what the price ceiling is.' },
    { title: 'Draft the pricing page', description: 'One page, three tiers.', task_type: 'business_model_comparison', milestone_ordinal: 1, rationale: 'Turns the pricing assumption into something a clinic can react to.' },
  ],
});

const QUESTION = 'How many independent veterinary clinics operate in Leeds?';
const RETRIEVED_AT = '2026-08-04T09:00:00.000Z';
const SOURCE_A: MvpLoopSource = { url: 'https://example.test/leeds-vet-register', title: 'Leeds veterinary register 2026', retrievedAt: RETRIEVED_AT, content: 'Ordinary prose listing registered veterinary practices by postcode.' };
const SOURCE_B: MvpLoopSource = { url: 'https://example.test/practice-ownership', title: 'Practice ownership survey', retrievedAt: RETRIEVED_AT, content: 'Breakdown of independent versus group-owned practices.' };
const SOURCES: readonly MvpLoopSource[] = [SOURCE_A, SOURCE_B];
const cite = (s: MvpLoopSource) => ({ url: s.url, title: s.title, retrievedAt: s.retrievedAt });

/** The THIRD claim is deliberately unverified: WORK-002's promise is a citation or an admission, never an invention. */
const RESEARCH_OUTPUT = JSON.stringify({
  title: 'Independent veterinary clinics in Leeds',
  summary: 'What the retrieved sources say about the size of the segment.',
  claims: [
    { statement: 'Registered practices are listed by postcode.', sources: [cite(SOURCE_A)] },
    { statement: 'Independent and group-owned practices are counted separately.', sources: [cite(SOURCE_B)] },
    { statement: 'The independent share is expected to fall next year.', unverifiedReason: 'No retrieved source states a forward projection.' },
  ],
});

/** Deliberately different text, so "both versions retained" is checked by VALUE rather than by row count. */
const REVISED_OUTPUT = JSON.stringify({
  title: 'Independent veterinary clinics in Leeds (revised)',
  summary: 'Revised: two- and three-vet practices separated out.',
  claims: [
    { statement: 'Practice size is recorded alongside ownership.', sources: [cite(SOURCE_B)] },
    { statement: 'A forward projection is still unsupported by the retrieved sources.', unverifiedReason: 'No retrieved source states a forward projection.' },
  ],
});

/**
 * Run the whole MVP loop. Returns every step's verdict. NEVER throws for a failed step — the caller decides how to
 * report (the demo prints and exits non-zero; the suite asserts), so a failure is always visible with its evidence
 * rather than as an opaque stack.
 */
export async function runMvpLoopJourney(deps: MvpLoopJourneyDeps): Promise<{ readonly steps: readonly JourneyStep[] }> {
  const { product, owner, userId, accountId, companyId, foreignAccountId, ops, makeGateway, makeFetcher, makeStorage } = deps;
  const ids: Ids = { userId, accountId, companyId };
  const steps: JourneyStep[] = [];
  const record = (step: string, requirement: string, ok: boolean, detail: string): void => {
    steps.push({ step, requirement, ok, detail });
  };
  /** Stop the sequence honestly: every step here depends on the one before, so a cascade would hide the cause. */
  const bail = (step: string, requirement: string, detail: string): { readonly steps: readonly JourneyStep[] } => {
    record(step, requirement, false, detail);
    return { steps };
  };

  /** ONE object store for the whole loop — two documents in two throwaway stores never coexisted (CDR-065 §3). */
  const storage = makeStorage();
  const researchDeps = (behavior: MvpLoopFakeBehavior) => ({ gateway: makeGateway('research', behavior), fetcher: makeFetcher(QUESTION, SOURCES), storage });
  const researchParams = (runId: string) => ({ ...ids, runId, taskType: TASK_TYPE, question: QUESTION, workerVersion: 1, modelVersion: 'fake@1' });

  /**
   * Take an EXISTING task to `queued`, the only startable state.
   *
   * `planTask` is the real product path as far as `planned`. The last hop runs on the OWNER connection because
   * `planned→queued` is legal in the contract and implemented by NO use case (CDR-065 §3-G5c). A precondition,
   * not a demonstration — and the reason it is written once here rather than retyped at each call site.
   */
  const queueExistingTask = async (taskId: string): Promise<boolean> => {
    const planned = await ops.planTask(product, { ...ids, taskId });
    if (planned.status !== 'ok') return false;
    await sql`update tasks set state = 'queued', task_type = ${TASK_TYPE} where id = ${taskId}::uuid`.execute(owner.kysely);
    return true;
  };

  /** Start a queued task, advance the TASK's own state (again owner-side, CDR-065 §3-G5c) and reserve its credit. */
  const startAndReserve = async (taskId: string, key: string): Promise<{ runId: string } | { failure: string }> => {
    const s = await ops.startRun(product, { ...ids, taskId, attempt: 1 });
    if (s.status !== 'ok' || s.run === undefined) return { failure: `startRun expected ok, got ${s.status}` };
    await sql`update tasks set state = 'running' where id = ${taskId}::uuid`.execute(owner.kysely);
    const r = await ops.reserveCredit(product, { ...ids, taskRunId: s.run.id, idempotencyKey: key });
    if (r.status !== 'ok') return { failure: `reserveCredit expected ok, got ${r.status}` };
    return { runId: s.run.id };
  };

  // The account needs a balance and the PRODUCT ROLE HAS NO GRANT PATH, deliberately (CDR-058 §4). Minting on the
  // owner connection is a precondition. Two runs' worth: the original and the revision.
  await sql`insert into credit_transactions (account_id, kind, credits) values (${accountId}::uuid, 'grant', ${CREDITS_PER_MANUAL_RUN * 2})`.execute(owner.kysely);

  // ── 1. the founder's own words enter memory ────────────────────────────────────────────────────────────
  const session = await ops.startInterviewSession(product, ids);
  if (session.status !== 'ok' || session.session === undefined) return bail('the interview starts', 'DISC-001', `startInterviewSession expected ok, got ${session.status}`);
  const sessionId = session.session.sessionId;
  const question = await ops.addInterviewQuestion(product, { ...ids, sessionId, prompt: 'Who is your target customer?' });
  if (question.status !== 'ok' || question.question === undefined) return bail('the interview starts', 'DISC-001', `addInterviewQuestion expected ok, got ${question.status}`);
  const answered = await ops.evaluateAnswer(
    product,
    { ...ids, sessionId, questionId: question.question.questionId, answerText: ANSWER_TEXT },
    { gateway: makeGateway('interview', { kind: 'respond', output: '{"verdict":"clear"}' }) },
  );
  if (answered.status !== 'ok') return bail("the founder's answer becomes memory", 'MEM-001', `evaluateAnswer expected ok, got ${answered.status}`);
  const memory = await ops.listMemoryItems(product, ids);
  const carried = (memory.items ?? []).find((i) => i.type === 'user_fact' && i.sourceType === 'interview_answer' && i.content.includes(ANSWER_MARKER));
  if (carried === undefined) return bail("the founder's answer becomes memory", 'MEM-001', `no user_fact memory item carries the answer text — ${String((memory.items ?? []).length)} item(s) present, none matching "${ANSWER_MARKER}"`);
  record("the founder's own answer becomes a memory item, verbatim", 'DISC-001 / MEM-001', true, `session ${sessionId}: a user_fact from interview_answer carries "${ANSWER_MARKER}" — the loop's first link, traced by content rather than by count`);

  // ── 2. understanding is generated FROM that memory, and confirmed ──────────────────────────────────────
  const understanding = await ops.generateUnderstanding(product, ids, { gateway: makeGateway('understanding', { kind: 'respond', output: UNDERSTANDING_OUTPUT }) });
  if (understanding.status !== 'ok' || understanding.document === undefined) return bail('understanding is generated and confirmed', 'UNDER-001', `generateUnderstanding expected ok, got ${understanding.status}`);
  const version = understanding.document.version;
  const gateBefore = await ops.isCurrentUnderstandingConfirmed(product, ids);
  const confirmed = await ops.confirmUnderstanding(product, { ...ids, expectedVersion: version });
  if (confirmed.status !== 'ok') return bail('understanding is generated and confirmed', 'UNDER-003', `confirmUnderstanding expected ok, got ${confirmed.status}`);
  const gateAfter = await ops.isCurrentUnderstandingConfirmed(product, ids);
  if (gateBefore.confirmed !== false || gateAfter.confirmed !== true) {
    return bail('understanding is generated and confirmed', 'UNDER-003', `the strategy gate did not move: before=${String(gateBefore.confirmed)}, after=${String(gateAfter.confirmed)} (expected false → true)`);
  }
  record('understanding is generated from that memory and confirmed, opening the gate', 'UNDER-001 / UNDER-003', true, `document v${String(version)} confirmed; the strategy gate moved false → true, so the next step is unlocked BY this one rather than despite it`);

  // ── 3. strategy options, then the owner's immutable decision ───────────────────────────────────────────
  const strategy = await ops.generateStrategyOptions(product, ids, { gateway: makeGateway('strategy', { kind: 'respond', output: STRATEGY_OUTPUT }) });
  if (strategy.status !== 'ok' || strategy.generation === undefined) return bail('strategy options are generated', 'STRAT-001', `generateStrategyOptions expected ok, got ${strategy.status}`);
  const generationId = strategy.generation.generationId;
  record('strategy options are generated behind the confirmed-understanding gate', 'STRAT-001', true, `generation ${generationId} produced ${String(strategy.generation.options.length)} option(s) — reachable only because step 2 confirmed`);

  const request: StrategyDecisionRequest = { mode: 'select', selectedOrdinal: 0, phaseScope: 'first_phase' };
  const selection = await ops.recordStrategyDecision(product, { ...ids, generationId, request }, {});
  if (selection.status !== 'ok' || selection.selection === undefined) return bail('the owner selects and the decision is recorded', 'STRAT-003', `recordStrategyDecision expected ok, got ${selection.status}`);
  const decision = await ops.recordDecision(product, { ...ids, generationId, selectionId: selection.selection.selectionId, rationale: 'Closest to the segment the founder described.' }, {});
  if (decision.status !== 'ok' || decision.decision === undefined) return bail('the owner selects and the decision is recorded', 'STRAT-006', `recordDecision expected ok, got ${decision.status}`);
  record('the owner selects an option and an immutable decision is recorded', 'STRAT-003 / STRAT-005 / STRAT-006', true, `decision ${decision.decision.decisionId}, phase-limited to the first phase — the record planning gates on`);

  // ── 4. the roadmap, then the tasks, both descending from that decision ─────────────────────────────────
  const roadmap = await ops.generateRoadmap(product, ids, { gateway: makeGateway('roadmap', { kind: 'respond', output: ROADMAP_OUTPUT }) });
  if (roadmap.status !== 'ok' || roadmap.roadmap === undefined) return bail('a roadmap is generated from the decision', 'ROAD-001', `generateRoadmap expected ok, got ${roadmap.status}`);
  const milestoneCount = roadmap.roadmap.milestones.length;
  record('a roadmap is generated from the decision', 'ROAD-001', true, `roadmap v${String(roadmap.roadmap.version)}: ${String(roadmap.roadmap.goals.length)} goal(s), ${String(milestoneCount)} milestone(s)`);

  const planned = await ops.generateTasks(product, ids, { gateway: makeGateway('taskPlan', { kind: 'respond', output: TASK_PLAN_OUTPUT }, { milestoneCount }) });
  if (planned.status !== 'ok' || planned.tasks === undefined || planned.tasks.length === 0) return bail('tasks are planned from the approved phase', 'PLAN-001', `generateTasks expected ok with tasks, got ${planned.status}`);
  const plannedTaskId = planned.tasks[0]?.taskId;
  if (plannedTaskId === undefined) return bail('tasks are planned from the approved phase', 'PLAN-001', 'generateTasks returned an empty first task');
  record('tasks are planned from the approved phase', 'PLAN-001', true, `${String(planned.tasks.length)} task(s) minted as drafts; the first, ${plannedTaskId}, is the one this loop will execute`);

  // ── 5. THE HOP NO SLICE PROVES: the task that runs is the task planning produced ───────────────────────
  const queued = await queueExistingTask(plannedTaskId);
  if (!queued) return bail('the PLANNED task is the one that runs', 'PLAN-001 / TASK-001', `planTask did not reach planned for ${plannedTaskId}`);
  const preflight = await ops.preflightRun(product, ids);
  if (preflight.status !== 'ok' || preflight.affordable !== true) return bail('the PLANNED task is the one that runs', 'TASK-004', `preflight expected an affordable ok, got ${preflight.status} affordable=${String(preflight.affordable)}`);
  const startedOriginal = await startAndReserve(plannedTaskId, `mvp-loop-original-${plannedTaskId}`);
  if ('failure' in startedOriginal) return bail('the PLANNED task is the one that runs', 'TASK-004 / BILL-002', startedOriginal.failure);
  const runId = startedOriginal.runId;
  // The falsifiable half: the run must belong to the PLANNED task, not to some task the journey minted.
  const runOwner = await sql<{ task_id: string }>`select task_id::text as task_id from task_runs where id = ${runId}::uuid`.execute(owner.kysely);
  if (runOwner.rows[0]?.task_id !== plannedTaskId) return bail('the PLANNED task is the one that runs', 'PLAN-001 / TASK-004', `run ${runId} belongs to task ${String(runOwner.rows[0]?.task_id)}, not to the planned task ${plannedTaskId}`);
  record('the task that RUNS is the task planning produced — never a fresh createTask', 'PLAN-001 / TASK-004 / BILL-002', true, `run ${runId} → task ${plannedTaskId}, credit reserved before the worker was invoked. THIS is the hop Slices D and E cannot show: D stops at the board, E starts from a task it creates itself`);

  // ── 6. the run produces a cited document, the task completes against it, the credit settles ────────────
  const research = await ops.runResearch(product, researchParams(runId), researchDeps({ kind: 'respond', output: RESEARCH_OUTPUT }));
  if (research.status !== 'ok' || research.artifact === undefined) return bail('the run produces a cited document', 'WORK-002', `runResearch expected ok, got ${research.status}${research.reason === undefined ? '' : ` (${research.reason})`}`);
  if ((research.sourcedClaims ?? 0) < 1 || (research.unverifiedClaims ?? 0) < 1) return bail('the run produces a cited document', 'WORK-002', `expected both a cited and an admitted claim, got ${String(research.sourcedClaims)} cited / ${String(research.unverifiedClaims)} unverified`);
  const artifacts = await ops.listRunArtifacts(product, { ...ids, runId });
  if (artifacts === 'forbidden' || artifacts.length !== 1) return bail('the run produces a cited document', 'TASK-005', `expected exactly 1 artifact for run ${runId}, got ${artifacts === 'forbidden' ? 'forbidden' : String(artifacts.length)}`);
  const original = artifacts[0];
  if (original === undefined || original.runId !== runId) return bail('the run produces a cited document', 'TASK-005', 'the artifact does not point back at the run that made it');
  record('the run produces a document where every claim is cited or admitted', 'WORK-002 / TASK-005', true, `artifact ${original.id} → run ${runId}: ${String(research.sourcedClaims)} cited, ${String(research.unverifiedClaims)} honestly marked unverified`);

  const succeeded = await ops.succeedRun(product, { ...ids, runId });
  if (succeeded.status !== 'ok') return bail('the task completes and the credit settles', 'TASK-006', `succeedRun expected ok, got ${succeeded.status}`);
  const completed = await ops.completeTask(product, { ...ids, taskId: plannedTaskId, runId, evidence: { kind: 'artifacts', artifactIds: [original.id] } });
  if (completed.status !== 'ok' || completed.artifactCount !== 1) return bail('the task completes and the credit settles', 'TASK-005', `completeTask expected ok with 1 artifact, got ${completed.status}${completed.reason === undefined ? '' : ` (${String(completed.reason)})`}`);
  const settled = await ops.settleRun(product, { ...ids, taskRunId: runId });
  if (settled.status !== 'ok') return bail('the task completes and the credit settles', 'BILL-002', `settleRun expected ok, got ${settled.status}`);
  record('the planned task completes citing that document, and the credit settles', 'TASK-005 / BILL-002', true, `1 artifact cited; settlement=${String(settled.settlement)}, balance now ${String(settled.balanceAfter)}`);

  // ── 7. the founder asks for a revision, and it re-executes ─────────────────────────────────────────────
  const revision = await ops.requestRevision(product, { ...ids, artifactId: original.id, guidance: 'Separate two- and three-vet practices.', idempotencyKey: `mvp-loop-revision-${original.id}` });
  if (revision.status !== 'ok' || revision.newTaskId === undefined) return bail('a revision is requested and re-executes', 'TASK-005 / J-13', `requestRevision expected ok, got ${revision.status}`);
  const revisionTaskId = revision.newTaskId;
  if (!(await queueExistingTask(revisionTaskId))) return bail('a revision is requested and re-executes', 'J-13', `planTask did not reach planned for the revision task ${revisionTaskId}`);
  const startedRevision = await startAndReserve(revisionTaskId, `mvp-loop-revision-run-${revisionTaskId}`);
  if ('failure' in startedRevision) return bail('a revision is requested and re-executes', 'J-13', startedRevision.failure);
  const revisionRunId = startedRevision.runId;
  const revised = await ops.runResearch(product, researchParams(revisionRunId), researchDeps({ kind: 'respond', output: REVISED_OUTPUT }));
  if (revised.status !== 'ok' || revised.artifact === undefined) return bail('a revision is requested and re-executes', 'J-13', `the revision run expected ok, got ${revised.status}${revised.reason === undefined ? '' : ` (${revised.reason})`}`);
  const revisedArtifact = revised.artifact;
  // Both versions must survive BY VALUE — a row count would pass against a revision that overwrote the original.
  const originalStillReads = await ops.readArtifactLineage(product, { ...ids, artifactId: original.id });
  if (originalStillReads.status !== 'ok' || originalStillReads.artifact === undefined) return bail('a revision is requested and re-executes', 'J-13', `the original artifact no longer reads back after the revision (${originalStillReads.status})`);
  if (originalStillReads.artifact.title === revisedArtifact.title) return bail('a revision is requested and re-executes', 'J-13', 'the original and the revision carry the same title — the revision overwrote rather than descended');
  if ((originalStillReads.revisions ?? []).length !== 1) return bail('a revision is requested and re-executes', 'J-13', `expected exactly 1 revision recorded against the original, got ${String((originalStillReads.revisions ?? []).length)}`);
  record('the founder asks for a revision and it re-executes, both versions retained', 'TASK-005 / J-13', true, `original "${originalStillReads.artifact.title}" and revised "${revisedArtifact.title}" both read back; 1 revision links them through task ${revisionTaskId}`);

  // ── 8. THE CONTINUITY WALK ─────────────────────────────────────────────────────────────────────────────
  // The whole point of the file. Every step above could pass while the stages sat in unrelated silos; this walks
  // the chain backwards from the revised document to the account and refuses unless every link resolves.
  const chain = await sql<{ artifact_id: string; run_id: string; task_id: string; company_id: string; account_id: string; member_user_id: string | null }>`
    select a.id::text        as artifact_id,
           r.id::text        as run_id,
           t.id::text        as task_id,
           c.id::text        as company_id,
           acc_c.account_id::text as account_id,
           m.member_user_id::text as member_user_id
      from artifacts a
      join task_runs r  on r.id = a.run_id
      join tasks t      on t.id = r.task_id
      join companies c  on c.id = t.company_id
      join companies acc_c on acc_c.id = c.id
      join memberships m on m.account_id = c.account_id and m.role = 'owner' and m.status = 'active'
     where a.id = ${revisedArtifact.id}::uuid
  `.execute(owner.kysely);
  const link = chain.rows[0];
  if (link === undefined) return bail('the revised document descends from the account, unbroken', 'ACC-002 / NFR-001', `the chain artifact → run → task → company → account → owner membership did not resolve for artifact ${revisedArtifact.id}`);
  if (link.run_id !== revisionRunId || link.task_id !== revisionTaskId || link.company_id !== companyId || link.account_id !== accountId || link.member_user_id !== userId) {
    return bail(
      'the revised document descends from the account, unbroken',
      'ACC-002 / NFR-001',
      `the chain resolved to the wrong rows: run=${link.run_id} (expected ${revisionRunId}), task=${link.task_id} (expected ${revisionTaskId}), company=${link.company_id}, account=${link.account_id}, owner=${String(link.member_user_id)}`,
    );
  }

  // Every stage of the loop must have left its own row under THIS company — otherwise the chain above proves only
  // that the tail is connected, while the head (interview → understanding → strategy) could have been skipped.
  const stageCounts = await sql<{ stage: string; n: number }>`
        select 'interview'     as stage, count(*)::int as n from interview_sessions      where company_id = ${companyId}::uuid
  union select 'memory'        as stage, count(*)::int as n from memory_items            where company_id = ${companyId}::uuid
  union select 'understanding' as stage, count(*)::int as n from understanding_documents where company_id = ${companyId}::uuid
  union select 'strategy'      as stage, count(*)::int as n from strategy_generations    where company_id = ${companyId}::uuid
  union select 'decision'      as stage, count(*)::int as n from decisions               where company_id = ${companyId}::uuid
  union select 'roadmap'       as stage, count(*)::int as n from roadmaps                where company_id = ${companyId}::uuid
  union select 'revision'      as stage, count(*)::int as n from artifact_revisions      where company_id = ${companyId}::uuid
  `.execute(owner.kysely);
  const missing = stageCounts.rows.filter((s) => s.n < 1).map((s) => s.stage);
  if (stageCounts.rows.length !== 7 || missing.length > 0) return bail('the revised document descends from the account, unbroken', 'ACC-002', `stages with no row under this company: ${missing.join(', ') || 'none'} (${String(stageCounts.rows.length)}/7 stages queried)`);

  // FALSIFIABILITY. The two checks above are satisfiable by a platform that files everything under one tenant and
  // leaks across accounts; this is the half that would fail if it did. The other account must hold NOTHING from
  // this loop — checked on the tables the loop actually wrote, not on a token sample.
  const leaked = await sql<{ n: number }>`
    select (
        (select count(*) from artifacts           where account_id = ${foreignAccountId}::uuid)
      + (select count(*) from task_runs           where account_id = ${foreignAccountId}::uuid)
      + (select count(*) from artifact_revisions  where account_id = ${foreignAccountId}::uuid)
      + (select count(*) from credit_transactions where account_id = ${foreignAccountId}::uuid)
    )::int as n
  `.execute(owner.kysely);
  const leakedRows = leaked.rows[0]?.n ?? -1;
  if (leakedRows !== 0) return bail('the revised document descends from the account, unbroken', 'NFR-001', `${String(leakedRows)} row(s) from this loop landed in the unrelated account ${foreignAccountId} (must be 0)`);

  record(
    'THE LOOP CLOSES: the revised document descends from the founder’s account, unbroken',
    'ACC-002 / PLAN-001 / TASK-005 / NFR-001',
    true,
    `artifact ${revisedArtifact.id} → run ${revisionRunId} → task ${revisionTaskId} → company ${companyId} → account ${accountId} → owner ${userId}; all 7 upstream stages left a row under this company; 0 rows reached the unrelated account`,
  );

  return { steps };
}
