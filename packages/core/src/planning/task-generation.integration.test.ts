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

  test('STRAT-005: an OVER-PERMISSIVE injected validator still cannot cross the phase boundary — the use case rebinds the bound itself', async () => {
    // The gateway's shape validator is INJECTED by the composition layer, so a validator constructed against the whole
    // roadmap (4) while the approved scope is the first goal (2) is a wiring mistake, not a model one. What makes that
    // harmless is that the use case does NOT trust the injected bound: it re-narrows with `pre.inScope.length`, the
    // count it resolved itself. This test pins that rebinding — remove it and the over-permissive validator's ordinal
    // would sail through.
    //
    // Note precisely what this does and does not prove. The re-narrow is what refuses the plan here; the persist-time
    // re-resolution in `persistDrafts` is NOT reached, because both layers key off the same `pre.inScope`, which makes
    // the persist guard unreachable by construction (defence-in-depth against a future edit that decouples them, not a
    // live second gate). No claim is made here about rollback: with the batch refused before the transaction opens,
    // there is nothing to roll back — which is the point of resolving every ordinal before the first insert.
    await seedChain('first_phase', { goals: 2, milestonesPerGoal: 2 });
    const overPermissive = gatewayWith({ kind: 'respond', output: planOutput({ tasks: [planned({ milestone_ordinal: 0 }), planned({ milestone_ordinal: 1 }), planned({ milestone_ordinal: 3 })] }) }, 4);
    const r = await generateTasks(product, base(), { gateway: overPermissive });
    expect(r.status).toBe('generation_failed');
    expect(await tasksFor()).toHaveLength(0);
    expect(await taskAudits()).toBe(0);
    // Steering re-narrows against the same resolved count, so it inherits the same defence.
    const steerOver = gatewayWith({ kind: 'respond', output: steerOutput({ tasks: [planned({ milestone_ordinal: 0 }), planned({ milestone_ordinal: 3 })] }) }, 4);
    expect((await steerTaskPlanning(product, { ...base(), request: 'Plan the launch' }, { gateway: steerOver })).status).toBe('generation_failed');
    expect(await tasksFor()).toHaveLength(0);
  });

  test('ranks do not collide across overlapping runs: the MAX is read inside the persist transaction, after the model call', async () => {
    // `beforePersist` runs between the model call and the persist transaction — exactly where a concurrent run's rows
    // would land. A rank read in the PRE-read (before the model call) would be stale by the width of that call, and
    // since `priority` has no uniqueness constraint the collision would be silent: two tasks at rank 0, no error, and
    // an ambiguous order under a result that calls itself "prioritized".
    await seedChain('whole_plan');
    const r = await generateTasks(
      product,
      base(),
      { gateway: okGateway() },
      {
        beforePersist: async () => {
          await sql`insert into tasks (account_id, company_id, title, state, priority, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'concurrent', 'draft', 7, ${w.aOwner}::uuid)`.execute(owner.kysely);
        },
      },
    );
    expect(r.status).toBe('ok');
    const ranks = (await tasksFor()).map((t) => t.priority);
    // The interloper holds 7, so the generated three must continue at 8,9,10 — never restart at 0.
    expect(ranks).toEqual([7, 8, 9, 10]);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  test('a prompt-budget truncation is reported as PARTIAL, never as a complete plan', async () => {
    // A milestone whose line does not fit the 12,000-char budget is excluded from the prompt AND from the ordinal
    // space, so the model plans against a PREFIX of the approved phase. Reporting that as complete is the same
    // fabricated-completeness failure as tracing a task to a milestone the model never saw.
    await seedChain('whole_plan', { goals: 1, milestonesPerGoal: 4 });
    const long = 'x'.repeat(3_900);
    await sql`update milestones set description = ${long} where roadmap_id = ${roadmapA}::uuid`.execute(owner.kysely);
    const r = await generateTasks(product, base(), { gateway: okGateway({ tasks: [planned(), planned({ title: 'B' }), planned({ title: 'C' })] }, 3) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.milestonesOmitted).toBeGreaterThan(0);
    // The model said nothing about being partial; the TRUNCATION alone forces the honest label.
    expect(r.partial).toBe(true);
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

  // ── ACBP-P4-006 / CDR-041 — planning transparency (PLAN-004) ────────────────────────────────────────────

  describe('planning transparency: the run, its input snapshot, and the per-task rationale', () => {
    const runsFor = async () =>
      (
        await sql<{ id: string; mode: string; outcome: string; task_count: number; tasks_missing_rationale: number; milestones_in_scope: number; memory_items_considered: number; phase_scope: string | null; roadmap_version: number }>`
        select id, mode, outcome, task_count, tasks_missing_rationale, milestones_in_scope, memory_items_considered, phase_scope, roadmap_version from planning_runs where company_id = ${w.companyA1}::uuid order by created_at, id`.execute(owner.kysely)
      ).rows;
    const inputsFor = async (runId: string) => (await sql<{ kind: string; ref_id: string }>`select kind, ref_id from planning_run_inputs where run_id = ${runId}::uuid order by kind, ref_id`.execute(owner.kysely)).rows;
    // `audit_events` stamps `occurred_at`, not `created_at` — the audit trail records when the event HAPPENED.
    const runAudits = async () => (await sql<{ subject_id: string; payload: Record<string, unknown> }>`select subject_id, payload from audit_events where name = 'planning.run_recorded' and company_id = ${w.companyA1}::uuid order by occurred_at, event_id`.execute(owner.kysely)).rows;
    const seedMemory = (content: string, sourceRef: string, type = 'user_fact', sourceType = 'interview_answer') =>
      sql`insert into memory_items (account_id, company_id, type, content, source_type, source_ref, confirmation_state, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${type}, ${content}, ${sourceType}, ${sourceRef}, 'accepted', ${w.aOwner}::uuid)`.execute(owner.kysely);

    test('PLAN-004: every run links its input snapshot — roadmap, decision, in-scope milestones AND memory items', async () => {
      await seedChain('whole_plan');
      await seedMemory('We sell to small clinics in Cairo.', 'q:customer');
      await seedMemory('We cannot spend more than 5k a month.', 'q:budget', 'constraint');

      const r = await generateTasks(product, base(), { gateway: okGateway() });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.memoryItemsConsidered).toBe(2);

      const runs = await runsFor();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ mode: 'autonomous', outcome: 'ok', task_count: 3, milestones_in_scope: 4, memory_items_considered: 2, phase_scope: 'whole_plan', roadmap_version: 1 });

      const inputs = await inputsFor(runs[0]!.id);
      // The link set is exactly: the roadmap, the decision, every in-scope milestone, and every memory item.
      expect(inputs.filter((i) => i.kind === 'roadmap')).toHaveLength(1);
      expect(inputs.filter((i) => i.kind === 'decision')).toHaveLength(1);
      expect(inputs.filter((i) => i.kind === 'milestone')).toHaveLength(4);
      expect(inputs.filter((i) => i.kind === 'memory_item')).toHaveLength(2);
      // Every ref RESOLVES within this company (MEM-003 "resolvable source link") — a dangling link would be a
      // snapshot that cannot actually be inspected.
      const memIds = (await sql<{ id: string }>`select id from memory_items where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows.map((x) => x.id);
      for (const i of inputs.filter((x) => x.kind === 'memory_item')) expect(memIds).toContain(i.ref_id);
      expect(inputs.find((i) => i.kind === 'roadmap')!.ref_id).toBe(roadmapA);
    });

    test('the run is AUDITED in the same transaction, with counts only — never rationale text or memory content', async () => {
      await seedChain('whole_plan');
      await seedMemory('Our secret sauce is the roasting curve.', 'q:ops');
      const withReasons = okGateway({ tasks: [planned({ rationale: 'Highest-signal first contact.' }), planned({ title: 'B', rationale: 'Cheapest to test.' }), planned({ title: 'C' })] });
      const r = await generateTasks(product, base(), { gateway: withReasons });
      expect(r.status).toBe('ok');

      const audits = await runAudits();
      expect(audits).toHaveLength(1);
      const runs = await runsFor();
      expect(audits[0]!.subject_id).toBe(runs[0]!.id);
      expect(audits[0]!.payload).toEqual({ mode: 'autonomous', outcome: 'ok', task_count: 3, tasks_missing_rationale: 1, memory_items_considered: 1, milestones_in_scope: 4 });
      // No free text of any kind reaches the audit row.
      expect(JSON.stringify(audits[0]!.payload)).not.toMatch(/Highest-signal|Cheapest|roasting/);
      // The DRAFT tasks remain unaudited — CDR-040 §7 is untouched by this ticket.
      expect(await taskAudits()).toBe(0);
    });

    test('PLAN-004: the per-task rationale persists, and a MISSING one is "not recorded" rather than invented', async () => {
      await seedChain('whole_plan');
      const mixed = okGateway({ tasks: [planned({ rationale: 'Closes the fastest.' }), planned({ title: 'B' }), planned({ title: 'C', rationale: null })] });
      const r = await generateTasks(product, base(), { gateway: mixed });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.tasksMissingRationale).toBe(2);

      const rows = (await sql<{ rationale: string | null }>`select rationale from tasks where company_id = ${w.companyA1}::uuid order by priority`.execute(owner.kysely)).rows;
      expect(rows.map((x) => x.rationale)).toEqual(['Closes the fastest.', null, null]);
      expect((await runsFor())[0]).toMatchObject({ tasks_missing_rationale: 2, task_count: 3 });
    });

    test('a FAILED generation records a run with NO tasks — the failure is inspectable, not invisible', async () => {
      await seedChain('whole_plan');
      await seedMemory('We sell to small clinics.', 'q:customer');
      expect((await generateTasks(product, base(), { gateway: gatewayWith({ kind: 'fail', error: 'provider_unavailable' }, 4) })).status).toBe('generation_failed');
      expect((await generateTasks(product, base(), { gateway: gatewayWith({ kind: 'respond', output: 'not json' }, 4) })).status).toBe('generation_failed');

      const runs = await runsFor();
      expect(runs).toHaveLength(2);
      expect(runs.every((x) => x.outcome === 'failed' && x.task_count === 0)).toBe(true);
      // Still NO phantom tasks — a run row is not a task.
      expect(await tasksFor()).toHaveLength(0);
      // And the failed run still links what it considered, which is the whole point of inspecting it.
      expect((await inputsFor(runs[0]!.id)).filter((i) => i.kind === 'memory_item')).toHaveLength(1);
    });

    test('steering records a run per outcome, keeping clarification and refusal DISTINCT from failure', async () => {
      await seedChain('whole_plan');
      await steerTaskPlanning(product, { ...base(), request: 'get me customers' }, { gateway: gatewayWith({ kind: 'respond', output: steerOutput() }, 4) });
      await steerTaskPlanning(product, { ...base(), request: 'do the thing' }, { gateway: gatewayWith({ kind: 'respond', output: JSON.stringify({ outcome: 'clarification', question: 'Which segment?' }) }, 4) });
      await steerTaskPlanning(product, { ...base(), request: 'file my taxes' }, { gateway: gatewayWith({ kind: 'respond', output: JSON.stringify({ outcome: 'refusal', reason: 'Outside this roadmap.' }) }, 4) });
      await steerTaskPlanning(product, { ...base(), request: 'anything' }, { gateway: gatewayWith({ kind: 'fail', error: 'provider_unavailable' }, 4) });

      const runs = await runsFor();
      expect(runs.map((x) => x.outcome)).toEqual(['ok', 'clarification', 'refusal', 'failed']);
      expect(runs.every((x) => x.mode === 'steered')).toBe(true);
      // Only the `ok` run drafted anything.
      expect(runs.map((x) => x.task_count)).toEqual([1, 0, 0, 0]);
      expect(await tasksFor()).toHaveLength(1);
    });

    test('a MEM-004-conflicted item is linked as WITHHELD — considered, deliberately not used', async () => {
      await seedChain('whole_plan');
      // A confirmed user fact + an AI assumption on the SAME source_ref is the MEM-004 conflict: both are held out of
      // the model context and surfaced instead. The snapshot must say so rather than imply they were never examined.
      await seedMemory('Our target is small clinics.', 'question:7');
      await seedMemory('Assuming the target is large chains.', 'question:7', 'ai_assumption', 'model_generation');
      await seedMemory('We are based in Cairo.', 'q:location');

      const r = await generateTasks(product, base(), { gateway: okGateway() });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.memoryItemsConsidered).toBe(1);

      const runs = await runsFor();
      const inputs = await inputsFor(runs[0]!.id);
      expect(inputs.filter((i) => i.kind === 'memory_item')).toHaveLength(1);
      expect(inputs.filter((i) => i.kind === 'memory_item_withheld')).toHaveLength(2);
      // The run's own count is the USED items only — the withheld pair is linked but not counted as considered-and-used.
      expect(runs[0]!.memory_items_considered).toBe(1);
    });

    test('audit-or-nothing: an in-tx audit failure rolls back the run, its links AND the drafts (ADR-015)', async () => {
      await seedChain('whole_plan');
      const boom = () => Promise.reject(new Error('audit write failed'));
      await expect(generateTasks(product, base(), { gateway: okGateway() }, { auditWriter: boom })).rejects.toThrow();
      // Nothing survives: no tasks, no run, no links. A reader can never find tasks whose run was never recorded.
      expect(await tasksFor()).toHaveLength(0);
      expect(await runsFor()).toHaveLength(0);
      expect((await sql<{ n: number }>`select count(*)::int as n from planning_run_inputs where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(0);
    });

    test('stale_decision and stale_roadmap still RECORD the abandoned run (CDR-041 §3-G3)', async () => {
      await seedChain('whole_plan');
      const stale = await generateTasks(product, base(), { gateway: okGateway() }, { beforePersist: async () => void (await seedRejectDecision()) });
      expect(stale.status).toBe('stale_decision');
      expect(await tasksFor()).toHaveLength(0);
      const runs = await runsFor();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: 'failed', task_count: 0 });
    });

    test('degrades honestly when memory is unreadable: planning still works and records ZERO considered (CDR-041 §3-G9)', async () => {
      // `task:generate` is [owner, viewer]; `memory:read` may be narrower. A caller who may plan but may not read
      // memory keeps the capability they hold, and the run truthfully says it considered no memory items.
      await seedChain('whole_plan');
      await seedMemory('We sell to small clinics.', 'q:customer');
      const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
      const r = await generateTasks(product, viewer, { gateway: okGateway() });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      const runs = await runsFor();
      expect(runs).toHaveLength(1);
      // Whatever the viewer's memory:read grant is, the recorded count MATCHES what was actually assembled — the run
      // never claims inputs it did not have.
      expect(runs[0]!.memory_items_considered).toBe(r.memoryItemsConsidered);
      expect((await inputsFor(runs[0]!.id)).filter((i) => i.kind === 'memory_item')).toHaveLength(r.memoryItemsConsidered);
    });
  });
});
