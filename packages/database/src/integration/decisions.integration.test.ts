// ACBP-P3-005 / CDR-038 - real-PostgreSQL proof of `decisions` under the RESTRICTED role. Setup/seed on the superuser
// (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner). Proves the STRAT-006 guarantees at
// the database: IMMUTABILITY ("mutation attempts fail" - no UPDATE, no DELETE); dual-keyed company-scoped SELECT/INSERT
// (fail-closed without the company key; cross-company read impossible; cross-tenant insert refused); the composite FK
// (the hardened selection must belong to the SAME generation); FK cascade (generation -> decisions); the optional
// bounded rationale CHECK; append-only (multiple records per generation, latest-wins on read); catalog (FORCE RLS,
// SELECT/INSERT grants, no column UPDATE, exactly 3 SECURITY DEFINER, acbp_app NOBYPASSRLS/non-owner, 0025 applied).
// Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `dec_${'test'}_pw_1970`;

const ALL = ['planning_run_inputs', 'planning_runs', 'task_review_flags', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;
const OPT_FIELDS = ['description', 'customer', 'offer', 'business_model', 'scope', 'benefits', 'risks', 'cost_range', 'effort', 'time_to_validate', 'time_to_launch', 'required_resources', 'key_assumptions', 'validation_method', 'success_metrics', 'confidence'];
function fields(): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of OPT_FIELDS) o[f] = `${f}-v`;
  return o;
}

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-dec-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-dec-test' }));
}

