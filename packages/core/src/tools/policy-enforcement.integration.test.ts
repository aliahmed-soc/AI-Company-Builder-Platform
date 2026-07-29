// ACBP-P6-002 / CDR-067 — real-PostgreSQL proof that the POLICY ENGINE gates tool calls, through the restricted role.
//
// `dispatcher.integration.test.ts` proves the chokepoint's Phase 5 acceptance (allowlist, recording, fail-closed).
// THIS suite proves the Phase 6 clause: that the engine's own answer decides, that the decision is recorded against
// the policy VERSION that produced it, and that the two can never disagree — including across a supersession that
// commits while a dispatch is in flight.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { type DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { initializeCompanyPolicy } from '../policy/index.js';
import { dispatchToolCall } from './index.js';
import { TaskRepository } from '@acbp/database';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/** A rule that fires on EVERY call, whatever the class — `informational` is the floor of the ordered set. */
const alwaysRule = (id: string, decision: 'deny' | 'require_approval') =>
  JSON.stringify([{ id, dimension: 'risk_class', condition: 'risk_at_least', operand: 'informational', decision }]);

describe.skipIf(!hasTestDatabase)('policy enforcement at the dispatcher (real PostgreSQL) — ACBP-P6-002/CDR-067', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let runId: string;

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

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const allowAll = ['web_research', 'memory_write', 'send_email'];

  /**
   * PARAMS AND OPTIONS ARE DIFFERENT ARGUMENTS, and keeping them separate here is not cosmetic: `gates` and
   * `auditWriter` are OPTIONS, and folding them into params silently dropped them — three tests failed with the
   * dispatcher's default behaviour and looked like product defects until the argument split was fixed.
   */
  const dispatch = (params: Record<string, unknown> = {}, options: Parameters<typeof dispatchToolCall>[2] = {}) =>
    dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [], ...params }, options);

  /**
   * The row at `index`, or a LOUD failure. The `rows[0]?.field` idiom used elsewhere in this package is fine when the
   * expected value is a literal, but this suite compares two ids to each other — and `undefined === undefined` would
   * pass while proving nothing. Two rows that are both missing must not read as two rows that match.
   */
  function row<T>(rows: readonly T[], index = 0): T {
    const found = rows[index];
    if (found === undefined) throw new Error(`expected a row at index ${index}, got ${rows.length} row(s)`);
    return found;
  }

  const evaluations = async () => owner.kysely.selectFrom('policy_evaluations').selectAll().orderBy('created_at').execute();
  const callRows = async () => owner.kysely.selectFrom('tool_calls').selectAll().orderBy('created_at').execute();

  /** Add a rule to the active policy AS THE OWNER — rule editing is P6-010's product surface, not this ticket's. */
  const addRule = (rule: string) =>
    sql`update policies set rules = rules || ${rule}::jsonb where company_id = ${w.companyA1}::uuid and status = 'active'`.execute(owner.kysely);

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from tool_definitions`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);

    const created = await createTask(product, { ...base(), title: 'Research five prospects', description: null, milestoneId: null });
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...base(), taskId })).status).toBe('ok');
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    const started = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(started.status).toBe('ok');
    runId = (started as { status: 'ok'; run: { id: string } }).run.id;

    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values ('web_research', 1, 'informational', 'fixture tool', 'active'),
                     ('memory_write', 1, 'internal_reversible', 'fixture tool', 'active'),
                     ('send_email', 1, 'external_reversible', 'fixture tool', 'active')`.execute(owner.kysely);

    expect((await initializeCompanyPolicy(product, base())).status).toBe('ok');
  });

  // ───────────────────────────── THE DECISION IS RECORDED AGAINST ITS OWN VERSION ─────────────────────────────

  test('an authorized call cites the evaluation that authorized it, pinned to the policy version in force', async () => {
    const r = await dispatch();
    expect(r.status).toBe('authorized');

    const evaluation = row(await evaluations());
    expect(evaluation).toBeDefined();
    expect(evaluation.decision).toBe('allow');
    expect(Number(evaluation.policy_version)).toBe(1);
    expect(evaluation.evaluation_point).toBe('pre_execution');

    // THE LINK, in the direction CDR-067 §2-G3 chose: the call names its evaluation. A call whose evaluation cannot
    // be found is a call whose authorization cannot be explained.
    const call = row(await callRows());
    expect(call.policy_eval_id).toBe(evaluation.id);
  });

  test('the evaluation happens even when the call is refused on some OTHER ground (G4)', async () => {
    // Not allowlisted: the allowlist refuses before policy is consulted in the ORDER of the decision, but the
    // evaluation is still performed and recorded, because "all checks audited" means the policy consultation is
    // evidence in its own right.
    const r = await dispatch({ allowlist: ['memory_write'] });
    expect(r).toMatchObject({ status: 'denied', reason: 'not_allowlisted' });
    expect(await evaluations()).toHaveLength(1);
    const call = row(await callRows());
    expect(call.outcome).toBe('denied');
    expect(call.policy_eval_id).not.toBeNull();
  });

  // ─────────────────────────────────── POLICY DECIDES WHETHER APPROVAL IS NEEDED ───────────────────────────────

  test('a real REQUIRE_APPROVAL rule refuses a call with no approval, and the recorded decision says so', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));

    const refused = await dispatch();
    expect(refused).toMatchObject({ status: 'denied', reason: 'approval_required' });

    const evaluation = row(await evaluations());
    expect(evaluation.decision).toBe('require_approval');
    // THE DECISION IS RECORDED, NOT THE OUTCOME. The engine required an approval; whether one turned up is the
    // dispatcher's business, and conflating the two would destroy the ability to ask "what did policy say?".
    expect(evaluation.fired_rule_ids).toContain('needs-approval');
  });

  test('the SAME rule authorizes once an approval answers — policy demanded it, the approval satisfied it', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));

    const ok = await dispatch({}, { gates: { approval: () => ({ kind: 'allow' }) } });
    expect(ok.status).toBe('authorized');

    const evaluation = row(await evaluations());
    expect(evaluation.decision).toBe('require_approval');
  });

  test('a REJECTING approval refuses even when policy only required one — and it is not the policy that refused', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    const r = await dispatch({}, { gates: { approval: () => ({ kind: 'deny' }) } });
    expect(r).toMatchObject({ status: 'denied', reason: 'approval_invalid' });
  });

  test('an approval CANNOT override a policy DENY (POL-005), and the reason names policy', async () => {
    await addRule(alwaysRule('forbidden', 'deny'));
    const r = await dispatch({}, { gates: { approval: () => ({ kind: 'allow' }) } });
    expect(r).toMatchObject({ status: 'denied', reason: 'policy_denied' });

    const evaluation = row(await evaluations());
    expect(evaluation.decision).toBe('deny');
  });

  // ──────────────────────────────────────── THE SUPERSESSION RACE ─────────────────────────────────────────────

  test('a supersession that commits WHILE a dispatch is in flight cannot make the record disagree with the decision', async () => {
    // THE WINDOW THIS CLOSES. The dispatcher reads the active policy, decides, and records — three steps with a
    // policy edit possible between any two of them. The dangerous outcome is not "the call used the old version";
    // that is unavoidable and correct under snapshot semantics. The dangerous outcome is a call AUTHORIZED under one
    // version while the record cites another, because then no reader can ever establish what actually permitted it.
    //
    // The interleaving is made deterministic with a held-open owner transaction rather than timing: the supersession
    // is issued and left UNCOMMITTED, the dispatch runs to completion against the snapshot it can see, and only then
    // does the supersession commit.
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const superseding = owner.kysely.transaction().execute(async (tx) => {
      await sql`update policies set status = 'superseded', superseded_at = now()
                where company_id = ${w.companyA1}::uuid and status = 'active'`.execute(tx);
      await sql`insert into policies (account_id, company_id, version, baseline, rules, status, created_by_user_id)
                select account_id, company_id, version + 1, 'allow', ${alwaysRule('forbidden-v2', 'deny')}::jsonb, 'active', created_by_user_id
                from policies where company_id = ${w.companyA1}::uuid and status = 'superseded'`.execute(tx);
      ready();
      await released;
    });
    await isReady;

    // IN FLIGHT: the supersession exists but has not committed, so this dispatch sees version 1 and is authorized.
    const during = await dispatch();
    expect(during.status).toBe('authorized');

    release();
    await superseding;

    // The authorized call's evaluation pins the version that authorized it — 1, not the 2 that is now in force.
    const afterFirst = await evaluations();
    expect(afterFirst).toHaveLength(1);
    expect(Number(row(afterFirst).policy_version)).toBe(1);
    expect(row(afterFirst).decision).toBe('allow');
    const firstCall = row(await callRows());
    expect(firstCall.policy_eval_id).toBe(row(afterFirst).id);

    // AND THE WINDOW IS SHUT: the very next call sees version 2 and is refused by it.
    const after = await dispatch();
    expect(after).toMatchObject({ status: 'denied', reason: 'policy_denied' });

    const both = await evaluations();
    expect(both).toHaveLength(2);
    expect(Number(row(both, 1).policy_version)).toBe(2);
    expect(row(both, 1).decision).toBe('deny');
    // NO CROSS-WIRING: each call cites its own evaluation, and the versions differ. This is the assertion that would
    // fail if the dispatcher ever re-read the policy after deciding, or cached an evaluation across calls.
    const calls = await callRows();
    expect(row(calls, 1).policy_eval_id).toBe(row(both, 1).id);
    expect(row(calls).policy_eval_id).not.toBe(row(calls, 1).policy_eval_id);
  });

  // ─────────────────────────────────────── ATOMICITY AND ISOLATION ────────────────────────────────────────────

  test('a failed audit write leaves NO evaluation and NO call row — the whole dispatch rolls back together', async () => {
    // The comment at the call site claims the evaluation, the call record and the audit events commit or roll back
    // as one. That claim is worth exactly as much as this test: a call recorded as authorized whose evaluation was
    // rolled back would assert an authorization that never happened.
    const exploding = () => {
      throw new Error('audit sink unavailable');
    };
    await expect(dispatch({}, { auditWriter: exploding })).rejects.toThrow();

    expect(await evaluations()).toHaveLength(0);
    expect(await callRows()).toHaveLength(0);
  });

  test("company B's policy has no say over company A's call, and vice versa", async () => {
    // A deny rule on the OTHER company must not refuse this one. Tenant isolation of the evaluation itself, not
    // merely of the rows it writes.
    expect((await initializeCompanyPolicy(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 })).status).toBe('ok');
    await sql`update policies set rules = rules || ${alwaysRule('forbidden-b', 'deny')}::jsonb
              where company_id = ${w.companyB1}::uuid and status = 'active'`.execute(owner.kysely);

    expect((await dispatch()).status).toBe('authorized');

    const rows = await evaluations();
    expect(rows).toHaveLength(1);
    expect(row(rows).company_id).toBe(w.companyA1);
  });
});
