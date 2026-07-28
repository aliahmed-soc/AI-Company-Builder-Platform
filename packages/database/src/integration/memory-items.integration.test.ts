// ACBP-P2-006 / CDR-024 — real-PostgreSQL proof of `memory_items` under the RESTRICTED role. Setup/seed runs on
// the superuser (owner) connection; every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner).
// Proves: dual-keyed company-scoped SELECT/INSERT (both account AND company; fail closed without the company
// key; cross-company read impossible — MEM-003); append-only (no UPDATE/DELETE grant); the closed 8-type +
// 6-source CHECKs; the TYPE-BY-SOURCE-PATH CHECK (a generated source can never carry a user_fact); source_ref
// NOT NULL + confidence range + confirmation-state CHECK; FK cascade; clean down/up/reapply BY NAME; catalog
// invariants (FORCE RLS, select+insert policies, least-privilege grants, 3 SECURITY DEFINER, acbp_app
// NOBYPASSRLS/non-owner, 0014 applied). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `mem_${'test'}_pw_1970`;

const ALL = ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'artifacts', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-mem-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-mem-test' }));
}

describe.skipIf(!hasTestDatabase)('memory_items (real PostgreSQL, restricted role) — ACBP-P2-006/CDR-024', () => {
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

  async function insertItem(a: string, c: string, type: string, sourceType: string, content = 'x', sourceRef = 'q1:1'): Promise<string> {
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into memory_items (account_id, company_id, type, content, source_type, source_ref, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${type}, ${content}, ${sourceType}, ${sourceRef}, ${userU}::uuid) returning id`.execute(k);
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

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_mem', 'user_mem_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_mem', 'user_mem_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;

    const down = await createMigrator(su).migrateTo('0013_interview_qa');
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
    await sql`delete from memory_items`.execute(su.kysely);
  });

  test('dual-keyed SELECT/INSERT: items visible only under their own account+company; cross-company read impossible', async () => {
    await insertItem(accountA, companyA1, 'user_fact', 'interview_answer');
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('memory_items').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('memory_items').selectAll().execute())).toHaveLength(0);
    // Fail closed without the company key.
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('memory_items').selectAll().execute())).toHaveLength(0);
  });

  test('cross-tenant INSERT is refused (WITH CHECK)', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into memory_items (account_id, company_id, type, content, source_type, source_ref, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, 'user_fact', 'x', 'interview_answer', 'r', ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('content/type/identity immutable + no DELETE; only superseded_by is updatable (0015 edit=supersede)', async () => {
    const id = await insertItem(accountA, companyA1, 'user_fact', 'interview_answer');
    // Content/type/source/confirmation/identity stay immutable — the column grant covers only superseded_by.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update memory_items set content = 'edited' where id = ${id}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update memory_items set confirmation_state = 'accepted' where id = ${id}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update memory_items set type = 'constraint' where id = ${id}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from memory_items where id = ${id}::uuid`.execute(k))).rejects.toThrow();
    // superseded_by IS updatable (the P2-010 edit=supersede grant + UPDATE policy). Point it at a second item.
    const id2 = await insertItem(accountA, companyA1, 'user_fact', 'user_edit', 'correction', id);
    await asApp(scope(accountA, companyA1), (k) => sql`update memory_items set superseded_by = ${id2}::uuid where id = ${id}::uuid`.execute(k));
    const row = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('memory_items').select('superseded_by').where('id', '=', id).executeTakeFirstOrThrow());
    expect(row.superseded_by).toBe(id2);
  });

  test('soft delete (0016): deleted_at/deleted_by_user_id updatable; PAIR + mutual-exclusion CHECKs; content/hard-delete still forbidden', async () => {
    const id = await insertItem(accountA, companyA1, 'user_fact', 'interview_answer');
    // The two delete columns ARE updatable (0016 grant) — mark it deleted.
    await asApp(scope(accountA, companyA1), (k) => sql`update memory_items set deleted_at = now(), deleted_by_user_id = ${userU}::uuid where id = ${id}::uuid`.execute(k));
    const row = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('memory_items').select(['deleted_at', 'deleted_by_user_id']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by_user_id).toBe(userU);
    // PAIR check: deleted_at without deleted_by_user_id (and vice versa) is rejected.
    const id2 = await insertItem(accountA, companyA1, 'user_fact', 'interview_answer');
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update memory_items set deleted_at = now() where id = ${id2}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update memory_items set deleted_by_user_id = ${userU}::uuid where id = ${id2}::uuid`.execute(k))).rejects.toThrow();
    // Mutual-exclusion: a row cannot be both superseded and deleted.
    const id3 = await insertItem(accountA, companyA1, 'user_fact', 'user_edit', 'c', id2);
    await asApp(scope(accountA, companyA1), (k) => sql`update memory_items set superseded_by = ${id3}::uuid where id = ${id2}::uuid`.execute(k));
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update memory_items set deleted_at = now(), deleted_by_user_id = ${userU}::uuid where id = ${id2}::uuid`.execute(k))).rejects.toThrow();
    // A hard DELETE and a content UPDATE are still forbidden even for a deleted row.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from memory_items where id = ${id}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update memory_items set content = 'x' where id = ${id}::uuid`.execute(k))).rejects.toThrow();
  });

  test('closed type + source CHECKs; the TYPE-BY-SOURCE-PATH CHECK (generated source can never be user_fact)', async () => {
    await expect(insertItem(accountA, companyA1, 'opinion', 'interview_answer')).rejects.toThrow(); // bad type
    await expect(insertItem(accountA, companyA1, 'user_fact', 'guess')).rejects.toThrow(); // bad source
    // The load-bearing rule: a generated source cannot carry a user_fact / user_preference.
    await expect(insertItem(accountA, companyA1, 'user_fact', 'model_generation')).rejects.toThrow();
    await expect(insertItem(accountA, companyA1, 'user_preference', 'task_result')).rejects.toThrow();
    // …but the same source CAN carry an ai_assumption / research_finding.
    expect(await insertItem(accountA, companyA1, 'ai_assumption', 'model_generation')).toBeTruthy();
    expect(await insertItem(accountA, companyA1, 'research_finding', 'task_result')).toBeTruthy();
  });

  test('source_ref NOT NULL; confidence range; confirmation-state CHECK', async () => {
    // NULL source_ref rejected (every item carries a resolvable link — MEM-003).
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into memory_items (account_id, company_id, type, content, source_type, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 'constraint', 'x', 'user_edit', ${userU}::uuid)`.execute(k))).rejects.toThrow();
    // confidence out of [0,1] rejected.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into memory_items (account_id, company_id, type, content, source_type, source_ref, confidence, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 'ai_assumption', 'x', 'model_generation', 'r', 1.5, ${userU}::uuid)`.execute(k))).rejects.toThrow();
    // bad confirmation_state rejected.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into memory_items (account_id, company_id, type, content, source_type, source_ref, confirmation_state, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 'constraint', 'x', 'user_edit', 'r', 'bogus', ${userU}::uuid)`.execute(k))).rejects.toThrow();
    // The default confirmation_state is 'proposed'.
    const id = await insertItem(accountA, companyA1, 'constraint', 'user_edit');
    const row = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('memory_items').select(['confirmation_state', 'confidence', 'superseded_by']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(row).toEqual({ confirmation_state: 'proposed', confidence: null, superseded_by: null });
  });

  test('FK cascade: deleting the company removes its memory items', async () => {
    const throwaway = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    await insertItem(accountA, throwaway, 'user_fact', 'user_edit');
    await sql`delete from companies where id = ${throwaway}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from memory_items where company_id = ${throwaway}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; select+insert policies; SELECT+INSERT grants only; 3 SECURITY DEFINER; acbp_app NOBYPASSRLS/non-owner; 0014 applied', async () => {
    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'memory_items' and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    // INSERT + SELECT (0014) + the dual-keyed UPDATE policy added by migration 0015 (ACBP-P2-010 edit=supersede).
    const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = 'memory_items' order by cmd`.execute(su.kysely);
    expect(pols.rows.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    const grants = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'memory_items' order by privilege_type`.execute(su.kysely);
    expect(grants.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
    const others = await sql<{ grantee: string }>`select distinct grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'memory_items' and grantee not in ('acbp_app', (select tableowner from pg_tables where schemaname='public' and tablename='memory_items'))`.execute(su.kysely);
    expect(others.rows).toEqual([]);
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0014_memory_items');
    expect(migs.rows.length).toBeGreaterThanOrEqual(14);
  });
});
