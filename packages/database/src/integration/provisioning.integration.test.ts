// ACBP-P1-012 / CDR-018 — real-PostgreSQL proof of the workspace-provisioning data model (migration 0010) under
// the RESTRICTED role. Setup/seed runs on the superuser (owner) connection; every isolation/privilege assertion
// runs on a second pool connected as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner) so RLS + grants actually
// apply. Proves: backfill (draft/onboarding seeded with six PENDING rows; active/paused NOT; idempotent rerun;
// deterministic down/up); FORCE RLS + dual-key policies on both new tables (account-only context reveals nothing;
// cross-tenant forgery denied); column-level UPDATE privileges (outcome columns only — identity columns immutable
// to the app role); append-only company_workspace_areas; CHECK constraints (closed steps/orders/statuses/areas/
// failure codes; attempt bounds; per-status shape); no DELETE/TRUNCATE; allowlist still exactly 3 SECURITY
// DEFINER; acbp_app NOBYPASSRLS/non-owner. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `prov_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-prov-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-prov-test' }));
}

const STEPS = ['profile', 'mission_draft', 'research', 'roadmap', 'documents', 'activity'] as const;

describe.skipIf(!hasTestDatabase)('workspace provisioning data model (real PostgreSQL, restricted role) — ACBP-P1-012/CDR-018', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let coDraft = '';
  let coOnboarding = '';
  let coActive = '';
  let coPaused = '';
  let coB = ''; // account B's draft company

  const ALL = ['usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const acctCo = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });
  const acct = (a: string) => ({ 'app.current_account': a });

  /** Seed a company with an explicit status directly (superuser; FK targets only — no bootstrap semantics). */
  async function seedCompany(accountId: string, status: string): Promise<string> {
    const r = await sql<{ id: string }>`insert into companies (account_id, creation_mode, status) values (${accountId}::uuid, 'own_idea', ${status}) returning id`.execute(su.kysely);
    return r.rows[0]!.id;
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    // Seed the pre-0010 world FIRST is impossible with one migrateToLatest (companies arrives in 0008), so:
    // migrate fully, seed companies, then exercise the 0010 backfill via down/up (the deterministic-reapply proof
    // doubles as the backfill-behavior proof against a realistic pre-existing population).
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_prov', 'prov_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const a = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely);
    accountA = a.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_prov', 'prov_v', now()) returning id`.execute(su.kysely);
    const b = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${v.rows[0]!.id}::uuid) returning id`.execute(su.kysely);
    accountB = b.rows[0]!.id;

    coDraft = await seedCompany(accountA, 'draft');
    coOnboarding = await seedCompany(accountA, 'onboarding');
    coActive = await seedCompany(accountA, 'active');
    coPaused = await seedCompany(accountA, 'paused');
    coB = await seedCompany(accountB, 'draft');

    // Roll back TO BELOW 0010 BY NAME (a bare one-step migrateDown would pop whatever the head migration is —
    // it broke when 0011 landed on top) and re-apply, so the 0010 backfill runs against this realistic
    // population (down/up determinism).
    const down = await createMigrator(su).migrateTo('0009_activity_events');
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

  // ── Backfill (CDR-018 §9) ────────────────────────────────────────────────────────────────────────────────
  test('backfill seeds six PENDING checkpoints for draft AND onboarding companies only; statuses untouched; no areas', async () => {
    const rows = await su.kysely.selectFrom('provisioning_steps').selectAll().execute();
    const byCompany = new Map<string, typeof rows>();
    for (const r of rows) byCompany.set(r.company_id, [...(byCompany.get(r.company_id) ?? []), r]);
    // draft + onboarding in BOTH accounts get exactly six rows each; active/paused get none.
    expect(new Set(byCompany.keys())).toEqual(new Set([coDraft, coOnboarding, coB]));
    for (const co of [coDraft, coOnboarding, coB]) {
      const steps = byCompany.get(co)!;
      expect(steps).toHaveLength(6);
      expect(steps.map((s) => s.step).sort()).toEqual([...STEPS].sort());
      for (const s of steps) {
        expect(s.status).toBe('pending');
        expect(s.attempt).toBe(0);
        expect(s.started_at).toBeNull();
        expect(s.completed_at).toBeNull();
        expect(s.failed_at).toBeNull();
        expect(s.failure_code).toBeNull();
      }
    }
    // Lifecycle statuses are UNTOUCHED and no area rows were created (the backfill executes nothing).
    const statuses = await su.kysely.selectFrom('companies').select(['id', 'status']).execute();
    const st = new Map(statuses.map((r) => [r.id, r.status]));
    expect(st.get(coDraft)).toBe('draft');
    expect(st.get(coOnboarding)).toBe('onboarding');
    expect(st.get(coActive)).toBe('active');
    expect(st.get(coPaused)).toBe('paused');
    expect(await su.kysely.selectFrom('company_workspace_areas').selectAll().execute()).toHaveLength(0);
  });

  test('backfill rerun is idempotent (ON CONFLICT DO NOTHING — no duplicates, existing rows preserved)', async () => {
    // Mutate one row so a rerun provably does not clobber it.
    await su.kysely.updateTable('provisioning_steps').set({ status: 'completed', attempt: 1, started_at: sql<Date>`now()`, completed_at: sql<Date>`now()` }).where('company_id', '=', coDraft).where('step', '=', 'profile').execute();
    await sql`
      insert into public.provisioning_steps (account_id, company_id, step, step_order)
      select c.account_id, c.id, s.step, s.step_order
      from public.companies c
      cross join (values ('profile', 1), ('mission_draft', 2), ('research', 3), ('roadmap', 4), ('documents', 5), ('activity', 6)) as s(step, step_order)
      where c.status in ('draft', 'onboarding')
      on conflict (company_id, step) do nothing
    `.execute(su.kysely);
    expect(await su.kysely.selectFrom('provisioning_steps').selectAll().execute()).toHaveLength(18);
    const kept = await su.kysely.selectFrom('provisioning_steps').select('status').where('company_id', '=', coDraft).where('step', '=', 'profile').executeTakeFirstOrThrow();
    expect(kept.status).toBe('completed'); // the rerun did not reset the mutated row
    // Restore for later tests.
    await su.kysely.updateTable('provisioning_steps').set({ status: 'pending', attempt: 0, started_at: null, completed_at: null }).where('company_id', '=', coDraft).where('step', '=', 'profile').execute();
  });

  // ── RLS (dual-key, fail-closed) ──────────────────────────────────────────────────────────────────────────
  test('dual-key visibility: rows appear ONLY under the matching account+company scope', async () => {
    const seen = await asApp(acctCo(accountA, coDraft), (k) => k.selectFrom('provisioning_steps').select('step').execute());
    expect(seen).toHaveLength(6);
    // Account scope alone (no company GUC) → nothing (no account-only product authority).
    expect(await asApp(acct(accountA), (k) => k.selectFrom('provisioning_steps').selectAll().execute())).toHaveLength(0);
    // Another company of the SAME account → only that company's rows (not coDraft's).
    const other = await asApp(acctCo(accountA, coOnboarding), (k) => k.selectFrom('provisioning_steps').select('company_id').execute());
    expect(new Set(other.map((r) => r.company_id))).toEqual(new Set([coOnboarding]));
    // Cross-account forgery: account A claiming account B's company → nothing.
    expect(await asApp(acctCo(accountA, coB), (k) => k.selectFrom('provisioning_steps').selectAll().execute())).toHaveLength(0);
    // Same for the areas table (empty but the policy shape is proven by the INSERT tests below).
    expect(await asApp(acct(accountA), (k) => k.selectFrom('company_workspace_areas').selectAll().execute())).toHaveLength(0);
  });

  test('INSERT is dual-key bound: in-scope succeeds; forged/cross-tenant/absent context rejected', async () => {
    // In-scope area insert succeeds (the material step effect path).
    await asApp(acctCo(accountA, coDraft), (k) => sql`insert into company_workspace_areas (account_id, company_id, area) values (${accountA}::uuid, ${coDraft}::uuid, 'research')`.execute(k));
    const rows = await asApp(acctCo(accountA, coDraft), (k) => k.selectFrom('company_workspace_areas').select('area').execute());
    expect(rows.map((r) => r.area)).toEqual(['research']);
    // Claiming ANOTHER company id in the row than the scope → WITH CHECK fails.
    await expect(asApp(acctCo(accountA, coDraft), (k) => sql`insert into company_workspace_areas (account_id, company_id, area) values (${accountA}::uuid, ${coOnboarding}::uuid, 'roadmap')`.execute(k))).rejects.toThrow();
    // Cross-account: under (A, coB) the scope itself mismatches the row → rejected.
    await expect(asApp(acctCo(accountA, coB), (k) => sql`insert into company_workspace_areas (account_id, company_id, area) values (${accountB}::uuid, ${coB}::uuid, 'documents')`.execute(k))).rejects.toThrow();
    // No context at all → fail-closed.
    await expect(asApp({}, (k) => sql`insert into company_workspace_areas (account_id, company_id, area) values (${accountA}::uuid, ${coDraft}::uuid, 'documents')`.execute(k))).rejects.toThrow();
    // provisioning_steps INSERT is likewise dual-key bound (checkpoints for a foreign company can't be forged).
    await expect(asApp(acctCo(accountA, coDraft), (k) => sql`insert into provisioning_steps (account_id, company_id, step, step_order) values (${accountB}::uuid, ${coB}::uuid, 'profile', 1)`.execute(k))).rejects.toThrow();
    await su.kysely.deleteFrom('company_workspace_areas').execute(); // reset
  });

  test('UPDATE is dual-key + column-limited: outcome columns mutable in scope; identity columns and foreign rows are not', async () => {
    // In-scope outcome update succeeds (pending → failed with a closed code).
    const upd = await asApp(acctCo(accountA, coDraft), (k) =>
      k.updateTable('provisioning_steps').set({ status: 'failed', attempt: 1, started_at: sql<Date>`now()`, failed_at: sql<Date>`now()`, failure_code: 'internal_error', updated_at: sql<Date>`now()` }).where('company_id', '=', coDraft).where('step', '=', 'documents').executeTakeFirst(),
    );
    expect(Number(upd.numUpdatedRows)).toBe(1);
    // Under a DIFFERENT company scope the row is invisible → 0 rows updated (no cross-company mutation).
    const foreign = await asApp(acctCo(accountA, coOnboarding), (k) => k.updateTable('provisioning_steps').set({ status: 'completed', attempt: 1, started_at: sql<Date>`now()`, completed_at: sql<Date>`now()`, updated_at: sql<Date>`now()` }).where('company_id', '=', coDraft).where('step', '=', 'documents').executeTakeFirst());
    expect(Number(foreign.numUpdatedRows)).toBe(0);
    // Identity columns carry NO update privilege for acbp_app (42501 — immutable regardless of RLS).
    await expect(asApp(acctCo(accountA, coDraft), (k) => sql`update provisioning_steps set step_order = 5 where company_id = ${coDraft}::uuid and step = 'documents'`.execute(k))).rejects.toThrow();
    await expect(asApp(acctCo(accountA, coDraft), (k) => sql`update provisioning_steps set requested_at = now() where company_id = ${coDraft}::uuid and step = 'documents'`.execute(k))).rejects.toThrow();
    await expect(asApp(acctCo(accountA, coDraft), (k) => sql`update provisioning_steps set company_id = ${coOnboarding}::uuid where company_id = ${coDraft}::uuid and step = 'documents'`.execute(k))).rejects.toThrow();
    // The areas table has NO update grant at all (append-only).
    await su.kysely.updateTable('provisioning_steps').set({ status: 'pending', attempt: 0, started_at: null, failed_at: null, failure_code: null }).where('company_id', '=', coDraft).where('step', '=', 'documents').execute();
  });

  test('DELETE and TRUNCATE are denied on both tables (no grant); areas UPDATE denied too', async () => {
    for (const t of ['usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas'] as const) {
      await expect(asApp(acctCo(accountA, coDraft), (k) => sql`delete from public.${sql.ref(t)}`.execute(k))).rejects.toThrow();
      await expect(asApp(acctCo(accountA, coDraft), (k) => sql`truncate table public.${sql.ref(t)}`.execute(k))).rejects.toThrow();
    }
    await expect(asApp(acctCo(accountA, coDraft), (k) => sql`update company_workspace_areas set area = 'roadmap'`.execute(k))).rejects.toThrow();
  });

  // ── CHECK constraints (closed sets + shape) ──────────────────────────────────────────────────────────────
  test('CHECKs: closed step/order/status/area/failure-code sets; attempt bounds; per-status shape', async () => {
    // Unknown step; canonical-order mismatch; unknown status; attempt out of bounds; pending with attempt>0.
    await expect(sql`insert into provisioning_steps (account_id, company_id, step, step_order) values (${accountA}::uuid, ${coActive}::uuid, 'hosting', 7)`.execute(su.kysely)).rejects.toThrow();
    await expect(sql`insert into provisioning_steps (account_id, company_id, step, step_order) values (${accountA}::uuid, ${coActive}::uuid, 'profile', 2)`.execute(su.kysely)).rejects.toThrow();
    await expect(sql`insert into provisioning_steps (account_id, company_id, step, step_order, status) values (${accountA}::uuid, ${coActive}::uuid, 'profile', 1, 'running')`.execute(su.kysely)).rejects.toThrow();
    await expect(sql`insert into provisioning_steps (account_id, company_id, step, step_order, status, attempt, started_at, failed_at, failure_code) values (${accountA}::uuid, ${coActive}::uuid, 'profile', 1, 'failed', 4, now(), now(), 'internal_error')`.execute(su.kysely)).rejects.toThrow();
    await expect(sql`insert into provisioning_steps (account_id, company_id, step, step_order, attempt) values (${accountA}::uuid, ${coActive}::uuid, 'profile', 1, 1)`.execute(su.kysely)).rejects.toThrow();
    // completed requires completed_at and forbids failure fields; failed requires failed_at + a CLOSED code.
    await expect(sql`insert into provisioning_steps (account_id, company_id, step, step_order, status, attempt, started_at) values (${accountA}::uuid, ${coActive}::uuid, 'profile', 1, 'completed', 1, now())`.execute(su.kysely)).rejects.toThrow();
    await expect(sql`insert into provisioning_steps (account_id, company_id, step, step_order, status, attempt, started_at, failed_at, failure_code) values (${accountA}::uuid, ${coActive}::uuid, 'profile', 1, 'failed', 1, now(), now(), 'SQLSTATE 23505')`.execute(su.kysely)).rejects.toThrow();
    // Areas: closed set; duplicate (company, area) conflicts.
    await expect(sql`insert into company_workspace_areas (account_id, company_id, area) values (${accountA}::uuid, ${coActive}::uuid, 'profile')`.execute(su.kysely)).rejects.toThrow();
    await sql`insert into company_workspace_areas (account_id, company_id, area) values (${accountA}::uuid, ${coActive}::uuid, 'roadmap')`.execute(su.kysely);
    await expect(sql`insert into company_workspace_areas (account_id, company_id, area) values (${accountA}::uuid, ${coActive}::uuid, 'roadmap')`.execute(su.kysely)).rejects.toThrow();
    await su.kysely.deleteFrom('company_workspace_areas').execute();
  });

  // ── Catalog ──────────────────────────────────────────────────────────────────────────────────────────────
  test('catalog: FORCE RLS on both tables; exact policy set; exact grants; still exactly 3 SECURITY DEFINER; acbp_app NOBYPASSRLS/non-owner', async () => {
    const rls = await sql<{ relname: string; relforcerowsecurity: boolean }>`select relname, relforcerowsecurity from pg_class where relname = any(array['provisioning_steps','company_workspace_areas']) and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows).toHaveLength(2);
    for (const row of rls.rows) expect(row.relforcerowsecurity).toBe(true);

    const pols = await sql<{ tablename: string; policyname: string; cmd: string; permissive: string }>`select tablename, policyname, cmd, permissive from pg_policies where tablename = any(array['provisioning_steps','company_workspace_areas'])`.execute(su.kysely);
    expect(pols.rows.map((p) => `${p.tablename}:${p.cmd}`).sort()).toEqual(['company_workspace_areas:INSERT', 'company_workspace_areas:SELECT', 'provisioning_steps:INSERT', 'provisioning_steps:SELECT', 'provisioning_steps:UPDATE'].sort());
    for (const p of pols.rows) expect(p.permissive).toBe('PERMISSIVE'); // standard policies, but NO FOR ALL / no extra commands

    const tableGrants = async (t: string) => {
      const g = await sql<{ privilege_type: string }>`select distinct privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${t}`.execute(su.kysely);
      return g.rows.map((r) => r.privilege_type).sort();
    };
    // UPDATE is COLUMN-level only, so it must NOT appear as a table-wide grant (role_table_grants shows
    // table-level privileges; the column-level UPDATE surface is asserted exactly below).
    expect(await tableGrants('provisioning_steps')).toEqual(['INSERT', 'SELECT']);
    expect(await tableGrants('company_workspace_areas')).toEqual(['INSERT', 'SELECT']);
    // Column-level UPDATE: EXACTLY the outcome columns.
    const cols = await sql<{ column_name: string }>`select column_name from information_schema.column_privileges where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'provisioning_steps' and privilege_type = 'UPDATE'`.execute(su.kysely);
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(['attempt', 'completed_at', 'failed_at', 'failure_code', 'started_at', 'status', 'updated_at']);

    const definers = await sql<{ n: number }>`select count(*)::int as n from pg_proc where prosecdef = true and proname like 'acbp_%'`.execute(su.kysely);
    expect(definers.rows[0]?.n).toBe(3);
    const role = await sql<{ rolbypassrls: boolean; rolsuper: boolean }>`select rolbypassrls, rolsuper from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});
