// ACBP-P4-002 / CDR-033 — real-PostgreSQL proof of tasks + task_dependencies under the RESTRICTED role. Setup/seed on
// the superuser (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner). Proves: dual-keyed
// company-scoped SELECT/INSERT (both account AND company; fail closed without the company key; cross-company read
// impossible; cross-tenant insert refused); MUTABLE state (column-scoped UPDATE of state; UPDATE of an immutable column
// refused; no DELETE); task_dependencies append-only (no UPDATE/DELETE) + UNIQUE edge + no-self-dep CHECK; the state +
// title CHECKs; FK cascade (company→all, task→deps); clean down/up/reapply BY NAME; catalog invariants (FORCE RLS,
// grants, exactly 3 SECURITY DEFINER, acbp_app NOBYPASSRLS/non-owner, 0021 applied). Skips when ACBP_TEST_DATABASE_URL
// is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `task_${'test'}_pw_1970`;

const ALL = ['task_review_flags', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-task-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-task-test' }));
}

describe.skipIf(!hasTestDatabase)('tasks + task_dependencies (real PostgreSQL, restricted role) — ACBP-P4-002/CDR-033', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  async function insertTask(a: string, c: string, over: { state?: string; title?: string } = {}): Promise<string> {
    const state = over.state ?? 'draft';
    const title = over.title ?? 'Ship the thing';
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${state}, ${title}, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_task', 'user_task_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_task', 'user_task_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;

    const down = await createMigrator(su).migrateTo('0020_understanding_review');
    expect(down.error).toBeUndefined();
    const up = await migrateToLatest(su);
    expect(up.error).toBeUndefined();
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
    await sql`delete from task_dependencies`.execute(su.kysely);
    await sql`delete from tasks`.execute(su.kysely);
  });

  test('dual-keyed SELECT/INSERT: tasks visible only under their own account+company; cross-company read impossible', async () => {
    await insertTask(accountA, companyA1);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('tasks').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('tasks').selectAll().execute())).toHaveLength(0);
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('tasks').selectAll().execute())).toHaveLength(0); // fail closed
  });

  test('cross-tenant INSERT is refused (WITH CHECK)', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, 'draft', 'x', ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('MUTABLE state: the state column updates; identity/title columns are immutable; no DELETE', async () => {
    const t = await insertTask(accountA, companyA1);
    // A legal-shaped state update succeeds (the state-machine legality is enforced by the core; the column is writable).
    await asApp(scope(accountA, companyA1), (k) => sql`update tasks set state = 'planned', updated_at = now() where id = ${t}::uuid`.execute(k));
    expect((await sql<{ state: string }>`select state from tasks where id = ${t}::uuid`.execute(su.kysely)).rows[0]!.state).toBe('planned');
    // Immutable columns (no column grant) — updating title/company_id is refused.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update tasks set title = 'hacked' where id = ${t}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update tasks set company_id = ${companyB1}::uuid where id = ${t}::uuid`.execute(k))).rejects.toThrow();
    // No DELETE grant.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from tasks where id = ${t}::uuid`.execute(k))).rejects.toThrow();
  });

  test('CHECKs: the closed 11-state set + title length', async () => {
    await expect(insertTask(accountA, companyA1, { state: 'done' })).rejects.toThrow(); // not in the set
    await expect(insertTask(accountA, companyA1, { title: '' })).rejects.toThrow();
    for (const s of ['draft', 'planned', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused', 'completed', 'failed', 'cancelled']) {
      expect(await insertTask(accountA, companyA1, { state: s })).toBeTruthy();
    }
  });

  test('task_dependencies: append-only (no UPDATE/DELETE), UNIQUE edge, no self-dependency', async () => {
    const a = await insertTask(accountA, companyA1);
    const b = await insertTask(accountA, companyA1);
    const dep = await asApp(scope(accountA, companyA1), async (k) => (await sql<{ id: string }>`insert into task_dependencies (account_id, company_id, task_id, depends_on_task_id) values (${accountA}::uuid, ${companyA1}::uuid, ${a}::uuid, ${b}::uuid) returning id`.execute(k)).rows[0]!.id);
    // Self-dependency refused (CHECK).
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into task_dependencies (account_id, company_id, task_id, depends_on_task_id) values (${accountA}::uuid, ${companyA1}::uuid, ${a}::uuid, ${a}::uuid)`.execute(k))).rejects.toThrow();
    // Duplicate edge refused (UNIQUE).
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into task_dependencies (account_id, company_id, task_id, depends_on_task_id) values (${accountA}::uuid, ${companyA1}::uuid, ${a}::uuid, ${b}::uuid)`.execute(k))).rejects.toThrow();
    // Immutable + no delete.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update task_dependencies set task_id = ${b}::uuid where id = ${dep}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from task_dependencies where id = ${dep}::uuid`.execute(k))).rejects.toThrow();
  });

  test('FK cascade: deleting a task removes its dependency edges; deleting the company removes all tasks', async () => {
    const co = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const a = await insertTask(accountA, co);
    const b = await insertTask(accountA, co);
    await asApp(scope(accountA, co), (k) => sql`insert into task_dependencies (account_id, company_id, task_id, depends_on_task_id) values (${accountA}::uuid, ${co}::uuid, ${a}::uuid, ${b}::uuid)`.execute(k));
    await sql`delete from tasks where id = ${a}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from task_dependencies where task_id = ${a}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
    await sql`delete from companies where id = ${co}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks where company_id = ${co}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; policies (tasks select+insert+update, deps select+insert); grants; 3 SECURITY DEFINER; acbp_app trust attrs; 0021 applied', async () => {
    // Table-level grants only (column-scoped UPDATE(state,updated_at) on `tasks` lives in column_privileges, asserted
    // separately below + proven by the mutable-state test above). pg_policies still shows the UPDATE policy on `tasks`.
    for (const [table, cmds, grants] of [['tasks', ['INSERT', 'SELECT', 'UPDATE'], ['INSERT', 'SELECT']], ['task_dependencies', ['INSERT', 'SELECT'], ['INSERT', 'SELECT']]] as const) {
      const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table} and relkind = 'r'`.execute(su.kysely);
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = ${table} order by cmd`.execute(su.kysely);
      expect(pols.rows.map((p) => p.cmd)).toEqual([...cmds]);
      const gr = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table} order by privilege_type`.execute(su.kysely);
      expect(gr.rows.map((g) => g.privilege_type)).toEqual([...grants]);
    }
    // The column-scoped UPDATE grant on `tasks` is EXACTLY state + updated_at (identity/content columns immutable).
    const cols = await sql<{ column_name: string }>`select column_name from information_schema.column_privileges where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'tasks' and privilege_type = 'UPDATE' order by column_name`.execute(su.kysely);
    expect(cols.rows.map((c) => c.column_name)).toEqual(['state', 'updated_at']);
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0021_tasks');
    expect(migs.rows.map((m) => m.name)).toContain('0027_task_planning');
  });

  test('ACBP-P4-003 planning columns: closed task_type set, non-negative priority rank, both INSERT-ONLY', async () => {
    const mk = (over: { type?: string | null; priority?: number | null } = {}) =>
      asApp(scope(accountA, companyA1), async (k) => {
        const r = await sql<{ id: string }>`insert into tasks (account_id, company_id, title, state, task_type, priority, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 'planned work', 'draft', ${over.type ?? null}, ${over.priority ?? null}, ${userU}::uuid) returning id`.execute(k);
        return r.rows[0]!.id;
      });

    // All seven PRD types are accepted; NULL is legal ("not stated", never guessed — TASK-002/ADR-019).
    for (const t of ['market_research', 'competitor_research', 'customer_segment_analysis', 'business_model_comparison', 'business_plan_generation', 'landing_page_copy', 'internal_product_requirements']) {
      expect(await mk({ type: t })).toBeTruthy();
    }
    expect(await mk({ type: null })).toBeTruthy();
    // An unknown type is refused — the set is closed deliberately (CDR-040 §8-G2). Pinned to the CONSTRAINT NAME: a
    // bare `.rejects.toThrow()` would also be satisfied by an RLS denial or a NOT NULL violation, so it would keep
    // passing even if the CHECK were dropped.
    await expect(mk({ type: 'vibes_research' })).rejects.toThrow(/tasks_task_type_valid/);

    // priority is a RANK: any non-negative integer, or null. Negative is refused; there is no upper bound to invent.
    const ranked = await mk({ priority: 0 });
    expect(ranked).toBeTruthy();
    expect(await mk({ priority: 999 })).toBeTruthy();
    await expect(mk({ priority: -1 })).rejects.toThrow(/tasks_priority_nonneg/);

    // INSERT-ONLY: the app role may still flip `state`, but neither planning column (CDR-040 §8-G9 — widening the
    // pinned (state, updated_at) grant to make J-10's "adjust priorities" reachable is deliberately out of scope).
    // Pinned to the PRIVILEGE error: the point is that the column grant refuses these, not merely that something did.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update tasks set priority = 1 where id = ${ranked}::uuid`.execute(k))).rejects.toThrow(/permission denied/i);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update tasks set task_type = 'market_research' where id = ${ranked}::uuid`.execute(k))).rejects.toThrow(/permission denied/i);
    expect((await sql<{ priority: number | null }>`select priority from tasks where id = ${ranked}::uuid`.execute(su.kysely)).rows[0]?.priority).toBe(0);
  });
});
