// ACBP-P1-010 / CDR-015 — real-PostgreSQL proof of company tenancy under the RESTRICTED role.
// Setup/seed runs on the superuser (owner) connection; every isolation/immutability assertion runs on a
// second pool connected as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner) so RLS + grants actually apply.
// Proves: account-keyed company INSERT; account-scoped company SELECT; dual-keyed company UPDATE + immutable
// account_id/id; dual-keyed append-only company_profiles + company_memberships (with the self-branch used by
// the no-SECURITY-DEFINER company resolver); audit_events DUAL-SCOPE (account event visible under account
// scope, company event only when BOTH contexts match); FORCE RLS + grant catalog; allowlist still exactly 3
// SECURITY DEFINER functions. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `company_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-company-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-company-test' }));
}

// A ULID literal for direct audit inserts (the writer's server-bound id generation is exercised in Slice 3).
const ULID_1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const ULID_2 = '01ARZ3NDEKTSV4RRFFQ69G5FA2';
const ULID_3 = '01ARZ3NDEKTSV4RRFFQ69G5FA3';

describe.skipIf(!hasTestDatabase)('company tenancy (real PostgreSQL, restricted role) — ACBP-P1-010/CDR-015', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  // Seeded once; FK targets for companies/company_memberships.
  let userU = '';
  let userV = '';
  let accountA = '';
  let accountB = '';

  /** Run `fn` as the restricted role inside a transaction with the given GUCs set transaction-locally. */
  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const acct = (id: string) => ({ 'app.current_account': id });
  const acctCo = (a: string, c: string, actor?: string) => (actor ? { 'app.current_account': a, 'app.current_company': c, 'app.current_actor': actor } : { 'app.current_account': a, 'app.current_company': c });

  /** Insert a company as the app role under account scope; returns its server-generated id. */
  async function createCompany(accountId: string, mode = 'own_idea'): Promise<string> {
    return asApp(acct(accountId), async (k) => {
      const r = await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountId}::uuid, ${mode}) returning id`.execute(k);
      return r.rows[0]!.id;
    });
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of ['usage_events', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    // Seed two accounts + founding users (owner connection bypasses RLS) — FK targets only.
    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_test', 'user_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_test', 'user_v', now()) returning id`.execute(su.kysely);
    userV = v.rows[0]!.id;
    const a = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely);
    accountA = a.rows[0]!.id;
    const b = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely);
    accountB = b.rows[0]!.id;
  });

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ['usage_events', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    // Reset the company graph + audit between tests (owner bypasses RLS); keep the seeded accounts/users.
    await su.kysely.deleteFrom('audit_events').execute();
    await su.kysely.deleteFrom('company_memberships').execute();
    await su.kysely.deleteFrom('company_profiles').execute();
    await su.kysely.deleteFrom('companies').execute();
  });

  // ── companies: account-keyed create, account-scoped read, fail-closed ────────────────────────────────
  test('company INSERT is account-keyed and binds account_id to the caller scope', async () => {
    const id = await createCompany(accountA);
    expect(typeof id).toBe('string');
    // The row is readable back under account A only.
    const a = await asApp(acct(accountA), (k) => k.selectFrom('companies').selectAll().execute());
    expect(a).toHaveLength(1);
    expect(a[0]?.account_id).toBe(accountA);
    expect(a[0]?.status).toBe('draft');
    const b = await asApp(acct(accountB), (k) => k.selectFrom('companies').selectAll().execute());
    expect(b).toHaveLength(0);
  });

  test('forged/absent account is rejected on company INSERT (fail-closed WITH CHECK)', async () => {
    // Scope A, but claim account B → WITH CHECK (account_id = current_account) fails.
    await expect(asApp(acct(accountA), (k) => sql`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea')`.execute(k))).rejects.toThrow();
    // No account GUC → nullif('','') = NULL → WITH CHECK false → rejected.
    await expect(asApp({}, (k) => sql`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea')`.execute(k))).rejects.toThrow();
  });

  // ── companies: dual-keyed UPDATE + immutable identity ────────────────────────────────────────────────
  test('company UPDATE requires BOTH account and company context (dual-keyed)', async () => {
    const id = await createCompany(accountA);
    // Account scope only (no current_company) → USING fails → 0 rows updated (unchanged).
    const noCo = await asApp(acct(accountA), (k) => k.updateTable('companies').set({ status: 'onboarding' }).where('id', '=', id).executeTakeFirst());
    expect(Number(noCo.numUpdatedRows)).toBe(0);
    // Both contexts → update applies.
    const withCo = await asApp(acctCo(accountA, id), (k) => k.updateTable('companies').set({ status: 'onboarding' }).where('id', '=', id).executeTakeFirst());
    expect(Number(withCo.numUpdatedRows)).toBe(1);
    const row = await asApp(acctCo(accountA, id), (k) => k.selectFrom('companies').select('status').where('id', '=', id).executeTakeFirst());
    expect(row?.status).toBe('onboarding');
  });

  test('company account_id and id are immutable (WITH CHECK re-asserts)', async () => {
    const id = await createCompany(accountA);
    // Re-homing the company to account B fails the WITH CHECK even with a matching current_company.
    await expect(asApp(acctCo(accountA, id), (k) => sql`update companies set account_id = ${accountB}::uuid where id = ${id}::uuid`.execute(k))).rejects.toThrow();
  });

  // ── company_profiles: dual-keyed append-only versions ────────────────────────────────────────────────
  test('company_profiles are dual-keyed and append-only (no UPDATE/DELETE grant)', async () => {
    const id = await createCompany(accountA);
    // Insert v1 under company scope.
    await asApp(acctCo(accountA, id), (k) => sql`insert into company_profiles (company_id, version, name, created_by_user_id) values (${id}::uuid, 1, 'Acme', ${userU}::uuid)`.execute(k));
    // Visible under the company scope; invisible without it.
    const seen = await asApp(acctCo(accountA, id), (k) => k.selectFrom('company_profiles').selectAll().execute());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('Acme');
    const blind = await asApp(acct(accountA), (k) => k.selectFrom('company_profiles').selectAll().execute());
    expect(blind).toHaveLength(0);
    // UPDATE and DELETE are denied to the restricted role (append-only).
    await expect(asApp(acctCo(accountA, id), (k) => sql`update company_profiles set name = 'Evil' where company_id = ${id}::uuid`.execute(k))).rejects.toThrow();
    await expect(asApp(acctCo(accountA, id), (k) => sql`delete from company_profiles where company_id = ${id}::uuid`.execute(k))).rejects.toThrow();
    // A second revision is a new row; the PK (company_id, version) serializes writers.
    await asApp(acctCo(accountA, id), (k) => sql`insert into company_profiles (company_id, version, name, created_by_user_id) values (${id}::uuid, 2, 'Acme 2', ${userU}::uuid)`.execute(k));
    await expect(asApp(acctCo(accountA, id), (k) => sql`insert into company_profiles (company_id, version, name) values (${id}::uuid, 2, 'Dup')`.execute(k))).rejects.toThrow();
  });

  // ── company_memberships: dual-keyed INSERT, self-branch SELECT for resolution, active-unique ─────────
  test('company_memberships: dual-keyed insert, self-branch resolution, active uniqueness', async () => {
    const id = await createCompany(accountA);
    // Insert the creator's owner membership under company scope.
    await asApp(acctCo(accountA, id), (k) => sql`insert into company_memberships (account_id, company_id, member_user_id, role) values (${accountA}::uuid, ${id}::uuid, ${userU}::uuid, 'owner')`.execute(k));
    // Self-branch: the member can find their own company membership under ACCOUNT scope (no company yet) to
    // resolve which company to enter — this is what the no-SECURITY-DEFINER resolver relies on.
    const mine = await asApp({ 'app.current_account': accountA, 'app.current_actor': userU }, (k) => k.selectFrom('company_memberships').select(['company_id', 'role']).execute());
    expect(mine).toHaveLength(1);
    expect(mine[0]?.company_id).toBe(id);
    // A different actor under account scope (no company) sees nothing (no self-branch match).
    const other = await asApp({ 'app.current_account': accountA, 'app.current_actor': userV }, (k) => k.selectFrom('company_memberships').selectAll().execute());
    expect(other).toHaveLength(0);
    // Insert forbidden without company context (dual-keyed WITH CHECK).
    await expect(asApp(acct(accountA), (k) => sql`insert into company_memberships (account_id, company_id, member_user_id, role) values (${accountA}::uuid, ${id}::uuid, ${userV}::uuid, 'viewer')`.execute(k))).rejects.toThrow();
    // At most one ACTIVE membership per (company, user).
    await expect(asApp(acctCo(accountA, id), (k) => sql`insert into company_memberships (account_id, company_id, member_user_id, role) values (${accountA}::uuid, ${id}::uuid, ${userU}::uuid, 'viewer')`.execute(k))).rejects.toThrow();
  });

  // ── audit_events: dual-scope (account event vs company event) ────────────────────────────────────────
  test('audit dual-scope: account events are account-visible; company events need BOTH contexts', async () => {
    const id = await createCompany(accountA);
    // Account-scoped audit event (company_id NULL).
    await asApp(acct(accountA), (k) => sql`insert into audit_events (event_id, name, schema_version, account_id, actor_type, subject_type, subject_id, outcome) values (${ULID_1}, 'membership.invited', 1, ${accountA}::uuid, 'user', 'membership', 'm', 'success')`.execute(k));
    // Company-scoped audit event (company_id set) — requires current_company on INSERT.
    await asApp(acctCo(accountA, id), (k) => sql`insert into audit_events (event_id, name, schema_version, account_id, company_id, actor_type, subject_type, subject_id, outcome) values (${ULID_2}, 'company.created', 1, ${accountA}::uuid, ${id}::uuid, 'user', 'company', ${id}, 'success')`.execute(k));

    // Under account scope only: the account event is visible; the company event is HIDDEN (no company match).
    const accountOnly = await asApp(acct(accountA), (k) => k.selectFrom('audit_events').select('event_id').execute());
    expect(accountOnly.map((r) => r.event_id).sort()).toEqual([ULID_1]);
    // Under both contexts: account event (company_id NULL branch) + this company's event are both visible.
    const both = await asApp(acctCo(accountA, id), (k) => k.selectFrom('audit_events').select('event_id').execute());
    expect(both.map((r) => r.event_id).sort()).toEqual([ULID_1, ULID_2].sort());
  });

  test('audit dual-scope: a company event cannot be inserted without a matching company context', async () => {
    const id = await createCompany(accountA);
    // account matches but no current_company → (company_id is null OR company_id = current_company) is false.
    await expect(asApp(acct(accountA), (k) => sql`insert into audit_events (event_id, name, schema_version, account_id, company_id, actor_type, subject_type, subject_id, outcome) values (${ULID_3}, 'company.created', 1, ${accountA}::uuid, ${id}::uuid, 'user', 'company', ${id}, 'success')`.execute(k))).rejects.toThrow();
  });

  // ── catalog: FORCE RLS, least-privilege grants, allowlist unchanged ──────────────────────────────────
  test('catalog: FORCE RLS on all three tables; least-privilege grants; allowlist still 3 SECURITY DEFINER', async () => {
    const rls = await sql<{ relname: string; relforcerowsecurity: boolean }>`select relname, relforcerowsecurity from pg_class where relname = any(array['companies','company_profiles','company_memberships']) and relkind = 'r'`.execute(su.kysely);
    expect(rls.rows).toHaveLength(3);
    for (const row of rls.rows) expect(row.relforcerowsecurity).toBe(true);

    const grantsOf = async (t: string) => {
      const g = await sql<{ privilege_type: string }>`select privilege_type from information_schema.role_table_grants where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${t}`.execute(su.kysely);
      return g.rows.map((r) => r.privilege_type).sort();
    };
    expect(await grantsOf('companies')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(await grantsOf('company_profiles')).toEqual(['INSERT', 'SELECT']);
    expect(await grantsOf('company_memberships')).toEqual(['INSERT', 'SELECT']);

    // No new SECURITY DEFINER function was added by P1-010 (allowlist stays exactly three).
    const definers = await sql<{ n: number }>`select count(*)::int as n from pg_proc where prosecdef = true and proname like 'acbp_%'`.execute(su.kysely);
    expect(definers.rows[0]?.n).toBe(3);
  });

  // ── Adversarial: cross-account/cross-company forgery, no-context, tamper/escalation ───────────────────
  test('a forged current_company pointing at ANOTHER account\'s company reveals/mutates nothing', async () => {
    const coA = await createCompany(accountA);
    const coB = await createCompany(accountB);
    await asApp(acctCo(accountA, coA), (k) => sql`insert into company_profiles (company_id, version, name) values (${coA}::uuid, 1, 'A-Co')`.execute(k));
    await asApp(acctCo(accountB, coB), (k) => sql`insert into company_profiles (company_id, version, name) values (${coB}::uuid, 1, 'B-Co')`.execute(k));

    // Account A forging current_company = coB: companies SELECT is account-scoped → coB (account B) invisible.
    const coSeen = await asApp(acctCo(accountA, coB), (k) => k.selectFrom('companies').select('id').execute());
    expect(coSeen.map((r) => r.id)).toEqual([coA]);
    // company_profiles dual-key + EXISTS(account) → coB's profile is invisible under account A even with the forged company GUC.
    const profSeen = await asApp(acctCo(accountA, coB), (k) => k.selectFrom('company_profiles').selectAll().execute());
    expect(profSeen).toHaveLength(0);
    // And inserting a profile for coB under account A is rejected (WITH CHECK: company must belong to current_account).
    await expect(asApp(acctCo(accountA, coB), (k) => sql`insert into company_profiles (company_id, version, name) values (${coB}::uuid, 2, 'Evil')`.execute(k))).rejects.toThrow();
  });

  test('joins/CTEs/subqueries cannot reveal another company\'s profiles or memberships', async () => {
    const coA = await createCompany(accountA);
    const coB = await createCompany(accountB);
    await asApp(acctCo(accountA, coA), (k) => sql`insert into company_memberships (account_id, company_id, member_user_id, role) values (${accountA}::uuid, ${coA}::uuid, ${userU}::uuid, 'owner')`.execute(k));
    await asApp(acctCo(accountB, coB), (k) => sql`insert into company_memberships (account_id, company_id, member_user_id, role) values (${accountB}::uuid, ${coB}::uuid, ${userV}::uuid, 'owner')`.execute(k));
    const out = await asApp(acctCo(accountA, coA), async (k) => {
      const join = await sql<{ n: number }>`select count(*)::int as n from company_memberships cm join companies c on c.id = cm.company_id`.execute(k);
      const cte = await sql<{ n: number }>`with all_m as (select company_id from company_memberships) select count(*)::int as n from all_m`.execute(k);
      return { join: join.rows[0]?.n, cte: cte.rows[0]?.n };
    });
    expect(out).toEqual({ join: 1, cte: 1 }); // only company A's membership is ever visible
  });

  test('with NO company context, company detail tables reveal nothing (fail-closed)', async () => {
    const coA = await createCompany(accountA);
    await asApp(acctCo(accountA, coA), (k) => sql`insert into company_profiles (company_id, version, name) values (${coA}::uuid, 1, 'A')`.execute(k));
    // Account scope only (no current_company): profiles/memberships are dual-keyed → invisible.
    const prof = await asApp(acct(accountA), (k) => k.selectFrom('company_profiles').selectAll().execute());
    expect(prof).toHaveLength(0);
    // Empty/malformed company GUC denies with no cast error.
    for (const ctx of [{ 'app.current_account': accountA, 'app.current_company': '' }, { 'app.current_account': accountA, 'app.current_company': 'not-a-uuid' }]) {
      const n = await asApp(ctx, (k) => sql<{ n: number }>`select count(*)::int as n from company_profiles`.execute(k).then((x) => x.rows[0]?.n));
      expect(n).toBe(0);
    }
  });

  test('audit company-event forgery: cannot stamp a company_id other than the current company', async () => {
    const coA = await createCompany(accountA);
    const coB = await createCompany(accountB);
    // Under (account A, company A): claim company_id = coB → dual-scope WITH CHECK (company_id = current_company) fails.
    await expect(
      asApp(acctCo(accountA, coA), (k) => sql`insert into audit_events (event_id, name, schema_version, account_id, company_id, actor_type, subject_type, subject_id, outcome) values (${ULID_1}, 'company.updated', 1, ${accountA}::uuid, ${coB}::uuid, 'user', 'company', ${coB}, 'success')`.execute(k)),
    ).rejects.toThrow();
  });

  test('the restricted role cannot tamper with company RLS (ALTER/DROP/DISABLE FORCE) or drop policies', async () => {
    for (const t of ['companies', 'company_profiles', 'company_memberships'] as const) {
      await expect(asApp({}, (k) => sql`alter table public.${sql.ref(t)} no force row level security`.execute(k))).rejects.toThrow();
      await expect(asApp({}, (k) => sql`alter table public.${sql.ref(t)} disable row level security`.execute(k))).rejects.toThrow();
      await expect(asApp({}, (k) => sql`drop table public.${sql.ref(t)}`.execute(k))).rejects.toThrow();
    }
    await expect(asApp({}, (k) => sql`drop policy companies_insert on public.companies`.execute(k))).rejects.toThrow();
    await expect(asApp({}, (k) => sql`create policy evil_all on public.companies for all using (true) with check (true)`.execute(k))).rejects.toThrow();
    // A DELETE on any company table is denied at the grant level (no DELETE granted to acbp_app).
    const coA = await createCompany(accountA);
    await expect(asApp(acctCo(accountA, coA), (k) => sql`delete from company_profiles`.execute(k))).rejects.toThrow();
    await expect(asApp(acctCo(accountA, coA), (k) => sql`delete from company_memberships`.execute(k))).rejects.toThrow();
    await expect(asApp(acctCo(accountA, coA), (k) => sql`delete from companies`.execute(k))).rejects.toThrow();
  });
});
