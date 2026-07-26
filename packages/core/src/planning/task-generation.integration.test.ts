// ACBP-P4-003 / CDR-040 — real-PostgreSQL proof of generateTasks (PLAN-001) and steerTaskPlanning (PLAN-002) through
// the RESTRICTED role, driven by the P2-003 gateway with the deterministic FAKE provider. Proves: the planning gate
// (no decision / rejected decision / no roadmap all block); a valid plan persists 3+ typed, ranked, milestone-traced
// tasks as DRAFTS with NO audit event (the draft IS the preview — CDR-033 §4); the STRAT-005 phase boundary restricts
// planning to the approved phase and is re-checked server-side; "no phantom tasks" (gateway failure, malformed output
// and a sub-3 plan without an honest partial each persist NOTHING); stale_decision / stale_roadmap; owner+viewer may
// plan, a non-member is forbidden; and steering's THREE distinct successful answers (tasks / clarification / refusal),
// none of which is reported as a failure. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, taskPlanOutputValidator, type ResolvedProvider } from '../index.js';
import { generateTasks, steerTaskPlanning } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

function resolved(behavior: FakeProviderBehavior): ResolvedProvider {
  return { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
}
const planned = (over: Record<string, unknown> = {}) => ({ title: 'Interview ten clinics', description: 'Book and run the calls.', task_type: 'market_research', milestone_ordinal: 0, ...over });
const planOutput = (over: Record<string, unknown> = {}) => JSON.stringify({ tasks: [planned(), planned({ title: 'Map competitors', task_type: 'competitor_research' }), planned({ title: 'Draft pricing', task_type: 'business_model_comparison' })], ...over });
const steerOutput = (over: Record<string, unknown> = {}) => JSON.stringify({ outcome: 'tasks', intent: 'Find early customers', tasks: [planned()], ...over });

describe.skipIf(!hasTestDatabase)('task generation + steering (real PostgreSQL, restricted role) — ACBP-P4-003/CDR-040', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let selectionA = '';
  let roadmapA = '';

  /** Seed the full strategy→decision→roadmap chain. `phaseScope` drives the STRAT-005 boundary. */
  async function seedChain(phaseScope: string | null, opts: { goals?: number; milestonesPerGoal?: number } = {}): Promise<void> {
    const k = owner.kysely;
    const a = w.accountA;
    const c = w.companyA1;
    const u = w.aOwner;
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${a}::uuid, ${c}::uuid, 1, 'complete', 0.6, ${u}::uuid) returning id`.execute(k)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${doc}::uuid, 1, 'complete', 3, ${u}::uuid) returning id`.execute(k)).rows[0]!.id;
    const opt = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, 0, ${JSON.stringify({ customer: 'small clinics', offer: 'scheduling' })}::jsonb) returning id`.execute(k)).rows[0]!.id;
    selectionA = (await sql<{ id: string }>`insert into strategy_selections (account_id, company_id, generation_id, mode, selected_option_id, phase_scope, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, 'select', ${opt}::uuid, ${phaseScope}, ${u}::uuid) returning id`.execute(k)).rows[0]!.id;
    const dec = (await sql<{ id: string }>`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, ${selectionA}::uuid, 'select', 1, ${u}::uuid) returning id`.execute(k)).rows[0]!.id;
    roadmapA = (await sql<{ id: string }>`insert into roadmaps (account_id, company_id, version, decision_id, status, origin, created_by_user_id) values (${a}::uuid, ${c}::uuid, 1, ${dec}::uuid, 'complete', 'generated', ${u}::uuid) returning id`.execute(k)).rows[0]!.id;
    let ordinal = 0;
    for (let g = 0; g < (opts.goals ?? 2); g += 1) {
      const goal = (await sql<{ id: string }>`insert into goals (account_id, company_id, roadmap_id, ordinal, title) values (${a}::uuid, ${c}::uuid, ${roadmapA}::uuid, ${g}, ${'goal-' + String(g)}) returning id`.execute(k)).rows[0]!.id;
      for (let m = 0; m < (opts.milestonesPerGoal ?? 2); m += 1) {
        await sql`insert into milestones (account_id, company_id, roadmap_id, goal_id, ordinal, title) values (${a}::uuid, ${c}::uuid, ${roadmapA}::uuid, ${goal}::uuid, ${ordinal}, ${'milestone-' + String(ordinal)})`.execute(k);
        ordinal += 1;
      }
    }
  }
  async function seedRejectDecision(): Promise<void> {
    await sql`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) select account_id, company_id, generation_id, selection_id, 'reject', understanding_version, created_by_user_id from decisions where company_id = ${w.companyA1}::uuid order by created_at desc limit 1`.execute(owner.kysely);
  }

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  /** `milestoneCount` must match the IN-SCOPE set the use case will show the model. */
  const gatewayWith = (behavior: FakeProviderBehavior, milestoneCount: number) => createModelGateway(product, { primary: resolved(behavior), estimateCost, validateOutput: taskPlanOutputValidator(milestoneCount), config: { maxRetries: 0, maxReask: 0 } });
  const okGateway = (over: Record<string, unknown> = {}, n = 4) => gatewayWith({ kind: 'respond', output: planOutput(over) }, n);
  const tasksFor = async () => (await sql<{ id: string; state: string; title: string; task_type: string | null; priority: number | null; milestone_id: string | null }>`select id, state, title, task_type, priority, milestone_id from tasks where company_id = ${w.companyA1}::uuid order by priority`.execute(owner.kysely)).rows;
  const taskAudits = async () => (await sql<{ n: number }>`select count(*)::int as n from audit_events where name = 'task.created'`.execute(owner.kysely)).rows[0]!.n;

  test('THE GATE: no decision, a REJECT decision, and no roadmap each block planning with nothing persisted', async () => {
    expect((await generateTasks(product, base(), { gateway: okGateway() })).status).toBe('no_decision');
    await seedChain(null);
    await seedRejectDecision();
    expect((await generateTasks(product, base(), { gateway: okGateway() })).status).toBe('decision_rejected');
    expect(await tasksFor()).toHaveLength(0);
  });

  test('no_roadmap: a decision without a roadmap has no milestones to trace tasks to (ROAD-001 / M4 exit)', async () => {
    const k = owner.kysely;
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 1, 'complete', 0.6, ${w.aOwner}::uuid) returning id`.execute(k)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${doc}::uuid, 1, 'complete', 3, ${w.aOwner}::uuid) returning id`.execute(k)).rows[0]!.id;
    const opt = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${gen}::uuid, 0, '{}'::jsonb) returning id`.execute(k)).rows[0]!.id;
    const sel = (await sql<{ id: string }>`insert into strategy_selections (account_id, company_id, generation_id, mode, selected_option_id, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${gen}::uuid, 'select', ${opt}::uuid, ${w.aOwner}::uuid) returning id`.execute(k)).rows[0]!.id;
    await sql`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${gen}::uuid, ${sel}::uuid, 'select', 1, ${w.aOwner}::uuid)`.execute(k);
    expect((await generateTasks(product, base(), { gateway: okGateway() })).status).toBe('no_roadmap');
  });

  test('PLAN-001: 3+ typed, ranked, milestone-traced tasks are minted as DRAFTS — and the draft writes NO audit', async () => {
    await seedChain('whole_plan');
    const r = await generateTasks(product, base(), { gateway: okGateway() });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.tasks).toHaveLength(3);
    expect(r.partial).toBe(false);
    const rows = await tasksFor();
    expect(rows).toHaveLength(3);
    // The preview state: not on the board, no audit (CDR-033 §4). `task.created` fires only when the owner confirms.
    expect(rows.every((t) => t.state === 'draft')).toBe(true);
    expect(await taskAudits()).toBe(0);
    // PLAN-001: each has a type and a description; each traces to a milestone; ranks are contiguous from 0.
    expect(rows.map((t) => t.task_type)).toEqual(['market_research', 'competitor_research', 'business_model_comparison']);
    expect(rows.map((t) => t.priority)).toEqual([0, 1, 2]);
    expect(rows.every((t) => t.milestone_id !== null)).toBe(true);
    // Metered by the gateway (the use case writes no usage code).
    expect((await sql<{ n: number }>`select count(*)::int as n from usage_events where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(1);
  });

  test('STRAT-005: a first_phase approval plans ONLY against the first goal’s milestones', async () => {
    // Two goals × two milestones. `first_phase` must expose only the first goal's two.
    await seedChain('first_phase', { goals: 2, milestonesPerGoal: 2 });
    const firstGoalMilestones = (await sql<{ id: string; ordinal: number }>`select m.id, m.ordinal from milestones m join goals g on g.id = m.goal_id where m.roadmap_id = ${roadmapA}::uuid and g.ordinal = 0 order by m.ordinal`.execute(owner.kysely)).rows;
    expect(firstGoalMilestones).toHaveLength(2);
    // The model is shown only 2 milestones, so ordinal 1 is the highest legal one.
    const r = await generateTasks(product, base(), { gateway: okGateway({ tasks: [planned({ milestone_ordinal: 0 }), planned({ milestone_ordinal: 1 }), planned({ milestone_ordinal: 0 })] }, 2) });
    expect(r.status).toBe('ok');
    const rows = await tasksFor();
    const allowed = new Set(firstGoalMilestones.map((m) => m.id));
    // Every task landed on an in-scope milestone — later phases are untouched (STRAT-005 "solely for that phase").
    expect(rows.every((t) => t.milestone_id !== null && allowed.has(t.milestone_id))).toBe(true);
  });

  test('STRAT-005: a task naming a milestone OUTSIDE the approved phase is blocked server-side, persisting nothing', async () => {
    await seedChain('first_phase', { goals: 2, milestonesPerGoal: 2 });
    // The in-scope set is 2, so ordinal 2 (a second-goal milestone in the full roadmap) must be refused at the seam.
    const r = await generateTasks(product, base(), { gateway: okGateway({ tasks: [planned({ milestone_ordinal: 0 }), planned({ milestone_ordinal: 1 }), planned({ milestone_ordinal: 2 })] }, 2) });
    expect(r.status).toBe('generation_failed');
    expect(await tasksFor()).toHaveLength(0);
  });

  test('NO PHANTOM TASKS: a gateway failure, a malformed output, and a sub-3 plan without an honest partial each persist NOTHING', async () => {
    await seedChain('whole_plan');
    expect((await generateTasks(product, base(), { gateway: gatewayWith({ kind: 'fail', error: 'provider_unavailable' }, 4) })).status).toBe('generation_failed');
    expect((await generateTasks(product, base(), { gateway: gatewayWith({ kind: 'respond', output: 'not json' }, 4) })).status).toBe('generation_failed');
    const twoTasks = JSON.stringify({ tasks: [planned(), planned()] });
    expect((await generateTasks(product, base(), { gateway: gatewayWith({ kind: 'respond', output: twoTasks }, 4) })).status).toBe('generation_failed');
    expect(await tasksFor()).toHaveLength(0);
    expect(await taskAudits()).toBe(0);
  });

  test('an HONEST partial persists fewer than three, labeled', async () => {
    await seedChain('whole_plan');
    const two = JSON.stringify({ tasks: [planned(), planned({ title: 'Second' })], partial: true });
    const r = await generateTasks(product, base(), { gateway: gatewayWith({ kind: 'respond', output: two }, 4) });
    expect(r.status === 'ok' && r.partial).toBe(true);
    expect(await tasksFor()).toHaveLength(2);
  });

  test('stale_decision and stale_roadmap: a change during the model call persists nothing', async () => {
    await seedChain('whole_plan');
    const stale = await generateTasks(product, base(), { gateway: okGateway() }, { beforePersist: async () => void (await seedRejectDecision()) });
    expect(stale.status).toBe('stale_decision');
    expect(await tasksFor()).toHaveLength(0);

    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
    await seedChain('whole_plan');
    const newVersion = async () => {
      const dec = (await sql<{ decision_id: string }>`select decision_id from roadmaps where id = ${roadmapA}::uuid`.execute(owner.kysely)).rows[0]!.decision_id;
      await sql`insert into roadmaps (account_id, company_id, version, decision_id, status, origin, supersedes_roadmap_id, edit_reason, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 2, ${dec}::uuid, 'complete', 'edited', ${roadmapA}::uuid, 'revised', ${w.aOwner}::uuid)`.execute(owner.kysely);
    };
    const staleRm = await generateTasks(product, base(), { gateway: okGateway() }, { beforePersist: newVersion });
    expect(staleRm.status).toBe('stale_roadmap');
    expect(await tasksFor()).toHaveLength(0);
  });

  test('authz: a viewer MAY plan; a non-member is forbidden', async () => {
    await seedChain('whole_plan');
    expect((await generateTasks(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 }, { gateway: okGateway() })).status).toBe('ok');
    expect((await generateTasks(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 }, { gateway: okGateway() })).status).toBe('forbidden');
  });

  test('repeat planning appends and CONTINUES the rank rather than restating 0 (append-only, CDR-040 §8-G7)', async () => {
    await seedChain('whole_plan');
    await generateTasks(product, base(), { gateway: okGateway() });
    await generateTasks(product, base(), { gateway: okGateway() });
    const rows = await tasksFor();
    expect(rows).toHaveLength(6);
    expect(rows.map((t) => t.priority)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // ── PLAN-002 steering: three distinct SUCCESSFUL answers ────────────────────────────────────────────────
  test('steering with a clear request produces tasks + the interpreted INTENT (previewed, never persisted)', async () => {
    await seedChain('whole_plan');
    const r = await steerTaskPlanning(product, { ...base(), request: '  get me in front of clinics  ' }, { gateway: gatewayWith({ kind: 'respond', output: steerOutput() }, 4) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.intent).toBe('Find early customers');
    expect(r.tasks).toHaveLength(1); // no 3+ minimum on steering
    const rows = await tasksFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('draft');
    expect(await taskAudits()).toBe(0);
    // The intent is a preview value only — nothing persists it (the input snapshot is P4-006).
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks where company_id = ${w.companyA1}::uuid and title = 'Find early customers'`.execute(owner.kysely)).rows[0]!.n).toBe(0);
  });

  test('an AMBIGUOUS request yields a CLARIFYING QUESTION — a successful answer, not a failure, and nothing is planned', async () => {
    await seedChain('whole_plan');
    const out = JSON.stringify({ outcome: 'clarification', question: 'Which customer segment do you mean?' });
    const r = await steerTaskPlanning(product, { ...base(), request: 'do the thing' }, { gateway: gatewayWith({ kind: 'respond', output: out }, 4) });
    expect(r.status).toBe('clarification_needed');
    if (r.status === 'clarification_needed') expect(r.question).toBe('Which customer segment do you mean?');
    expect(await tasksFor()).toHaveLength(0);
  });

  test('an unmeetable request yields an HONEST REFUSAL — also a successful answer, distinct from generation_failed', async () => {
    await seedChain('whole_plan');
    const out = JSON.stringify({ outcome: 'refusal', reason: 'That is outside this roadmap.' });
    const r = await steerTaskPlanning(product, { ...base(), request: 'file my taxes' }, { gateway: gatewayWith({ kind: 'respond', output: out }, 4) });
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.reason).toBe('That is outside this roadmap.');
    expect(await tasksFor()).toHaveLength(0);
    // A refusal is NOT a failure: the caller can tell them apart.
    expect((await steerTaskPlanning(product, { ...base(), request: 'x' }, { gateway: gatewayWith({ kind: 'fail', error: 'provider_unavailable' }, 4) })).status).toBe('generation_failed');
  });

  test('steering: a blank or over-long request is invalid; an unauthorized caller learns only `forbidden`', async () => {
    await seedChain('whole_plan');
    for (const request of ['   ', 'x'.repeat(2_001), 42, undefined]) {
      expect((await steerTaskPlanning(product, { ...base(), request }, { gateway: gatewayWith({ kind: 'respond', output: steerOutput() }, 4) })).status).toBe('invalid');
    }
    // AUTHZ BEFORE VALIDATION — a non-member with the same bad request never learns it would have been invalid.
    expect((await steerTaskPlanning(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, request: '   ' }, { gateway: gatewayWith({ kind: 'respond', output: steerOutput() }, 4) })).status).toBe('forbidden');
    expect(await tasksFor()).toHaveLength(0);
  });

  test('steering obeys the same gate: a REJECT decision blocks it exactly as it blocks generation', async () => {
    await seedChain('whole_plan');
    await seedRejectDecision();
    expect((await steerTaskPlanning(product, { ...base(), request: 'plan something' }, { gateway: gatewayWith({ kind: 'respond', output: steerOutput() }, 4) })).status).toBe('decision_rejected');
    expect(await tasksFor()).toHaveLength(0);
  });

  test('cross-company isolation: company A2 has no decision, and A1 is unaffected', async () => {
    await seedChain('whole_plan');
    await generateTasks(product, base(), { gateway: okGateway() });
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 };
    expect((await generateTasks(product, a2, { gateway: okGateway() })).status).toBe('no_decision');
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks where company_id = ${w.companyA2}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(0);
    expect(await tasksFor()).toHaveLength(3);
  });
});
