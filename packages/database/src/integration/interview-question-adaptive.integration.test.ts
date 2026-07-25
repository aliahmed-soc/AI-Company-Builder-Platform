// ACBP-P2-005 / CDR-028 — real-PostgreSQL proof of the migration-0018 adaptive columns on interview_questions
// (`rationale`, `source`) under the RESTRICTED role. Setup/seed on the superuser (owner) connection; every
// assertion runs as `acbp_app`. Proves: the columns exist; `source` defaults to 'adaptive' and is CHECK-bound to
// ('adaptive','static_fallback'); `rationale` is nullable + length-bounded; both are IMMUTABLE (the app role has
// no UPDATE grant — an update is refused); clean down/up/reapply BY NAME (0018 reversible); catalog invariants
// (interview_questions grants stay SELECT+INSERT, 3 SECURITY DEFINER, 0018 applied). Skips when the URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `qadapt_${'test'}_pw_1970`;

const ALL = ['usage_events', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-qadapt-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-qadapt-test' }));
}

describe.skipIf(!hasTestDatabase)('interview_questions adaptive columns (real PostgreSQL, restricted role) — ACBP-P2-005/CDR-028', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let accountA = '';
  let companyA1 = '';
  let sessionA = '';
  let pos = 0;

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  /** Insert a question (as the app role) with optional rationale/source overrides; returns its row. */
  async function insertQ(over: { rationale?: string | null; source?: string } = {}): Promise<{ id: string; rationale: string | null; source: string }> {
    pos += 1;
    const rationale = over.rationale === undefined ? null : over.rationale;
    return asApp(scope(accountA, companyA1), async (k) => {
      if (over.source === undefined) {
        const r = await sql<{ id: string; rationale: string | null; source: string }>`insert into interview_questions (session_id, account_id, company_id, position, prompt, rationale) values (${sessionA}::uuid, ${accountA}::uuid, ${companyA1}::uuid, ${pos}, ${'Q' + String(pos)}, ${rationale}) returning id, rationale, source`.execute(k);
        return r.rows[0]!;
      }
      const r = await sql<{ id: string; rationale: string | null; source: string }>`insert into interview_questions (session_id, account_id, company_id, position, prompt, rationale, source) values (${sessionA}::uuid, ${accountA}::uuid, ${companyA1}::uuid, ${pos}, ${'Q' + String(pos)}, ${rationale}, ${over.source}) returning id, rationale, source`.execute(k);
      return r.rows[0]!;
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

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_qad', 'user_qad_u', now()) returning id`.execute(su.kysely);
    const userU = u.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    sessionA = (await sql<{ id: string }>`insert into interview_sessions (account_id, company_id, state, started_at) values (${accountA}::uuid, ${companyA1}::uuid, 'in_progress', now()) returning id`.execute(su.kysely)).rows[0]!.id;

    // down/up/reapply BY NAME — proves 0018 is reversible + idempotent through the migrator.
    const down = await createMigrator(su).migrateTo('0017_usage_events');
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
    await sql`delete from interview_questions`.execute(su.kysely);
    pos = 0;
  });

  test('source defaults to adaptive; rationale defaults to null', async () => {
    const row = await insertQ();
    expect(row.source).toBe('adaptive');
    expect(row.rationale).toBeNull();
  });

  test('source accepts adaptive + static_fallback; rejects anything else', async () => {
    expect((await insertQ({ source: 'adaptive' })).source).toBe('adaptive');
    expect((await insertQ({ source: 'static_fallback' })).source).toBe('static_fallback');
    await expect(insertQ({ source: 'manual' })).rejects.toThrow();
    await expect(insertQ({ source: '' })).rejects.toThrow();
  });

  test('rationale is stored, nullable, and length-bounded (1..1000)', async () => {
    const withR = await insertQ({ rationale: 'Follow-up on your target market to understand the business.' });
    expect(withR.rationale).toContain('target market');
    await expect(insertQ({ rationale: 'x'.repeat(1001) })).rejects.toThrow();
    // A blank rationale (length 0) violates the 1..1000 bound.
    await expect(insertQ({ rationale: '' })).rejects.toThrow();
  });

  test('the adaptive columns are IMMUTABLE — the app role cannot UPDATE them (append-only questions)', async () => {
    const row = await insertQ({ source: 'adaptive' });
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update interview_questions set source = 'static_fallback' where id = ${row.id}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update interview_questions set rationale = 'changed' where id = ${row.id}::uuid`.execute(k))).rejects.toThrow();
  });

  test('catalog: interview_questions grants stay SELECT+INSERT; 3 SECURITY DEFINER; 0018 applied', async () => {
    const grants = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'interview_questions' order by privilege_type`.execute(su.kysely);
    expect(grants.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0018_interview_question_adaptive');
    expect(migs.rows.length).toBeGreaterThanOrEqual(18);
  });
});