describe.skipIf(!hasTestDatabase)('decisions (real PostgreSQL, restricted role) - ACBP-P3-005/CDR-038', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let genA = '';
  let selA = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  async function insertDecision(a: string, c: string, gen: string, sel: string, over: { rationale?: string | null; version?: number } = {}): Promise<string> {
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, rationale, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, ${sel}::uuid, 'select', ${over.version ?? 1}, ${over.rationale === undefined ? 'cheapest path to a first customer' : over.rationale}, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }

  // Seed a generation + option + selection on the superuser (owner bypasses RLS).
  async function seedChain(a: string, c: string, version: number): Promise<{ gen: string; opt: string; sel: string }> {
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${version}, 'complete', 0.6, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${doc}::uuid, ${version}, 'complete', 3, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const opt = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, 0, ${JSON.stringify(fields())}::jsonb) returning id`.execute(su.kysely)).rows[0]!.id;
    const sel = (await sql<{ id: string }>`insert into strategy_selections (account_id, company_id, generation_id, mode, selected_option_id, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, 'select', ${opt}::uuid, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    return { gen, opt, sel };
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    expect((await migrateToLatest(su)).error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    userU = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_dec', 'user_dec_u', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    const userV = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_dec', 'user_dec_v', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const chain = await seedChain(accountA, companyA1, 1);
    genA = chain.gen;
    selA = chain.sel;

    // Prove the migration reverses and re-applies cleanly (down() drops the added unique constraint too).
    const down = await createMigrator(su).migrateTo('0024_strategy_selections');
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
    await sql`delete from decisions`.execute(su.kysely);
  });

  test('dual-keyed SELECT/INSERT: decisions visible only under their own account+company; cross-company read impossible', async () => {
    await insertDecision(accountA, companyA1, genA, selA);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('decisions').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('decisions').selectAll().execute())).toHaveLength(0);
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('decisions').selectAll().execute())).toHaveLength(0); // fail closed
  });

  test('cross-tenant INSERT is refused (WITH CHECK)', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, ${genA}::uuid, ${selA}::uuid, 'select', 1, ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('AUDIT-GRADE IMMUTABLE (STRAT-006 "mutation attempts fail"): no UPDATE, no DELETE', async () => {
    const dec = await insertDecision(accountA, companyA1, genA, selA, { rationale: 'original reasoning' });
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update decisions set rationale = 'rewritten history' where id = ${dec}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update decisions set understanding_version = 99 where id = ${dec}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from decisions where id = ${dec}::uuid`.execute(k))).rejects.toThrow();
    // The original record is intact.
    const row = (await sql<{ rationale: string | null }>`select rationale from decisions where id = ${dec}::uuid`.execute(su.kysely)).rows[0];
    expect(row?.rationale).toBe('original reasoning');
  });

  test('append-only: a second decision for the same generation is allowed (latest-wins on read)', async () => {
    await insertDecision(accountA, companyA1, genA, selA, { rationale: 'first' });
    await insertDecision(accountA, companyA1, genA, selA, { rationale: 'second' });
    expect((await sql<{ n: number }>`select count(*)::int as n from decisions where generation_id = ${genA}::uuid`.execute(su.kysely)).rows[0]!.n).toBe(2);
  });

  test('the rationale is OPTIONAL but bounded when present (CDR-038 G2)', async () => {
    // A decision with NO rationale is legal — a missing rationale must never make a decision silently unrecorded.
    const dec = await insertDecision(accountA, companyA1, genA, selA, { rationale: null });
    expect((await sql<{ rationale: string | null }>`select rationale from decisions where id = ${dec}::uuid`.execute(su.kysely)).rows[0]?.rationale).toBeNull();
    // Blank / over-long are refused.
    await expect(insertDecision(accountA, companyA1, genA, selA, { rationale: '' })).rejects.toThrow();
    await expect(insertDecision(accountA, companyA1, genA, selA, { rationale: 'x'.repeat(4001) })).rejects.toThrow();
  });

  test('understanding_version must be a real version (>= 1)', async () => {
    await expect(insertDecision(accountA, companyA1, genA, selA, { version: 0 })).rejects.toThrow();
  });

  test('composite FK: a decision cannot reference a selection from a DIFFERENT generation', async () => {
    const other = await seedChain(accountA, companyA1, 2); // a second generation (same company) with its own selection
    // genA + other.sel (that selection belongs to the other generation) — the composite FK refuses it.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${genA}::uuid, ${other.sel}::uuid, 'select', 1, ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('the mode snapshot is a closed set (the P4-001 planning gate keys off a NON-reject decision)', async () => {
    // All four selection modes are legal on a decision (STRAT-006 covers selection/edit/rejection).
    for (const mode of ['select', 'edit', 'combine', 'reject']) {
      await asApp(scope(accountA, companyA1), (k) => sql`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${genA}::uuid, ${selA}::uuid, ${mode}, 1, ${userU}::uuid)`.execute(k));
    }
    expect((await sql<{ n: number }>`select count(*)::int as n from decisions where generation_id = ${genA}::uuid`.execute(su.kysely)).rows[0]!.n).toBe(4);
    // An unknown mode is refused — a consumer can trust `mode <> 'reject'` as the positive-decision test.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${genA}::uuid, ${selA}::uuid, 'approve', 1, ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('FK cascade: deleting the generation removes its decisions', async () => {
    const co = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const chain = await seedChain(accountA, co, 1);
    await insertDecision(accountA, co, chain.gen, chain.sel);
    await sql`delete from strategy_generations where id = ${chain.gen}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from decisions where generation_id = ${chain.gen}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; policies select+insert; grants SELECT/INSERT only; no column UPDATE; 3 SECURITY DEFINER; acbp_app trust attrs; 0025 applied', async () => {
    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'decisions' and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = 'decisions' order by cmd`.execute(su.kysely);
    expect(pols.rows.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT']);
    const gr = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'decisions' order by privilege_type`.execute(su.kysely);
    expect(gr.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
    const cols = await sql<{ n: number }>`select count(*)::int as n from information_schema.column_privileges where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'decisions' and privilege_type = 'UPDATE'`.execute(su.kysely);
    expect(cols.rows[0]?.n).toBe(0);
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0025_decisions');
  });
});
