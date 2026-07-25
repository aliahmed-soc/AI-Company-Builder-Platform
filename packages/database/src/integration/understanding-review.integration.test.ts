// ACBP-P2-009 / CDR-030 — real-PostgreSQL proof of understanding_item_reviews + understanding_confirmation_events
// under the RESTRICTED role. Setup/seed on the superuser (owner) connection; every assertion runs as `acbp_app`
// (NOSUPERUSER, NOBYPASSRLS, non-owner). Proves: dual-keyed company-scoped SELECT/INSERT (both account AND company;
// fail closed without the company key; cross-company read impossible; cross-tenant insert refused); APPEND-ONLY (no
// UPDATE/DELETE grant); the decision/kind CHECKs, the confirmed/corrected shape CHECK, note + correction_ref length;
// UNIQUE (document_id, kind) idempotency (one confirmed + one corrected per version); FK cascade (document→reviews/
// events, company→all); clean down/up/reapply BY NAME; catalog invariants (FORCE RLS, exactly select+insert
// policies, SELECT+INSERT grants only, 3 SECURITY DEFINER, acbp_app NOBYPASSRLS/non-owner, 0020 applied). Skips when
// ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `rev_${'test'}_pw_1970`;

const ALL = ['usage_events', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-rev-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-rev-test' }));
}

