// ACBP-P4-002 / CDR-033 — real-PostgreSQL proof of tasks + task_dependencies under the RESTRICTED role. Setup/seed on
// the superuser (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner). Proves: dual-keyed
// company-scoped SELECT/INSERT (both account AND company; fail closed without the company key; cross-company read
// impossible; cross-tenant insert refused); MUTABLE state (column-scoped UPDATE of state; UPDATE of an immutable column
// refused; no DELETE); task_dependencies append-only (no UPDATE/DELETE) + UNIQUE edge + no-self-dep CHECK; the state +
// title CHECKs; FK cascade (company→all, task→deps); clean down/up/reapply BY NAME; catalog invariants (FORCE RLS,
// grants, exactly 3 SECURITY DEFINER, acbp_app NOBYPASSRLS/non-owner, 0021 applied). Skips when ACBP_TEST_DATABASE_URL
// is unset.
import { randomUUID } from 'node:crypto';
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, TaskRepository, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `task_${'test'}_pw_1970`;

const ALL = ['planning_run_inputs', 'planning_runs', 'task_review_flags', 'job_checkpoints', 'jobs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

/**
 * The SQLSTATE of a rejected operation, or 'no-error' if it unexpectedly succeeded.
 *
 * Asserting the SQLSTATE rather than a constraint name is not a weaker test, it is the only honest one here:
 * `toDatabaseError` sanitizes every database error down to a category, a note and the SQLSTATE, deliberately free of
 * SQL text and identifiers, so no constraint name ever reaches a caller — and that sanitization is a security property
 * this test must not ask anyone to relax. Pinning the EXACT code is what stops one failure mode masquerading as
 * another (a bare `.rejects.toThrow()` is satisfied by any of them).
 *
 * The chain is walked rather than reading `.code` directly: `asApp` errors arrive already normalized, and a
 * PlatformError's own `code` is the PLATFORM code ('VALIDATION_FAILED'), with the driver's SQLSTATE preserved only on
 * `cause`. Taking the first `code` would therefore silently assert the wrong field.
 */
const isSqlState = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v);
const sqlStateOf = (p: Promise<unknown>): Promise<string> =>
  p.then(() => 'no-error').catch((e: unknown) => {
    for (let cur: unknown = e, hops = 0; cur !== null && cur !== undefined && hops < 5; hops += 1) {
      const node = cur as { code?: unknown; cause?: unknown };
      if (isSqlState(node.code)) return node.code;
      cur = node.cause;
    }
    // Last resort: the sanitized message embeds `sqlstate=NNNNN`.
    return /sqlstate=([0-9A-Z]{5})/.exec(String(e))?.[1] ?? 'unknown';
  });

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
    await sql`delete from task_deletions`.execute(su.kysely);
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
    // An unknown type is refused by the CHECK — 23514, not merely "something threw" (the set is closed deliberately,
    // CDR-040 §8-G2).
    expect(await sqlStateOf(mk({ type: 'vibes_research' }))).toBe('23514');

    // priority is a RANK: any non-negative integer, or null. Negative is refused; there is no upper bound to invent.
    const ranked = await mk({ priority: 0 });
    expect(ranked).toBeTruthy();
    expect(await mk({ priority: 999 })).toBeTruthy();
    expect(await sqlStateOf(mk({ priority: -1 }))).toBe('23514');

    // INSERT-ONLY: the app role may still flip `state`, but neither planning column (CDR-040 §8-G9 — widening the
    // pinned (state, updated_at) grant to make J-10's "adjust priorities" reachable is deliberately out of scope).
    // 42501 exactly: the COLUMN GRANT must be what refuses these. A 23514 here would mean the write was allowed and
    // only the value rejected, and a 22P02 would mean the value never type-checked — either would pass a bare
    // `.rejects` while the grant was quietly wide open.
    for (const set of [sql`priority = 1`, sql`task_type = 'market_research'`]) {
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update tasks set ${set} where id = ${ranked}::uuid`.execute(k)))).toBe('42501');
    }
    expect((await sql<{ priority: number | null }>`select priority from tasks where id = ${ranked}::uuid`.execute(su.kysely)).rows[0]?.priority).toBe(0);
  });

  // ── ACBP-P4-005 / CDR-043 — task_deletions + repeated_from_task_id ────────────────────────────────────────────
  //
  // The whole shape of this migration exists to avoid one thing: granting DELETE on `tasks`, or widening its pinned
  // (state, updated_at) column UPDATE. TASK-008 wants deletion AUDITED, and both of those would destroy the record
  // they are meant to produce. So deletion is an append-only FACT in a separate table, and the tests below are as
  // much about what did NOT change as about what did.

  const insertDeletion = (a: string, c: string, taskId: string, over: { state?: string; reason?: string | null } = {}) =>
    asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into task_deletions (account_id, company_id, task_id, state_at_delete, reason, deleted_by_user_id) values (${a}::uuid, ${c}::uuid, ${taskId}::uuid, ${over.state ?? 'planned'}, ${over.reason ?? null}, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });

  test('task_deletions: dual-keyed SELECT/INSERT; cross-company read impossible; fail closed without the company key', async () => {
    const t = await insertTask(accountA, companyA1);
    await insertDeletion(accountA, companyA1, t);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('task_deletions').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('task_deletions').selectAll().execute())).toHaveLength(0);
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('task_deletions').selectAll().execute())).toHaveLength(0);
  });

  test('task_deletions is IMMUTABLE: no UPDATE, no DELETE — the record of what was discarded cannot be rewritten', async () => {
    const t = await insertTask(accountA, companyA1);
    const d = await insertDeletion(accountA, companyA1, t, { reason: 'not needed' });
    // 42501 exactly: the GRANT must be what refuses these. A bare `.rejects` would also be satisfied by an RLS miss
    // or a type error, either of which would leave the table quietly mutable.
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update task_deletions set reason = 'rewritten' where id = ${d}::uuid`.execute(k)))).toBe('42501');
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update task_deletions set state_at_delete = 'completed' where id = ${d}::uuid`.execute(k)))).toBe('42501');
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`delete from task_deletions where id = ${d}::uuid`.execute(k)))).toBe('42501');
    expect((await sql<{ reason: string | null }>`select reason from task_deletions where id = ${d}::uuid`.execute(su.kysely)).rows[0]?.reason).toBe('not needed');
  });

  test('a task is deleted ONCE: the second deletion is the same fact, not a second one (UNIQUE task_id)', async () => {
    const t = await insertTask(accountA, companyA1);
    await insertDeletion(accountA, companyA1, t);
    // 23505 exactly. This is what lets the use case be idempotent at the database via ON CONFLICT DO NOTHING rather
    // than by a check-then-insert, which would race two concurrent deletes into two rows.
    expect(await sqlStateOf(insertDeletion(accountA, companyA1, t))).toBe('23505');
    expect((await sql<{ n: number }>`select count(*)::int as n from task_deletions where task_id = ${t}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(1);
  });

  test('the task FK is TENANT-PINNED: company B cannot record a deletion naming company A’s task', async () => {
    // RI checks ALWAYS bypass row security, so a single-column task_id → tasks(id) FK would accept a foreign task id
    // here: an existence oracle for another tenant's ids, and a write that turns up in A's history. The composite
    // (task_id, company_id) → tasks(id, company_id) is what closes it, and 23503 proves the FK — not RLS — refused.
    const aTask = await insertTask(accountA, companyA1);
    expect(await sqlStateOf(insertDeletion(accountB, companyB1, aTask))).toBe('23503');
  });

  test('CHECKs: state_at_delete is the closed 11-state set; reason is bounded and may be absent', async () => {
    const t = await insertTask(accountA, companyA1);
    for (const s of ['draft', 'planned', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused', 'completed', 'failed', 'cancelled']) {
      const fresh = await insertTask(accountA, companyA1);
      expect(await insertDeletion(accountA, companyA1, fresh, { state: s })).toBeTruthy();
    }
    expect(await sqlStateOf(insertDeletion(accountA, companyA1, t, { state: 'deleted' }))).toBe('23514');
    // An absent reason is legal — TASK-008 does not require one — but an empty string is not: it reads as "a reason
    // was given" while carrying nothing, which is the dishonest middle state.
    expect(await insertDeletion(accountA, companyA1, await insertTask(accountA, companyA1), { reason: null })).toBeTruthy();
    expect(await sqlStateOf(insertDeletion(accountA, companyA1, await insertTask(accountA, companyA1), { reason: '' }))).toBe('23514');
    expect(await sqlStateOf(insertDeletion(accountA, companyA1, await insertTask(accountA, companyA1), { reason: 'x'.repeat(2001) }))).toBe('23514');
  });

  test('repeated_from_task_id: INSERT-ONLY lineage, never self, never another company’s task', async () => {
    const source = await insertTask(accountA, companyA1, { state: 'failed' });
    const repeat = await asApp(scope(accountA, companyA1), async (k) => {
      const r = await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, repeated_from_task_id, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 'draft', 'Ship the thing (again)', ${source}::uuid, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
    expect((await sql<{ src: string | null }>`select repeated_from_task_id as src from tasks where id = ${repeat}::uuid`.execute(su.kysely)).rows[0]?.src).toBe(source);

    // INSERT-ONLY: the column carries no UPDATE grant, so lineage cannot be rewritten after the fact (42501, not a
    // CHECK — the grant has to be what refuses it, or the column is writable and only some values are rejected).
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update tasks set repeated_from_task_id = null where id = ${repeat}::uuid`.execute(k)))).toBe('42501');

    // A task can never be its own source — a lineage cycle of length one. Supplying the id explicitly is what makes
    // this reachable at all: with the default the row cannot name itself, so the CHECK would never be exercised.
    const selfId = randomUUID();
    expect(
      await sqlStateOf(
        asApp(scope(accountA, companyA1), (k) => sql`insert into tasks (id, account_id, company_id, state, title, repeated_from_task_id, created_by_user_id) values (${selfId}::uuid, ${accountA}::uuid, ${companyA1}::uuid, 'draft', 'self', ${selfId}::uuid, ${userU}::uuid)`.execute(k)),
      ),
    ).toBe('23514');

    // Tenant-pinned, same reasoning as the deletion FK: B may not name A's task as a source.
    expect(
      await sqlStateOf(
        asApp(scope(accountB, companyB1), (k) => sql`insert into tasks (account_id, company_id, state, title, repeated_from_task_id, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, 'draft', 'stolen lineage', ${source}::uuid, ${userU}::uuid)`.execute(k)),
      ),
    ).toBe('23503');
  });

  test('deleting the source task NULLS the lineage pointer rather than cascading the repeat away', async () => {
    // `on delete set null (repeated_from_task_id)` — losing the source must not take the repeat with it. The repeat is
    // real work the owner queued; a cascade here would delete a live task because its ancestor went away.
    const source = await insertTask(accountA, companyA1, { state: 'failed' });
    const repeat = await asApp(scope(accountA, companyA1), async (k) => {
      const r = await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, repeated_from_task_id, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 'queued', 'again', ${source}::uuid, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
    await sql`delete from tasks where id = ${source}::uuid`.execute(su.kysely);
    const row = (await sql<{ n: number; src: string | null }>`select count(*)::int as n, max(repeated_from_task_id::text) as src from tasks where id = ${repeat}::uuid`.execute(su.kysely)).rows[0];
    expect(row?.n).toBe(1);
    expect(row?.src).toBeNull();
  });

  test('deleting a task CASCADES its deletion record; deleting the company takes both', async () => {
    const co = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const t = await insertTask(accountA, co);
    await insertDeletion(accountA, co, t);
    await sql`delete from tasks where id = ${t}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from task_deletions where task_id = ${t}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
    await sql`delete from companies where id = ${co}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from task_deletions where company_id = ${co}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('the deletion insert is GUARDED by the task state — a task that moved is not deleted', async () => {
    // Second-review-pass finding on the use case: read-state → decide → write is a check-then-insert. If the task
    // leaves `queued` in that window the unguarded write still lands, deleting a RUNNING task — exactly TASK-008's
    // failure clause. The guard is a `where state = <state read>` inside the INSERT ... SELECT.
    //
    // Exercised at the repository, which is the only place the interleaving is reachable deterministically: passing a
    // `stateAtDelete` that no longer matches the row IS the race, without needing two live transactions.
    const t = await insertTask(accountA, companyA1, { state: 'queued' });
    const wrote = await asApp(scope(accountA, companyA1), (k) =>
      new TaskRepository(k).insertDeletion({ accountId: accountA, companyId: companyA1, taskId: t, stateAtDelete: 'running', reason: null, deletedByUserId: userU }),
    );
    // The row is `queued`, the guard expected `running` — nothing is written, and no error is raised either.
    expect(wrote).toBeUndefined();
    expect((await sql<{ n: number }>`select count(*)::int as n from task_deletions where task_id = ${t}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);

    // …and the matching state DOES write, so the guard is not simply refusing everything.
    const ok = await asApp(scope(accountA, companyA1), (k) =>
      new TaskRepository(k).insertDeletion({ accountId: accountA, companyId: companyA1, taskId: t, stateAtDelete: 'queued', reason: null, deletedByUserId: userU }),
    );
    expect(ok?.task_id).toBe(t);
    expect(ok?.state_at_delete).toBe('queued');
  });

  test('catalog after 0029: task_deletions FORCE RLS + SELECT/INSERT only, and `tasks` grants are UNCHANGED', async () => {
    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'task_deletions' and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = 'task_deletions' order by cmd`.execute(su.kysely);
    expect(pols.rows.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT']);
    const gr = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'task_deletions' order by privilege_type`.execute(su.kysely);
    expect(gr.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
    // No column-level UPDATE either — the immutability above must not be reachable by another door.
    const delCols = await sql<{ column_name: string }>`select column_name from information_schema.column_privileges where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'task_deletions' and privilege_type = 'UPDATE'`.execute(su.kysely);
    expect(delCols.rows).toEqual([]);

    // THE POINT OF THE WHOLE DESIGN: `tasks` still has no DELETE, and its column UPDATE is still exactly the two
    // state columns. If a future change makes deletion "simpler" by widening either, this fails.
    const taskGrants = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'tasks' order by privilege_type`.execute(su.kysely);
    expect(taskGrants.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
    const taskCols = await sql<{ column_name: string }>`select column_name from information_schema.column_privileges where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'tasks' and privilege_type = 'UPDATE' order by column_name`.execute(su.kysely);
    expect(taskCols.rows.map((c) => c.column_name)).toEqual(['state', 'updated_at']);

    expect((await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely)).rows.map((m) => m.name)).toContain('0029_task_controls');
  });

  test('0029 is reversible: down drops the table, the column and the additive UNIQUE; up reapplies clean', async () => {
    const back = await createMigrator(su).migrateTo('0028_planning_transparency');
    expect(back.error).toBeUndefined();
    const gone = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'task_deletions'`.execute(su.kysely);
    expect(gone.rows[0]?.n).toBe(0);
    const col = await sql<{ n: number }>`select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'repeated_from_task_id'`.execute(su.kysely);
    expect(col.rows[0]?.n).toBe(0);
    const uq = await sql<{ n: number }>`select count(*)::int as n from pg_constraint where conname = 'tasks_id_company_uq'`.execute(su.kysely);
    expect(uq.rows[0]?.n).toBe(0);
    const up = await migrateToLatest(su);
    expect(up.error).toBeUndefined();
    expect((await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'task_deletions'`.execute(su.kysely)).rows[0]?.n).toBe(1);
  });
});
