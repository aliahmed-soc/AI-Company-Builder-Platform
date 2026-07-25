// ACBP-P3-003 / CDR-036 — real-PostgreSQL proof of strategy_recommendations under the RESTRICTED role. Setup/seed on
// the superuser (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner). Proves: dual-keyed
// company-scoped SELECT/INSERT (fail-closed without the company key; cross-company read impossible; cross-tenant insert
// refused); IMMUTABILITY (no UPDATE/no DELETE); rationale/sensitivities length CHECKs; FK cascade (generation→
// recommendations, option→recommendations); append-only (multiple rows per generation); catalog (FORCE RLS, SELECT/
// INSERT grants, no column UPDATE, exactly 3 SECURITY DEFINER, acbp_app NOBYPASSRLS/non-owner, 0023 applied). Skips when
// ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `rec_${'test'}_pw_1970`;

const ALL = ['decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;
const OPT_FIELDS = ['description', 'customer', 'offer', 'business_model', 'scope', 'benefits', 'risks', 'cost_range', 'effort', 'time_to_validate', 'time_to_launch', 'required_resources', 'key_assumptions', 'validation_method', 'success_metrics', 'confidence'];
function fields(): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of OPT_FIELDS) o[f] = `${f}-v`;
  return o;
}

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-rec-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-rec-test' }));
}

describe.skipIf(!hasTestDatabase)('strategy_recommendations (real PostgreSQL, restricted role) — ACBP-P3-003/CDR-036', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let genA = '';
  let optA = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  async function insertRec(a: string, c: string, gen: string, opt: string, over: { rationale?: string; sensitivities?: string } = {}): Promise<string> {
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into strategy_recommendations (account_id, company_id, generation_id, recommended_option_id, rationale, sensitivities, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${gen}::uuid, ${opt}::uuid, ${over.rationale ?? 'Best fit'}, ${over.sensitivities ?? 'Changes if budget wrong'}, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    expect((await migrateToLatest(su)).error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    userU = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_rec', 'user_rec_u', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    const userV = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_rec', 'user_rec_v', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 1, 'complete', 0.6, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    genA = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${doc}::uuid, 1, 'complete', 3, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    optA = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountA}::uuid, ${companyA1}::uuid, ${genA}::uuid, 0, ${JSON.stringify(fields())}::jsonb) returning id`.execute(su.kysely)).rows[0]!.id;

    const down = await createMigrator(su).migrateTo('0022_strategy');
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
    await sql`delete from strategy_recommendations`.execute(su.kysely);
  });

  test('dual-keyed SELECT/INSERT: recommendations visible only under their own account+company; cross-company read impossible', async () => {
    await insertRec(accountA, companyA1, genA, optA);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('strategy_recommendations').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('strategy_recommendations').selectAll().execute())).toHaveLength(0);
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('strategy_recommendations').selectAll().execute())).toHaveLength(0); // fail closed
  });

  test('cross-tenant INSERT is refused (WITH CHECK)', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into strategy_recommendations (account_id, company_id, generation_id, recommended_option_id, rationale, sensitivities, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, ${genA}::uuid, ${optA}::uuid, 'x', 'y', ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('IMMUTABLE + append-only: no UPDATE, no DELETE; multiple recommendations per generation are allowed (latest-wins on read)', async () => {
    const rec1 = await insertRec(accountA, companyA1, genA, optA, { rationale: 'first' });
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update strategy_recommendations set rationale = 'hacked' where id = ${rec1}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from strategy_recommendations where id = ${rec1}::uuid`.execute(k))).rejects.toThrow();
    // Append-only: a second recommendation for the same generation is allowed (no UNIQUE(generation_id)).
    await insertRec(accountA, companyA1, genA, optA, { rationale: 'second' });
    expect((await sql<{ n: number }>`select count(*)::int as n from strategy_recommendations where generation_id = ${genA}::uuid`.execute(su.kysely)).rows[0]!.n).toBe(2);
  });

  test('CHECKs: blank/over-long rationale or sensitivities are refused', async () => {
    await expect(insertRec(accountA, companyA1, genA, optA, { rationale: '' })).rejects.toThrow();
    await expect(insertRec(accountA, companyA1, genA, optA, { sensitivities: '' })).rejects.toThrow();
    await expect(insertRec(accountA, companyA1, genA, optA, { rationale: 'x'.repeat(4001) })).rejects.toThrow();
  });

  test('composite FK: a recommendation cannot reference an option from a DIFFERENT generation', async () => {
    // A second generation (same company) with its own option.
    const doc2 = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 2, 'complete', 0.6, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const gen2 = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${doc2}::uuid, 2, 'complete', 3, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const opt2 = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountA}::uuid, ${companyA1}::uuid, ${gen2}::uuid, 0, ${JSON.stringify(fields())}::jsonb) returning id`.execute(su.kysely)).rows[0]!.id;
    // genA + opt2 (opt2 belongs to gen2) — the composite (recommended_option_id, generation_id) FK refuses it.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into strategy_recommendations (account_id, company_id, generation_id, recommended_option_id, rationale, sensitivities, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${genA}::uuid, ${opt2}::uuid, 'x', 'y', ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('FK cascade: deleting the generation removes its recommendations', async () => {
    const co = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const doc2 = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${co}::uuid, 1, 'complete', 0.6, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const gen2 = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${accountA}::uuid, ${co}::uuid, ${doc2}::uuid, 1, 'complete', 3, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const opt2 = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountA}::uuid, ${co}::uuid, ${gen2}::uuid, 0, ${JSON.stringify(fields())}::jsonb) returning id`.execute(su.kysely)).rows[0]!.id;
    await insertRec(accountA, co, gen2, opt2);
    await sql`delete from strategy_generations where id = ${gen2}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from strategy_recommendations where generation_id = ${gen2}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; policies select+insert; grants SELECT/INSERT only; no column UPDATE; 3 SECURITY DEFINER; acbp_app trust attrs; 0023 applied', async () => {
    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'strategy_recommendations' and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = 'strategy_recommendations' order by cmd`.execute(su.kysely);
    expect(pols.rows.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT']);
    const gr = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'strategy_recommendations' order by privilege_type`.execute(su.kysely);
    expect(gr.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
    const cols = await sql<{ n: number }>`select count(*)::int as n from information_schema.column_privileges where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'strategy_recommendations' and privilege_type = 'UPDATE'`.execute(su.kysely);
    expect(cols.rows[0]?.n).toBe(0);
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0023_strategy_recommendations');
  });
});
