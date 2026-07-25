// ACBP-P4-001 / CDR-039 - real-PostgreSQL proof of the planning tables under the RESTRICTED role. Setup/seed on the
// superuser (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner). Proves: dual-keyed
// company-scoped SELECT/INSERT (fail-closed without the company key; cross-company read impossible; cross-tenant
// insert refused); append-only versioning (no UPDATE, no DELETE - a revision is a NEW version row, which is what makes
// ROAD-002's "version write failure blocks the edit rather than losing history" structural); UNIQUE(company_id,
// version); the edit_reason shape CHECK (a generated version carries none, an edited version must carry one - ROAD-002
// "record rationale"); the supersedes chain CHECK; ordinal sequencing + UNIQUE per roadmap; the composite FK keeping a
// milestone's goal inside the SAME roadmap version; the new tasks->milestones FK (ROAD-001 "tasks trace to
// milestones") with its ON DELETE SET NULL behaviour; task_review_flags idempotency; FK cascade; and the catalog
// (FORCE RLS, SELECT/INSERT grants, no column UPDATE, exactly 3 SECURITY DEFINER, 0026 applied). Skips when
// ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `plan_${'test'}_pw_1970`;

const ALL = ['task_review_flags', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-plan-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-plan-test' }));
}

describe.skipIf(!hasTestDatabase)('planning tables (real PostgreSQL, restricted role) - ACBP-P4-001/CDR-039', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let decisionA = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  /** Seed the decision a roadmap must derive from (owner/superuser bypasses RLS). */
  async function seedDecision(a: string, c: string): Promise<string> {
    const k = su.kysely;
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${a}::uuid, ${c}::uuid, 1, 'complete', 0.6, ${userU}::uuid) returning id`.execute(k)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${doc}::uuid, 1, 'complete', 3, ${userU}::uuid) returning id`.execute(k)).rows[0]!.id;
    const opt = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, 0, '{}'::jsonb) returning id`.execute(k)).rows[0]!.id;
    const sel = (await sql<{ id: string }>`insert into strategy_selections (account_id, company_id, generation_id, mode, selected_option_id, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, 'select', ${opt}::uuid, ${userU}::uuid) returning id`.execute(k)).rows[0]!.id;
    return (await sql<{ id: string }>`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, ${sel}::uuid, 'select', 1, ${userU}::uuid) returning id`.execute(k)).rows[0]!.id;
  }

  async function insertRoadmap(a: string, c: string, decision: string, over: { version?: number; origin?: string; reason?: string | null; supersedes?: string | null; status?: string } = {}): Promise<string> {
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into roadmaps (account_id, company_id, version, decision_id, status, origin, supersedes_roadmap_id, edit_reason, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${over.version ?? 1}, ${decision}::uuid, ${over.status ?? 'complete'}, ${over.origin ?? 'generated'}, ${over.supersedes ?? null}, ${over.reason ?? null}, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }
  async function insertGoal(a: string, c: string, roadmap: string, ordinal: number): Promise<string> {
    return asApp(scope(a, c), async (k) => (await sql<{ id: string }>`insert into goals (account_id, company_id, roadmap_id, ordinal, title) values (${a}::uuid, ${c}::uuid, ${roadmap}::uuid, ${ordinal}, 'Reach revenue') returning id`.execute(k)).rows[0]!.id);
  }
  async function insertMilestone(a: string, c: string, roadmap: string, ordinal: number, goal: string | null = null): Promise<string> {
    return asApp(scope(a, c), async (k) => (await sql<{ id: string }>`insert into milestones (account_id, company_id, roadmap_id, goal_id, ordinal, title) values (${a}::uuid, ${c}::uuid, ${roadmap}::uuid, ${goal}, ${ordinal}, 'Ship the landing page') returning id`.execute(k)).rows[0]!.id);
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    expect((await migrateToLatest(su)).error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    userU = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_plan', 'user_plan_u', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    const userV = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_plan', 'user_plan_v', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    decisionA = await seedDecision(accountA, companyA1);

    // Prove the migration reverses and re-applies cleanly (down() drops the tasks FK first so milestones is droppable).
    const down = await createMigrator(su).migrateTo('0025_decisions');
    expect(down.error).toBeUndefined();
    expect((await migrateToLatest(su)).error).toBeUndefined();
  });

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ALL) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    // Child-first: flags -> tasks -> milestones -> goals -> roadmaps (the decision + its chain are reused).
    for (const t of ['task_review_flags', 'tasks', 'milestones', 'goals', 'roadmaps'] as const) {
      await sql`delete from ${sql.ref(t)}`.execute(su.kysely);
    }
  });

  test('dual-keyed SELECT/INSERT: a roadmap is visible only under its own account+company; cross-company read impossible', async () => {
    await insertRoadmap(accountA, companyA1, decisionA);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('roadmaps').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('roadmaps').selectAll().execute())).toHaveLength(0);
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('roadmaps').selectAll().execute())).toHaveLength(0); // fail closed
  });

  test('cross-tenant INSERT is refused on every planning table (WITH CHECK)', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into roadmaps (account_id, company_id, version, decision_id, status, origin, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, 1, ${decisionA}::uuid, 'complete', 'generated', ${userU}::uuid)`.execute(k))).rejects.toThrow();
    const rm = await insertRoadmap(accountA, companyA1, decisionA);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into goals (account_id, company_id, roadmap_id, ordinal, title) values (${accountB}::uuid, ${companyB1}::uuid, ${rm}::uuid, 0, 'x')`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into milestones (account_id, company_id, roadmap_id, ordinal, title) values (${accountB}::uuid, ${companyB1}::uuid, ${rm}::uuid, 0, 'x')`.execute(k))).rejects.toThrow();
  });

  test('APPEND-ONLY versioning: no UPDATE, no DELETE — a revision is a NEW version row', async () => {
    const v1 = await insertRoadmap(accountA, companyA1, decisionA);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update roadmaps set status = 'partial' where id = ${v1}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from roadmaps where id = ${v1}::uuid`.execute(k))).rejects.toThrow();
    // The revision path: a NEW version that names what it supersedes. History is retained.
    const v2 = await insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'edited', reason: 'scope cut after customer calls', supersedes: v1 });
    expect(v2).not.toBe(v1);
    expect((await sql<{ n: number }>`select count(*)::int as n from roadmaps where company_id = ${companyA1}::uuid`.execute(su.kysely)).rows[0]!.n).toBe(2);
    // Goals and milestones are immutable too.
    const g = await insertGoal(accountA, companyA1, v1, 0);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update goals set title = 'rewritten' where id = ${g}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from goals where id = ${g}::uuid`.execute(k))).rejects.toThrow();
  });

  test('version integrity: UNIQUE(company_id, version), version >= 1, and the supersedes chain CHECK', async () => {
    const v1 = await insertRoadmap(accountA, companyA1, decisionA);
    await expect(insertRoadmap(accountA, companyA1, decisionA, { version: 1 })).rejects.toThrow(); // duplicate version
    await expect(insertRoadmap(accountA, companyA1, decisionA, { version: 0 })).rejects.toThrow(); // version >= 1
    // Version 1 supersedes nothing; a later version MUST name what it supersedes (an unbroken history chain).
    await expect(insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'edited', reason: 'r' })).rejects.toThrow(); // v>1 without supersedes
    // (The "v1 must supersede nothing" branch is not asserted here: version 1 already exists, so UNIQUE would fire
    // first and the assertion would pass for the wrong reason.)
    // A RE-GENERATION is legal: a new GENERATED version that supersedes the previous one (no owner reason to record).
    expect(await insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'generated', supersedes: v1 })).toBeTruthy();
  });

  test('ROAD-002 "record rationale": an EDITED version must carry a reason; a GENERATED version must not', async () => {
    const v1 = await insertRoadmap(accountA, companyA1, decisionA);
    // edited without a reason → refused.
    await expect(insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'edited', reason: null, supersedes: v1 })).rejects.toThrow();
    // generated WITH a reason → refused (a model generation has no owner rationale to record).
    await expect(insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'generated', reason: 'why', supersedes: v1 })).rejects.toThrow();
    // blank / over-long reasons → refused.
    await expect(insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'edited', reason: '', supersedes: v1 })).rejects.toThrow();
    await expect(insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'edited', reason: 'x'.repeat(4001), supersedes: v1 })).rejects.toThrow();
    // the legal shape.
    expect(await insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'edited', reason: 'scope cut', supersedes: v1 })).toBeTruthy();
  });

  test('ordinal sequencing (ROAD-001 "target sequencing"): unique per roadmap, non-negative', async () => {
    const rm = await insertRoadmap(accountA, companyA1, decisionA);
    await insertMilestone(accountA, companyA1, rm, 0);
    await insertMilestone(accountA, companyA1, rm, 1);
    await expect(insertMilestone(accountA, companyA1, rm, 1)).rejects.toThrow(); // duplicate ordinal in one version
    await expect(insertMilestone(accountA, companyA1, rm, -1)).rejects.toThrow();
    // The SAME ordinal is legal in a DIFFERENT version (sequencing is per version).
    const v2 = await insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'edited', reason: 'r', supersedes: rm });
    expect(await insertMilestone(accountA, companyA1, v2, 0)).toBeTruthy();
  });

  test('composite FK: a milestone cannot reference a goal from a DIFFERENT roadmap version', async () => {
    const v1 = await insertRoadmap(accountA, companyA1, decisionA);
    const v2 = await insertRoadmap(accountA, companyA1, decisionA, { version: 2, origin: 'edited', reason: 'r', supersedes: v1 });
    const goalOfV1 = await insertGoal(accountA, companyA1, v1, 0);
    // v2 + a goal belonging to v1 → the composite (goal_id, roadmap_id) FK refuses it.
    await expect(insertMilestone(accountA, companyA1, v2, 0, goalOfV1)).rejects.toThrow();
    // Linking within the same version is fine, and an UNLINKED milestone is legal (CDR-039 §7-G5).
    expect(await insertMilestone(accountA, companyA1, v1, 0, goalOfV1)).toBeTruthy();
    expect(await insertMilestone(accountA, companyA1, v1, 1, null)).toBeTruthy();
  });

  test('ROAD-001 "tasks trace to milestones": tasks.milestone_id is now FK-checked, and a dropped version nulls it', async () => {
    const rm = await insertRoadmap(accountA, companyA1, decisionA);
    const ms = await insertMilestone(accountA, companyA1, rm, 0);
    // A synthetic milestone id no longer satisfies the column (this is exactly what the FK closes).
    await expect(
      asApp(scope(accountA, companyA1), (k) => sql`insert into tasks (account_id, company_id, milestone_id, title, state, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, gen_random_uuid(), 'orphan', 'draft', ${userU}::uuid)`.execute(k)),
    ).rejects.toThrow();
    const task = await asApp(scope(accountA, companyA1), async (k) => (await sql<{ id: string }>`insert into tasks (account_id, company_id, milestone_id, title, state, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${ms}::uuid, 'real', 'draft', ${userU}::uuid) returning id`.execute(k)).rows[0]!.id);
    // ON DELETE SET NULL (milestone_id): dropping the roadmap version orphans the LINK rather than deleting the task
    // (history kept), and the task's tenancy columns are untouched — a bare composite SET NULL would have nulled
    // company_id, which is NOT NULL.
    await sql`delete from roadmaps where id = ${rm}::uuid`.execute(su.kysely);
    const row = (await sql<{ milestone_id: string | null; company_id: string }>`select milestone_id, company_id from tasks where id = ${task}::uuid`.execute(su.kysely)).rows[0];
    expect(row).toBeDefined();
    expect(row?.milestone_id).toBeNull();
    expect(row?.company_id).toBe(companyA1);
  });

  test('the tasks FK is TENANT-PINNED: company B cannot point a task at company A’s milestone (RI bypasses RLS)', async () => {
    const rm = await insertRoadmap(accountA, companyA1, decisionA);
    const msOfA = await insertMilestone(accountA, companyA1, rm, 0);
    // Referential-integrity checks always bypass row security, so a single-column FK would ACCEPT this: B's own
    // account/company columns satisfy the RLS WITH CHECK, and the FK would only verify the milestone id EXISTS.
    // Carrying company_id into the FK makes the cross-tenant link impossible at the DB.
    await expect(
      asApp(scope(accountB, companyB1), (k) => sql`insert into tasks (account_id, company_id, milestone_id, title, state, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, ${msOfA}::uuid, 'cross-tenant', 'draft', ${userU}::uuid)`.execute(k)),
    ).rejects.toThrow();
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks where company_id = ${companyB1}::uuid`.execute(su.kysely)).rows[0]!.n).toBe(0);
  });

  test('task_review_flags: idempotent per (task, version); bounded reason; cascades with the task', async () => {
    const rm = await insertRoadmap(accountA, companyA1, decisionA);
    const task = await asApp(scope(accountA, companyA1), async (k) => (await sql<{ id: string }>`insert into tasks (account_id, company_id, title, state, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 't', 'planned', ${userU}::uuid) returning id`.execute(k)).rows[0]!.id);
    const flag = (reason: string | null) => asApp(scope(accountA, companyA1), (k) => sql`insert into task_review_flags (account_id, company_id, task_id, roadmap_id, reason) values (${accountA}::uuid, ${companyA1}::uuid, ${task}::uuid, ${rm}::uuid, ${reason})`.execute(k));
    await flag('roadmap revised');
    await expect(flag('again')).rejects.toThrow(); // UNIQUE(task_id, roadmap_id) — a duplicate raw insert is refused
    // The blank-reason CHECK, proved on a DIFFERENT (task, version) pair so the UNIQUE constraint cannot fire first and
    // let this pass for the wrong reason.
    const task2 = await asApp(scope(accountA, companyA1), async (k) => (await sql<{ id: string }>`insert into tasks (account_id, company_id, title, state, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 't2', 'planned', ${userU}::uuid) returning id`.execute(k)).rows[0]!.id);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into task_review_flags (account_id, company_id, task_id, roadmap_id, reason) values (${accountA}::uuid, ${companyA1}::uuid, ${task2}::uuid, ${rm}::uuid, ${''})`.execute(k))).rejects.toThrow();
    await sql`delete from tasks where id = ${task}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from task_review_flags`.execute(su.kysely)).rows[0]!.n).toBe(0);
  });

  test('FK cascade: deleting the roadmap version removes its goals and milestones', async () => {
    const rm = await insertRoadmap(accountA, companyA1, decisionA);
    const g = await insertGoal(accountA, companyA1, rm, 0);
    await insertMilestone(accountA, companyA1, rm, 0, g);
    await sql`delete from roadmaps where id = ${rm}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from goals`.execute(su.kysely)).rows[0]!.n).toBe(0);
    expect((await sql<{ n: number }>`select count(*)::int as n from milestones`.execute(su.kysely)).rows[0]!.n).toBe(0);
  });

  test('catalog: FORCE RLS + select/insert policies + SELECT/INSERT grants + no column UPDATE on all four; 3 SECURITY DEFINER; 0026 applied', async () => {
    for (const t of ['roadmaps', 'goals', 'milestones', 'task_review_flags'] as const) {
      const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${t} and relkind = 'r'`.execute(su.kysely);
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = ${t} order by cmd`.execute(su.kysely);
      expect(pols.rows.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT']);
      const gr = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${t} order by privilege_type`.execute(su.kysely);
      expect(gr.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
      const cols = await sql<{ n: number }>`select count(*)::int as n from information_schema.column_privileges where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${t} and privilege_type = 'UPDATE'`.execute(su.kysely);
      expect(cols.rows[0]?.n).toBe(0);
    }
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0026_planning');
  });
});
