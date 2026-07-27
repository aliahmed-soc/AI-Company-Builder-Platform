// ACBP-P2-003 / CDR-026 — real-PostgreSQL proof of `usage_events` under the RESTRICTED role. Setup/seed runs on
// the superuser (owner) connection; every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner).
// Proves: dual-keyed company-scoped SELECT/INSERT (both account AND company; fail closed without the company
// key; cross-company read impossible — USAGE-001); APPEND-ONLY (no UPDATE/DELETE grant, no UPDATE policy — a row
// is immutable once written, invariant 9); the outcome↔error_category pairing CHECK; the closed
// kind/task_class/outcome/error_category enums; non-negative token/cost/latency CHECKs; bounded provider/model/
// correlation lengths; FK cascade; clean down/up/reapply BY NAME; catalog invariants (FORCE RLS, exactly
// select+insert policies, SELECT+INSERT grants only, 3 SECURITY DEFINER, acbp_app NOBYPASSRLS/non-owner, 0017
// applied). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `usage_${'test'}_pw_1970`;

const ALL = ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'jobs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-usage-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-usage-test' }));
}

describe.skipIf(!hasTestDatabase)('usage_events (real PostgreSQL, restricted role) — ACBP-P2-003/CDR-026', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
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

  /** Insert a well-formed model_call usage event via raw SQL (bypasses the repo so the CHECKs are what's tested). */
  async function insertEvent(a: string, c: string, over: Partial<Record<string, unknown>> = {}): Promise<string> {
    const v = {
      provider: 'fake', model: 'fake-1@2026-01', task_class: 'interactive', outcome: 'ok',
      error_category: null as string | null, input_tokens: 10, output_tokens: 5, estimated_cost_micros: 0,
      fallback_used: false, latency_ms: 12, correlation_id: null as string | null, ...over,
    };
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into usage_events
        (account_id, company_id, provider, model, task_class, outcome, error_category, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms, correlation_id)
        values (${a}::uuid, ${c}::uuid, ${v.provider}, ${v.model}, ${v.task_class}, ${v.outcome}, ${v.error_category}, ${v.input_tokens}, ${v.output_tokens}, ${v.estimated_cost_micros}, ${v.fallback_used}, ${v.latency_ms}, ${v.correlation_id})
        returning id`.execute(k);
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

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_usage', 'user_usage_u', now()) returning id`.execute(su.kysely);
    const userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_usage', 'user_usage_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;

    // down/up/reapply BY NAME — proves 0017 is reversible + idempotent through the migrator.
    const down = await createMigrator(su).migrateTo('0016_memory_soft_delete');
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
    await sql`delete from usage_events`.execute(su.kysely);
  });

  test('dual-keyed SELECT/INSERT: events visible only under their own account+company; cross-company read impossible', async () => {
    await insertEvent(accountA, companyA1);
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('usage_events').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('usage_events').selectAll().execute())).toHaveLength(0);
    // Fail closed without the company key.
    expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('usage_events').selectAll().execute())).toHaveLength(0);
  });

  test('cross-tenant INSERT is refused (WITH CHECK)', async () => {
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms) values (${accountB}::uuid, ${companyB1}::uuid, 'fake', 'm@1', 'interactive', 'ok', 1, 1, 0, false, 1)`.execute(k))).rejects.toThrow();
  });

  // ── ACBP-P5-009 / CDR-047 — the fallback REASON (migration 0030) ─────────────────────────────────────────
  test('fallback_reason: the closed category set, and a reason NEVER without a fallover', async () => {
    const insertWith = (fallbackUsed: boolean, reason: string | null) =>
      asApp(scope(accountA, companyA1), (k) =>
        sql`insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, fallback_reason, latency_ms) values (${accountA}::uuid, ${companyA1}::uuid, 'fake', 'm@1', 'interactive', 'ok', 1, 1, 0, ${fallbackUsed}, ${reason}, 1)`.execute(k),
      );

    // A real fallover carrying its normalized reason — the row this column exists for.
    await expect(insertWith(true, 'provider_unavailable')).resolves.toBeDefined();
    await expect(insertWith(true, 'timeout')).resolves.toBeDefined();
    // No fallover, no reason.
    await expect(insertWith(false, null)).resolves.toBeDefined();

    // THE CONTRADICTORY STATE: claiming no fallover while naming why it fell back. Worse than no record, because it
    // reads as authoritative. Refused by the CHECK.
    await expect(insertWith(false, 'timeout')).rejects.toThrow();

    // Raw provider text can never reach a ledger retained for the billing lifetime — only the closed set.
    await expect(insertWith(true, 'anthropic returned 529 overloaded')).rejects.toThrow();
    await expect(insertWith(true, 'not_a_category')).rejects.toThrow();
  });

  test('fallback_reason: legacy rows with fallback_used and NO reason remain insertable (migration safety)', async () => {
    // Deliberate asymmetry, recorded in 0030. The symmetric constraint — every fallover carries a reason — would
    // have failed `ADD CONSTRAINT` against rows written before the migration, which have `fallback_used = true` and
    // no reason. It would have passed in CI, where the schema is rebuilt each run, and broken the first real
    // deployment carrying history. The forward guarantee is the gateway's job, and its own tests pin it.
    await expect(
      asApp(scope(accountA, companyA1), (k) =>
        sql`insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms) values (${accountA}::uuid, ${companyA1}::uuid, 'fake', 'm@1', 'interactive', 'ok', 1, 1, 0, true, 1)`.execute(k),
      ),
    ).resolves.toBeDefined();
  });

  test('APPEND-ONLY: no UPDATE and no DELETE grant (both refused for the app role)', async () => {
    const id = await insertEvent(accountA, companyA1);
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update usage_events set outcome = 'error' where id = ${id}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`update usage_events set estimated_cost_micros = 999 where id = ${id}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(scope(accountA, companyA1), (k) => sql`delete from usage_events where id = ${id}::uuid`.execute(k))).rejects.toThrow();
  });

  test('outcome↔error_category pairing CHECK', async () => {
    // ok WITH a category → rejected.
    await expect(insertEvent(accountA, companyA1, { outcome: 'ok', error_category: 'timeout' })).rejects.toThrow();
    // error WITHOUT a category → rejected.
    await expect(insertEvent(accountA, companyA1, { outcome: 'error', error_category: null })).rejects.toThrow();
    // error WITH a valid category → accepted.
    expect(await insertEvent(accountA, companyA1, { outcome: 'error', error_category: 'provider_unavailable' })).toBeTruthy();
  });

  test('closed enums: kind, task_class, outcome, error_category', async () => {
    await expect(insertEvent(accountA, companyA1, { task_class: 'bogus' })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, { outcome: 'maybe' })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, { outcome: 'error', error_category: 'exploded' })).rejects.toThrow();
    // kind defaults to 'model_call'; a foreign kind is rejected.
    await expect(asApp(scope(accountA, companyA1), (k) => sql`insert into usage_events (account_id, company_id, kind, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms) values (${accountA}::uuid, ${companyA1}::uuid, 'tool_call', 'fake', 'm@1', 'interactive', 'ok', 1, 1, 0, false, 1)`.execute(k))).rejects.toThrow();
    // Every valid task_class + the generation class is accepted.
    for (const tc of ['interactive', 'extraction', 'classification', 'generation']) {
      expect(await insertEvent(accountA, companyA1, { task_class: tc })).toBeTruthy();
    }
  });

  test('non-negative token/cost/latency + bounded provider/model/correlation lengths', async () => {
    await expect(insertEvent(accountA, companyA1, { input_tokens: -1 })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, { output_tokens: -1 })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, { estimated_cost_micros: -1 })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, { latency_ms: -1 })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, { provider: '' })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, { model: 'x'.repeat(129) })).rejects.toThrow();
    await expect(insertEvent(accountA, companyA1, { correlation_id: 'x'.repeat(129) })).rejects.toThrow();
    // A well-formed correlation id is accepted and round-trips.
    const id = await insertEvent(accountA, companyA1, { correlation_id: 'corr-123' });
    const row = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('usage_events').select(['correlation_id', 'kind']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(row).toEqual({ correlation_id: 'corr-123', kind: 'model_call' });
  });

  test('FK cascade: deleting the company removes its usage events', async () => {
    const throwaway = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    await insertEvent(accountA, throwaway);
    await sql`delete from companies where id = ${throwaway}::uuid`.execute(su.kysely);
    expect((await sql<{ n: number }>`select count(*)::int as n from usage_events where company_id = ${throwaway}::uuid`.execute(su.kysely)).rows[0]?.n).toBe(0);
  });

  test('catalog: FORCE RLS; exactly select+insert policies; SELECT+INSERT grants only; 3 SECURITY DEFINER; acbp_app NOBYPASSRLS/non-owner; 0017 applied', async () => {
    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'usage_events' and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    // Append-only: exactly INSERT + SELECT policies — NO update/delete policy (unlike memory_items).
    const pols = await sql<{ cmd: string }>`select cmd from pg_policies where tablename = 'usage_events' order by cmd`.execute(su.kysely);
    expect(pols.rows.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT']);
    const grants = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'usage_events' order by privilege_type`.execute(su.kysely);
    expect(grants.rows.map((g) => g.privilege_type)).toEqual(['INSERT', 'SELECT']);
    const others = await sql<{ grantee: string }>`select distinct grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'usage_events' and grantee not in ('acbp_app', (select tableowner from pg_tables where schemaname='public' and tablename='usage_events'))`.execute(su.kysely);
    expect(others.rows).toEqual([]);
    const definers = await sql<{ proname: string }>`select proname from pg_proc where prosecdef = true and pronamespace = 'public'::regnamespace order by proname`.execute(su.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const migs = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(su.kysely);
    expect(migs.rows.map((m) => m.name)).toContain('0017_usage_events');
    expect(migs.rows.length).toBeGreaterThanOrEqual(17);
  });
});
