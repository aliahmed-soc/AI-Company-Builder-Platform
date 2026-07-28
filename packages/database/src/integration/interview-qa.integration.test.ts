// ACBP-P2-002 / CDR-023 — real-PostgreSQL proof of interview_questions + interview_answers under the RESTRICTED
// role. Setup/seed runs on the superuser (owner) connection; every assertion runs as `acbp_app` (NOSUPERUSER,
// NOBYPASSRLS, non-owner). Proves: dual-keyed company-scoped SELECT/INSERT (both account AND company must match
// — fail closed without the company key; cross-tenant insert refused); APPEND-ONLY / IMMUTABLE (no UPDATE, no
// DELETE grant on either table); the (question_id, revision) PK serializes revisions; the status/content CHECK
// (answered needs content, skipped forbids it); unique (session_id, position); FK cascade; clean down/up/reapply
// BY NAME; catalog invariants (FORCE RLS, select+insert policies, least-privilege grants, 3 SECURITY DEFINER,
// acbp_app NOBYPASSRLS/non-owner, migrations 0001–0013). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `qa_${'test'}_pw_1970`;

const ALL = ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'artifacts', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-qa-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-qa-test' }));
}

describe.skipIf(!hasTestDatabase)('interview Q&A persistence (real PostgreSQL, restricted role) — ACBP-P2-002/CDR-023', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let sessionA = '';
  let sessionB = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  /** Insert a question as the app role under company scope; returns its id. */
  async function insertQuestion(a: string, c: string, s: string, position: number): Promise<string> {
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into interview_questions (session_id, account_id, company_id, position, prompt) values (${s}::uuid, ${a}::uuid, ${c}::uuid, ${position}, ${'Q' + String(position)}) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }
  async function insertAnswer(a: string, c: string, s: string, q: string, revision: number, status: string, content: string | null): Promise<void> {
    await asApp(scope(a, c), (k) => sql`insert into interview_answers (question_id, revision, session_id, account_id, company_id, status, content, created_by_user_id) values (${q}::uuid, ${revision}, ${s}::uuid, ${a}::uuid, ${c}::uuid, ${status}, ${content}, ${userU}::uuid)`.execute(k));
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

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_qa', 'user_qa_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_qa', 'user_qa_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    sessionA = (await sql<{ id: string }>`insert into interview_sessions (account_id, company_id, state, started_at) values (${accountA}::uuid, ${companyA1}::uuid, 'in_progress', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    sessionB = (await sql<{ id: string }>`insert into interview_sessions (account_id, company_id, state, started_at) values (${accountB}::uuid, ${companyB1}::uuid, 'in_progress', now()) returning id`.execute(su.kysely)).rows[0]!.id;

    // down/up/reapply BY NAME: 0013 drops and re-applies cleanly on top of the seeded FK data.
    const down = await createMigrator(su).migrateTo('0012_interview_sessions');
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
    await sql`delete from interview_answers`.execute(su.kysely);
    await sql`delete from interview_questions`.execute(su.kysely);
  });

  test('dual-keyed SELECT/INSERT: questions + answers visible only under their own account+company scope', async () => {
    const q = await insertQuestion(accountA, companyA1, sessionA, 1);
    await insertAnswer(accountA, companyA1, sessionA, q, 1, 'answered', 'hello');
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('interview_questions').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('interview_answers').selectAll().execute())).toHaveLength(1);
    // Foreign tenant sees nothing.
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('interview_questions').selectAll().execute())).toHaveLength(0);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('interview_answers').selectAll().execute())).toHaveLength(0);
  });

  test('fail closed WITHOUT the company key; cross-tenant INSERT refused', async () => {
    const q = await insertQuestion(accountA, companyA1, sessionA, 1);
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('interview_questions').selectAll().execute())).toHaveLength(0);
    await expect(asApp({ 'app.current_account': accountA }, (k) => sql`insert into interview_questions (session_id, account_id, company_id, position, prompt) values (${sessionA}::uuid, ${accountA}::uuid, ${companyA1}::uuid, 2, 'x')`.execute(k))).rejects.toThrow();
    // Under A's scope, writing a row stamped for B is refused by WITH CHECK (author supplied so the RLS policy,
    // not the NOT NULL author column, is what rejects it).
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into interview_answers (question_id, revision, session_id, account_id, company_id, status, content, created_by_user_id) values (${q}::uuid, 1, ${sessionB}::uuid, ${accountB}::uuid, ${companyB1}::uuid, 'answered', 'x', ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('APPEND-ONLY / IMMUTABLE: no UPDATE or DELETE on questions or answers (regardless of scope)', async () => {
    const q = await insertQuestion(accountA, companyA1, sessionA, 1);
    await insertAnswer(accountA, companyA1, sessionA, q, 1, 'answered', 'hello');
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update interview_questions set prompt = 'edited' where id = ${q}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update interview_answers set content = 'edited' where question_id = ${q}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from interview_answers where question_id = ${q}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from interview_questions where id = ${q}::uuid`.execute(k))).rejects.toThrow();
  });

  test('the (question_id, revision) PK serializes revisions; a revision is a NEW row (history retained)', async () => {
    const q = await insertQuestion(accountA, companyA1, sessionA, 1);
    await insertAnswer(accountA, companyA1, sessionA, q, 1, 'answered', 'first');
    await insertAnswer(accountA, companyA1, sessionA, q, 2, 'answered', 'second');
    // A duplicate (question_id, revision) collides.
    await expect(insertAnswer(accountA, companyA1, sessionA, q, 2, 'answered', 'dup')).rejects.toThrow();
    const rows = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('interview_answers').select(['revision', 'content']).where('question_id', '=', q).orderBy('revision', 'asc').execute());
    expect(rows).toEqual([
      { revision: 1, content: 'first' },
      { revision: 2, content: 'second' },
    ]);
  });

  test('status/content CHECK: answered needs content; skipped forbids it', async () => {
    const q = await insertQuestion(accountA, companyA1, sessionA, 1);
    await expect(insertAnswer(accountA, companyA1, sessionA, q, 1, 'answered', null)).rejects.toThrow();
    await expect(insertAnswer(accountA, companyA1, sessionA, q, 1, 'skipped', 'nope')).rejects.toThrow();
    await expect(insertAnswer(accountA, companyA1, sessionA, q, 1, 'bogus', 'x')).rejects.toThrow();
    // The author is REQUIRED (created_by_user_id NOT NULL — accountability is structural).
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into interview_answers (question_id, revision, session_id, account_id, company_id, status, content) values (${q}::uuid, 5, ${sessionA}::uuid, ${accountA}::uuid, ${companyA1}::uuid, 'answered', 'x')`.execute(k))).rejects.toThrow();
    // The valid shapes are accepted.
    await insertAnswer(accountA, companyA1, sessionA, q, 1, 'skipped', null);
    const q2 = await insertQuestion(accountA, companyA1, sessionA, 2);
    await insertAnswer(accountA, companyA1, sessionA, q2, 1, 'answered', 'ok');
  });

  test('unique (session_id, position): two questions cannot share a slot', async () => {
    await insertQuestion(accountA, companyA1, sessionA, 1);
    await expect(insertQuestion(accountA, companyA1, sessionA, 1)).rejects.toThrow();
    await insertQuestion(accountA, companyA1, sessionA, 2); // a different slot is fine
  });

  test('FK cascade: deleting the session removes its questions and answers', async () => {
    const throwSession = (await sql<{ id: string }>`insert into interview_sessions (account_id, company_id, state, started_at) values (${accountA}::uuid, ${companyA1}::uuid, 'superseded', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    const q = await insertQuestion(accountA, companyA1, throwSession, 1);
    await insertAnswer(accountA, companyA1, throwSession, q, 1, 'answered', 'x');
    await sql`delete from interview_sessions where id = ${throwSession}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from interview_answers where session_id = ${throwSession}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
    expect((await sql<{ n: number }>`select count(*)::int as n from interview_questions where session_id = ${throwSession}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; select+insert policies only; SELECT+INSERT grants only (no UPDATE/DELETE); 3 SECURITY DEFINER; acbp_app NOBYPASSRLS/non-owner; migrations 0001–0013', async () => {
    for (const t of ['interview_questions', 'interview_answers'] as const) {
      const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${t} and relkind = 'r'`.execute(su.kysely);
      expect(rls.rows[0], t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = ${t} order by cmd`.execute(su.kysely);
      expect(pols.rows.map((p) => p.cmd), t).toEqual(['INSERT', 'SELECT']);
      const grants = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${t} order by privilege_type`.execute(su.kysely);
      expect(grants.rows.map((g) => g.privilege_type), t).toEqual(['INSERT', 'SELECT']);
      const others = await sql<{ grantee: string }>`select distinct grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = ${t} and grantee not in ('acbp_app', (select tableowner from pg_tables where schemaname='public' and tablename=${t}))`.execute(su.kysely);
      expect(others.rows, t).toEqual([]);
    }
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    // This migration is applied (not that it is the LAST or ONLY one — later tickets add migrations on top).
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0013_interview_qa');
    expect(migs.rows.length).toBeGreaterThanOrEqual(13);
  });
});
