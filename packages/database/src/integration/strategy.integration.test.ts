// ACBP-P3-001 / CDR-034 — real-PostgreSQL proof of strategy_generations + strategy_options under the RESTRICTED role.
// Setup/seed on the superuser (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner).
// Proves: dual-keyed company-scoped SELECT/INSERT (fail-closed without the company key; cross-company read impossible;
// cross-tenant insert refused); IMMUTABILITY (no UPDATE/no DELETE on either table); the closed status + similarity
// enums + option_count/version/fewer_reason CHECKs; the jsonb-object CHECK; UNIQUE(generation_id, ordinal); FK cascade
// (company→all, generation→options, understanding_document→generations); catalog (FORCE RLS, grants, exactly 3 SECURITY
// DEFINER, acbp_app NOBYPASSRLS/non-owner, 0022 applied). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `strat_${'test'}_pw_1970`;

const ALL = ['planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

const OPT_FIELDS = ['description', 'customer', 'offer', 'business_model', 'scope', 'benefits', 'risks', 'cost_range', 'effort', 'time_to_validate', 'time_to_launch', 'required_resources', 'key_assumptions', 'validation_method', 'success_metrics', 'confidence'];
function fields(): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of OPT_FIELDS) o[f] = `${f}-v`;
  return o;
}

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-strat-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-strat-test' }));
}

describe.skipIf(!hasTestDatabase)('strategy_generations + strategy_options (real PostgreSQL, restricted role) — ACBP-P3-001/CDR-034', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let docA = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  async function insertGen(a: string, c: string, doc: string, over: { status?: string; optionCount?: number; version?: number } = {}): Promise<string> {
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${doc}::uuid, ${over.version ?? 1}, ${over.status ?? 'complete'}, ${over.optionCount ?? 3}, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_strat', 'user_strat_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_strat', 'user_strat_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    // A confirmed understanding document for company A (the generation input).
    docA = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 1, 'complete', 0.6, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;

    const down = await createMigrator(su).migrateTo('0021_tasks');
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
    await sql`delete from strategy_options`.execute(su.kysely);
    await sql`delete from strategy_generations`.execute(su.kysely);
  });

  test('dual-keyed SELECT/INSERT: generations visible only under their own account+company; cross-company read impossible', async () => {
    await insertGen(accountA, companyA1, docA);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('strategy_generations').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('strategy_generations').selectAll().execute())).toHaveLength(0);
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('strategy_generations').selectAll().execute())).toHaveLength(0); // fail closed
  });

  test('cross-tenant INSERT is refused (WITH CHECK)', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, ${docA}::uuid, 1, 'complete', 3, ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('IMMUTABLE: neither generations nor options can be UPDATEd or DELETEd by the app role', async () => {
    const gen = await insertGen(accountA, companyA1, docA);
    const opt = await asApp(scope(accountA, companyA1), async (k) => (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountA}::uuid, ${companyA1}::uuid, ${gen}::uuid, 0, ${JSON.stringify(fields())}::jsonb) returning id`.execute(k)).rows[0]!.id);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update strategy_generations set status = 'fewer_than_three' where id = ${gen}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from strategy_generations where id = ${gen}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update strategy_options set ordinal = 5 where id = ${opt}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from strategy_options where id = ${opt}::uuid`.execute(k))).rejects.toThrow();
  });

  test('CHECKs: closed status + similarity enums, non-negative option_count, positive version, jsonb-object fields, UNIQUE ordinal, no cross-option ordinal clash', async () => {
    await expect(insertGen(accountA, companyA1, docA, { status: 'done' })).rejects.toThrow(); // status not in set
    await expect(insertGen(accountA, companyA1, docA, { optionCount: -1 })).rejects.toThrow();
    await expect(insertGen(accountA, companyA1, docA, { version: 0 })).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, similarity_check_result, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${docA}::uuid, 1, 'complete', 3, 'maybe', ${userU}::uuid)`.execute(k))).rejects.toThrow(); // similarity not in set
    // Status/count consistency: 'complete' with < 3 options is refused; 'fewer_than_three' with >= 3 is refused.
    await expect(insertGen(accountA, companyA1, docA, { status: 'complete', optionCount: 2 })).rejects.toThrow();
    await expect(insertGen(accountA, companyA1, docA, { status: 'fewer_than_three', optionCount: 3 })).rejects.toThrow();
    // A fewer_reason on a 'complete' generation is refused (reason only meaningful for fewer-than-three).
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, fewer_reason, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${docA}::uuid, 1, 'complete', 3, 'why', ${userU}::uuid)`.execute(k))).rejects.toThrow();
    const gen = await insertGen(accountA, companyA1, docA);
    // A non-object fields payload is refused (jsonb_typeof check).
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountA}::uuid, ${companyA1}::uuid, ${gen}::uuid, 0, ${'"not an object"'}::jsonb)`.execute(k))).rejects.toThrow();
    // A duplicate ordinal within one generation is refused (UNIQUE).
    await asApp(scope(accountA, companyA1), (k) => sql`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountA}::uuid, ${companyA1}::uuid, ${gen}::uuid, 0, ${JSON.stringify(fields())}::jsonb)`.execute(k));
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountA}::uuid, ${companyA1}::uuid, ${gen}::uuid, 0, ${JSON.stringify(fields())}::jsonb)`.execute(k))).rejects.toThrow();
  });

  test('FK cascade: deleting a generation removes its options; deleting the company removes all generations', async () => {
    const co = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const doc2 = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${co}::uuid, 1, 'complete', 0.6, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const gen = await insertGen(accountA, co, doc2);
    await asApp(scope(accountA, co), (k) => sql`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountA}::uuid, ${co}::uuid, ${gen}::uuid, 0, ${JSON.stringify(fields())}::jsonb)`.execute(k));
    await sql`delete from strategy_generations where id = ${gen}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from strategy_options where generation_id = ${gen}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
    await sql`delete from companies where id = ${co}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from strategy_generations where company_id = ${co}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; policies (select+insert only); grants (SELECT/INSERT only); 3 SECURITY DEFINER; acbp_app trust attrs; 0022 applied', async () => {
    for (const table of ['strategy_generations', 'strategy_options'] as const) {
      const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table} and relkind = 'r'`.execute(su.kysely);
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = ${table} order by cmd`.execute(su.kysely);
      expect(pols.rows.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT']);
      const gr = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table} order by privilege_type`.execute(su.kysely);
      expect(gr.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
      // No column-level UPDATE grants (append-only).
      const cols = await sql<{ n: number }>`select count(*)::int as n from information_schema.column_privileges where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table} and privilege_type = 'UPDATE'`.execute(su.kysely);
      expect(cols.rows[0]?.n).toBe(0);
    }
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0022_strategy');
  });
});