describe.skipIf(!hasTestDatabase)('understanding_item_reviews + understanding_confirmation_events (real PostgreSQL, restricted role) — ACBP-P2-009/CDR-030', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let docA = ''; // a seeded document version for company A
  let itemA = ''; // a seeded item of docA
  let docB = ''; // a seeded document version for company B

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  async function insertReview(a: string, c: string, doc: string, item: string, over: { decision?: string; note?: string | null } = {}): Promise<string> {
    const decision = over.decision ?? 'approved';
    const note = over.note === undefined ? null : over.note;
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into understanding_item_reviews (account_id, company_id, document_id, item_id, decision, note, decided_by_user_id) values (${a}::uuid, ${c}::uuid, ${doc}::uuid, ${item}::uuid, ${decision}, ${note}, ${userU}::uuid) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }
  async function insertEvent(a: string, c: string, doc: string, over: { kind?: string; version?: number; correctionRef?: string | null; dependentsFlagged?: number | null } = {}): Promise<string> {
    const kind = over.kind ?? 'confirmed';
    const version = over.version ?? 1;
    const correctionRef = over.correctionRef === undefined ? (kind === 'corrected' ? 'ref_1' : null) : over.correctionRef;
    const dependentsFlagged = over.dependentsFlagged === undefined ? (kind === 'corrected' ? 1 : null) : over.dependentsFlagged;
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into understanding_confirmation_events (account_id, company_id, document_id, version, kind, actor_user_id, correction_ref, dependents_flagged) values (${a}::uuid, ${c}::uuid, ${doc}::uuid, ${version}, ${kind}, ${userU}::uuid, ${correctionRef}, ${dependentsFlagged}) returning id`.execute(k);
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

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_rev', 'user_rev_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_rev', 'user_rev_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;

    // Seed one document + item per company (referenced by reviews/events; understanding_documents/items are 0019).
    docA = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 1, 'complete', 0.5, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    itemA = (await sql<{ id: string }>`insert into understanding_items (account_id, company_id, document_id, item_class, content, confidence, source_ref) values (${accountA}::uuid, ${companyA1}::uuid, ${docA}::uuid, 'fact', 'x', 0.8, null) returning id`.execute(su.kysely)).rows[0]!.id;
    docB = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, 1, 'complete', 0.5, ${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;

    // down/up/reapply BY NAME — proves 0020 is reversible + idempotent through the migrator.
    const down = await createMigrator(su).migrateTo('0019_understanding');
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
    await sql`delete from understanding_confirmation_events`.execute(su.kysely);
    await sql`delete from understanding_item_reviews`.execute(su.kysely);
  });

  test('dual-keyed SELECT/INSERT: rows visible only under their own account+company; cross-company read impossible', async () => {
    await insertReview(accountA, companyA1, docA, itemA);
    await insertEvent(accountA, companyA1, docA);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('understanding_item_reviews').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('understanding_confirmation_events').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('understanding_item_reviews').selectAll().execute())).toHaveLength(0);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('understanding_confirmation_events').selectAll().execute())).toHaveLength(0);
    // Fail closed without the company key.
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('understanding_confirmation_events').selectAll().execute())).toHaveLength(0);
  });

  test('cross-tenant INSERT is refused (WITH CHECK) for both tables', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into understanding_item_reviews (account_id, company_id, document_id, item_id, decision, note, decided_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, ${docB}::uuid, ${itemA}::uuid, 'approved', null, ${userU}::uuid)`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into understanding_confirmation_events (account_id, company_id, document_id, version, kind, actor_user_id, correction_ref, dependents_flagged) values (${accountB}::uuid, ${companyB1}::uuid, ${docB}::uuid, 1, 'confirmed', ${userU}::uuid, null, null)`.execute(k))).rejects.toThrow();
  });

  test('APPEND-ONLY: no UPDATE and no DELETE grant on either table (supersession is a new event, never an edit)', async () => {
    const rev = await insertReview(accountA, companyA1, docA, itemA);
    const ev = await insertEvent(accountA, companyA1, docA);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update understanding_item_reviews set decision = 'rejected' where id = ${rev}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update understanding_confirmation_events set kind = 'corrected' where id = ${ev}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from understanding_item_reviews where id = ${rev}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from understanding_confirmation_events where id = ${ev}::uuid`.execute(k))).rejects.toThrow();
  });

  test('review CHECKs: the closed 5-decision set + note length', async () => {
    for (const d of ['approved', 'edited', 'rejected', 'evidence_requested', 'research_requested']) {
      expect(await insertReview(accountA, companyA1, docA, itemA, { decision: d, note: d === 'edited' ? 'corrected text' : null })).toBeTruthy();
    }
    await expect(insertReview(accountA, companyA1, docA, itemA, { decision: 'approve' })).rejects.toThrow(); // not in the set
    await expect(insertReview(accountA, companyA1, docA, itemA, { decision: 'confirmed' })).rejects.toThrow();
    await expect(insertReview(accountA, companyA1, docA, itemA, { note: 'x'.repeat(10_001) })).rejects.toThrow();
  });

  test('confirmation-event CHECKs: closed kind set + the confirmed/corrected shape constraint', async () => {
    // confirmed carries neither correction_ref nor dependents_flagged.
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'confirmed', correctionRef: 'ref', dependentsFlagged: null })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'confirmed', correctionRef: null, dependentsFlagged: 2 })).rejects.toThrow();
    // corrected requires BOTH correction_ref and a non-negative dependents_flagged.
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'corrected', correctionRef: null, dependentsFlagged: 1 })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'corrected', correctionRef: 'ref', dependentsFlagged: null })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'corrected', correctionRef: 'ref', dependentsFlagged: -1 })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'superseded' })).rejects.toThrow(); // not in the set
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'corrected', correctionRef: 'x'.repeat(257), dependentsFlagged: 1 })).rejects.toThrow();
    // Valid confirmed + a valid correction of the SAME version coexist (distinct kinds).
    expect(await insertEvent(accountA, companyA1, docA, { kind: 'confirmed' })).toBeTruthy();
    expect(await insertEvent(accountA, companyA1, docA, { kind: 'corrected', correctionRef: 'ref', dependentsFlagged: 1 })).toBeTruthy();
  });

  test('UNIQUE (document_id, kind): confirm is idempotent — a second confirmed of the same version is rejected', async () => {
    await insertEvent(accountA, companyA1, docA, { kind: 'confirmed' });
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'confirmed' })).rejects.toThrow();
    // One correction per version too.
    await insertEvent(accountA, companyA1, docA, { kind: 'corrected', correctionRef: 'r1', dependentsFlagged: 1 });
    await expect(insertEvent(accountA, companyA1, docA, { kind: 'corrected', correctionRef: 'r2', dependentsFlagged: 2 })).rejects.toThrow();
  });

  test('FK cascade: deleting a document removes its reviews + events; deleting the company removes everything', async () => {
    await insertReview(accountA, companyA1, docA, itemA);
    await insertEvent(accountA, companyA1, docA);
    // A throwaway company with its own document, review, and event; deleting the company cascades all of it.
    const co = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    const d = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountA}::uuid, ${co}::uuid, 1, 'complete', 0.5, ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const it = (await sql<{ id: string }>`insert into understanding_items (account_id, company_id, document_id, item_class, content, confidence, source_ref) values (${accountA}::uuid, ${co}::uuid, ${d}::uuid, 'fact', 'y', 0.7, null) returning id`.execute(su.kysely)).rows[0]!.id;
    await insertReview(accountA, co, d, it);
    await insertEvent(accountA, co, d);
    // Deleting the DOCUMENT removes its reviews + events (FK cascade).
    await sql`delete from understanding_documents where id = ${d}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from understanding_item_reviews where document_id = ${d}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
    expect((await sql<{ n: number }>`select count(*)::int as n from understanding_confirmation_events where document_id = ${d}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
    // Deleting the COMPANY removes everything scoped to it.
    await sql`delete from companies where id = ${co}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from understanding_confirmation_events where company_id = ${co}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; exactly select+insert policies; SELECT+INSERT grants only; 3 SECURITY DEFINER; acbp_app NOBYPASSRLS/non-owner; 0020 applied', async () => {
    for (const table of ['understanding_item_reviews', 'understanding_confirmation_events']) {
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
    expect(migs.rows.map((m) => m.name)).toContain('0020_understanding_review');
    expect(migs.rows.length).toBeGreaterThanOrEqual(20);
  });
});
