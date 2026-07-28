// ACBP-P2-008 / CDR-029 — real-PostgreSQL proof of understanding_documents + understanding_items under the
// RESTRICTED role. Setup/seed on the superuser (owner) connection; every assertion runs as `acbp_app`
// (NOSUPERUSER, NOBYPASSRLS, non-owner). Proves: dual-keyed company-scoped SELECT/INSERT (both account AND company;
// fail closed without the company key; cross-company read impossible; cross-tenant insert refused); APPEND-ONLY /
// versioned (no UPDATE/DELETE grant); the status/class/confidence/content/source_ref CHECKs; unique (company_id,
// version); FK cascade (document→items, company→all); clean down/up/reapply BY NAME; catalog invariants (FORCE
// RLS, exactly select+insert policies, SELECT+INSERT grants only, 3 SECURITY DEFINER, acbp_app NOBYPASSRLS/non-
// owner, 0019 applied). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `und_${'test'}_pw_1970`;

const ALL = ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'artifacts', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-und-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-und-test' }));
}

describe.skipIf(!hasTestDatabase)('understanding_documents + understanding_items (real PostgreSQL, restricted role) — ACBP-P2-008/CDR-029', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let ver = 0;

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  async function insertDoc(a: string, c: string, over: { status?: string; confidence?: number } = {}): Promise<string> {
    ver += 1;
    const status = over.status ?? 'complete';
    const confidence = over.confidence ?? 0.5;
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${a}::uuid, ${c}::uuid, ${ver}, ${status}, ${confidence}, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }
  async function insertItem(a: string, c: string, doc: string, over: { itemClass?: string; content?: string; confidence?: number; sourceRef?: string | null } = {}): Promise<string> {
    const itemClass = over.itemClass ?? 'fact';
    const content = over.content ?? 'The founder sells coffee.';
    const confidence = over.confidence ?? 0.8;
    const sourceRef = over.sourceRef === undefined ? 'memory:abc' : over.sourceRef;
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into understanding_items (account_id, company_id, document_id, item_class, content, confidence, source_ref) values (${a}::uuid, ${c}::uuid, ${doc}::uuid, ${itemClass}, ${content}, ${confidence}, ${sourceRef}) returning id`.execute(k);
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

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_und', 'user_und_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_und', 'user_und_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;

    // down/up/reapply BY NAME — proves 0019 is reversible + idempotent through the migrator.
    const down = await createMigrator(su).migrateTo('0018_interview_question_adaptive');
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
    await sql`delete from understanding_items`.execute(su.kysely);
    await sql`delete from understanding_documents`.execute(su.kysely);
    ver = 0;
  });

  test('dual-keyed SELECT/INSERT: rows visible only under their own account+company; cross-company read impossible', async () => {
    const doc = await insertDoc(accountA, companyA1);
    await insertItem(accountA, companyA1, doc);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('understanding_documents').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('understanding_items').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('understanding_documents').selectAll().execute())).toHaveLength(0);
    // Fail closed without the company key.
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('understanding_documents').selectAll().execute())).toHaveLength(0);
  });

  test('cross-tenant INSERT is refused (WITH CHECK) for both tables', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, 1, 'complete', 0.5, ${userU}::uuid)`.execute(k))).rejects.toThrow();
    const doc = await insertDoc(accountA, companyA1);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into understanding_items (account_id, company_id, document_id, item_class, content, confidence) values (${accountB}::uuid, ${companyB1}::uuid, ${doc}::uuid, 'fact', 'x', 0.5)`.execute(k))).rejects.toThrow();
  });

  test('APPEND-ONLY: no UPDATE and no DELETE grant on either table (a version is immutable — review is P2-009)', async () => {
    const doc = await insertDoc(accountA, companyA1);
    const item = await insertItem(accountA, companyA1, doc);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update understanding_documents set status = 'partial' where id = ${doc}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update understanding_items set confidence = 0.1 where id = ${item}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from understanding_documents where id = ${doc}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from understanding_items where id = ${item}::uuid`.execute(k))).rejects.toThrow();
  });

  test('CHECKs: status set, class set, confidence range, content length, source_ref length, version positive + unique', async () => {
    await expect(insertDoc(accountA, companyA1, { status: 'draft' })).rejects.toThrow();
    await expect(insertDoc(accountA, companyA1, { confidence: 1.5 })).rejects.toThrow();
    const doc = await insertDoc(accountA, companyA1);
    await expect(insertItem(accountA, companyA1, doc, { itemClass: 'user_fact' })).rejects.toThrow(); // memory type, not an understanding class
    await expect(insertItem(accountA, companyA1, doc, { confidence: -0.1 })).rejects.toThrow();
    await expect(insertItem(accountA, companyA1, doc, { content: '' })).rejects.toThrow();
    await expect(insertItem(accountA, companyA1, doc, { sourceRef: 'x'.repeat(300) })).rejects.toThrow();
    // A null source_ref is allowed; all 6 classes are accepted.
    for (const c of ['fact', 'preference', 'constraint', 'assumption', 'research_finding', 'open_question']) {
      expect(await insertItem(accountA, companyA1, doc, { itemClass: c, sourceRef: null })).toBeTruthy();
    }
    // Unique (company_id, version): the SAME version twice for a company is rejected (insert v50, then v50 again).
    await asApp(scope(accountA, companyA1), (k) => sql`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 50, 'complete', 0.5, ${userU}::uuid)`.execute(k));
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 50, 'complete', 0.5, ${userU}::uuid)`.execute(k))).rejects.toThrow();
  });

  test('FK cascade: deleting a document removes its items; deleting the company removes all understanding', async () => {
    const doc = await insertDoc(accountA, companyA1);
    await insertItem(accountA, companyA1, doc);
    await sql`delete from understanding_documents where id = ${doc}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from understanding_items where document_id = ${doc}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
    const throwaway = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const d2 = await insertDoc(accountA, throwaway);
    await insertItem(accountA, throwaway, d2);
    await sql`delete from companies where id = ${throwaway}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from understanding_documents where company_id = ${throwaway}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; exactly select+insert policies; SELECT+INSERT grants only; 3 SECURITY DEFINER; acbp_app NOBYPASSRLS/non-owner; 0019 applied', async () => {
    for (const table of ['understanding_documents', 'understanding_items']) {
      const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table} and relkind = 'r'`.execute(su.kysely);
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = ${table} order by cmd`.execute(su.kysely);
      expect(pols.rows.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT']);
      const grants = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table} order by privilege_type`.execute(su.kysely);
      expect(grants.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
      const others = await sql<{ grantee: string }>`select distinct grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = ${table} and grantee not in ('acbp_app', (select tableowner from pg_tables where schemaname='public' and tablename=${table}))`.execute(su.kysely);
      expect(others.rows).toEqual([]);
    }
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0019_understanding');
    expect(migs.rows.length).toBeGreaterThanOrEqual(19);
  });
});
