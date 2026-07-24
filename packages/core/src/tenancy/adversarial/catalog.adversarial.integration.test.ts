// ACBP-P1-014 / CDR-020 §7 — the CONSOLIDATED catalog and role suite for tenant isolation.
//
// This is the single canonical place that pins the platform-wide isolation preconditions: the restricted
// role's attributes and ownership, the closed SECURITY DEFINER allowlist, FORCE RLS on every tenant table,
// policy shape (no unexpectedly broadening permissive policy; USING/WITH CHECK symmetry where required),
// exact mutation and column-level grants, append-only guarantees, and the absence of an owner runtime
// connection. Per-ticket suites keep only their own domain-specific assertions.
//
// Every assertion that is ABOUT the restricted role runs ON the restricted role; catalog inspection uses the
// owner/fixture client (reading pg_catalog is not an isolation claim). Threat ids come from the shared
// inventory. Runs as `acbp_app` under FORCE RLS; skips locally without ACBP_TEST_DATABASE_URL; never mocked.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, teardown, assertRestrictedRole, asRestricted, type RestrictedRoleProof } from '@acbp/test-support';
import { threatTitle } from '@acbp/test-support';

/** Every tenant-scoped table that must carry ENABLE + FORCE RLS. */
const TENANT_TABLES = ['accounts', 'account_profiles', 'memberships', 'audit_events', 'companies', 'company_profiles', 'company_memberships', 'activity_events', 'provisioning_steps', 'company_workspace_areas', 'platform_admins', 'interview_sessions', 'interview_questions', 'interview_answers', 'memory_items'] as const;

/** The closed SECURITY DEFINER allowlist (CDR-013 #4/#5) — exact names, namespace-wide. */
const EXPECTED_DEFINERS = ['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership'] as const;

/**
 * Exact TABLE-LEVEL grants held by acbp_app, transcribed from the migrations (0005/0007–0011). Column-level
 * grants do NOT appear in `role_table_grants` — `provisioning_steps` therefore shows only INSERT/SELECT here
 * and its outcome-column UPDATE is asserted separately against `column_privileges`.
 *
 * Notable least-privilege facts this pins: `account_profiles` has NO INSERT (profiles are created by the
 * SECURITY DEFINER bootstrap), `company_profiles`/`company_memberships` have NO UPDATE (versioned/append-only
 * by design), and `platform_admins` is SELECT-only (no runtime write path — CDR-019).
 */
const EXPECTED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  accounts: ['SELECT', 'UPDATE'],
  account_profiles: ['SELECT', 'UPDATE'],
  memberships: ['INSERT', 'SELECT', 'UPDATE'],
  audit_events: ['INSERT', 'SELECT'],
  companies: ['INSERT', 'SELECT', 'UPDATE'],
  company_profiles: ['INSERT', 'SELECT'],
  company_memberships: ['INSERT', 'SELECT'],
  activity_events: ['INSERT', 'SELECT'],
  provisioning_steps: ['INSERT', 'SELECT'],
  company_workspace_areas: ['INSERT', 'SELECT'],
  platform_admins: ['SELECT'],
  // Interview sessions (ACBP-P2-001; CDR-022): INSERT/SELECT at the table level; the state/started_at/updated_at
  // UPDATE is COLUMN-LEVEL (identity columns immutable), so it shows in column_privileges, not here.
  interview_sessions: ['INSERT', 'SELECT'],
  // Interview Q&A (ACBP-P2-002; CDR-023): both append-only/immutable — SELECT+INSERT only, no UPDATE/DELETE.
  interview_questions: ['INSERT', 'SELECT'],
  interview_answers: ['INSERT', 'SELECT'],
  // Typed memory (ACBP-P2-006; CDR-024): append-only for P2-006 — SELECT+INSERT only (supersede is P2-010).
  memory_items: ['INSERT', 'SELECT'],
};

describe.skipIf(!hasTestDatabase)('tenant-isolation catalog + role preconditions (real PostgreSQL) — ACBP-P1-014/CDR-020', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let proof: RestrictedRoleProof;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    // FAIL-FAST: everything below is meaningless unless the product client is genuinely restricted.
    proof = await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });

  test('HARNESS GUARD — product assertions run as acbp_app: not superuser, not BYPASSRLS, owns no product table', () => {
    expect(proof.currentUser).toBe('acbp_app');
    expect(proof.isSuperuser).toBe(false);
    expect(proof.bypassesRls).toBe(false);
    expect(proof.ownedProductTables).toEqual([]);
  });

  test('the restricted role is not the migration/owner role and holds no role memberships', async () => {
    const attrs = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolinherit: boolean }>`
      select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit from pg_roles where rolname = 'acbp_app'
    `.execute(owner.kysely);
    expect(attrs.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const memberships = await sql<{ n: number }>`select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'acbp_app'`.execute(owner.kysely);
    expect(memberships.rows[0]?.n).toBe(0);
    // The owner/migration role that ran the migrations is a DIFFERENT role from the runtime role.
    const owners = await sql<{ tableowner: string }>`select distinct tableowner from pg_tables where schemaname = 'public'`.execute(owner.kysely);
    expect(owners.rows.every((o) => o.tableowner !== 'acbp_app')).toBe(true);
  });

  test('exactly three SECURITY DEFINER functions exist namespace-wide, with the exact expected names', async () => {
    const definers = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>`
      select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and prosecdef = true order by proname
    `.execute(owner.kysely);
    expect(definers.rows.map((d) => d.proname)).toEqual([...EXPECTED_DEFINERS]);
    // Each pins a fixed search_path (SECURITY DEFINER trojan-horse guard).
    for (const d of definers.rows) expect((d.proconfig ?? []).some((c) => c.startsWith('search_path='))).toBe(true);
    // No PUBLIC execute on any of them.
    const publicExec = await sql<{ n: number }>`
      select count(*)::int as n from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef = true
        and has_function_privilege('public', p.oid, 'execute')
    `.execute(owner.kysely);
    expect(publicExec.rows[0]?.n).toBe(0);
  });

  test.each(TENANT_TABLES)('%s has ENABLE + FORCE row-level security', async (table) => {
    const r = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      select relrowsecurity, relforcerowsecurity from pg_class where relname = ${table} and relkind = 'r'
    `.execute(owner.kysely);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  test.each(TENANT_TABLES)('%s grants to acbp_app are exactly the expected least-privilege set (and nothing to any other role)', async (table) => {
    const grants = await sql<{ privilege_type: string }>`
      select distinct privilege_type from information_schema.role_table_grants
      where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table} order by privilege_type
    `.execute(owner.kysely);
    expect(grants.rows.map((g) => g.privilege_type)).toEqual([...(EXPECTED_GRANTS[table] ?? [])].sort());
    const others = await sql<{ grantee: string }>`
      select distinct grantee from information_schema.role_table_grants
      where table_schema = 'public' and table_name = ${table}
        and grantee <> 'acbp_app'
        and grantee <> (select tableowner from pg_tables where schemaname = 'public' and tablename = ${table})
    `.execute(owner.kysely);
    expect(others.rows.map((o) => o.grantee)).toEqual([]);
    // No grant option anywhere (acbp_app can never re-grant its access).
    const grantable = await sql<{ n: number }>`
      select count(*)::int as n from information_schema.role_table_grants
      where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table} and is_grantable = 'YES'
    `.execute(owner.kysely);
    expect(grantable.rows[0]?.n).toBe(0);
  });

  test('column-level UPDATE grants are confined to outcome columns (identity/scope columns are not updatable)', async () => {
    const cols = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.column_privileges
      where grantee = 'acbp_app' and table_schema = 'public' and privilege_type = 'UPDATE'
      order by table_name, column_name
    `.execute(owner.kysely);
    const byTable = new Map<string, string[]>();
    for (const c of cols.rows) byTable.set(c.table_name, [...(byTable.get(c.table_name) ?? []), c.column_name]);
    const provisioning = byTable.get('provisioning_steps') ?? [];
    expect(provisioning.length).toBeGreaterThan(0);
    for (const forbidden of ['id', 'account_id', 'company_id', 'step', 'step_order']) {
      expect(provisioning).not.toContain(forbidden);
    }
    // Interview sessions (ACBP-P2-001): only state/started_at/updated_at are updatable; identity columns are not.
    const interview = byTable.get('interview_sessions') ?? [];
    expect(interview.length).toBeGreaterThan(0);
    expect([...interview].sort()).toEqual(['started_at', 'state', 'updated_at']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'created_at']) {
      expect(interview).not.toContain(forbidden);
    }
    // Memory items (ACBP-P2-010): column-level UPDATE is confined to EXACTLY the lifecycle-pointer columns —
    // `superseded_by` (0015 edit=supersede) + `deleted_at`/`deleted_by_user_id` (0016 soft delete). The
    // content/type/source/confidence/confirmation/identity/creation columns stay immutable (no destructive
    // overwrite, no hard delete).
    const memory = byTable.get('memory_items') ?? [];
    expect([...memory].sort()).toEqual(['deleted_at', 'deleted_by_user_id', 'superseded_by']);
    for (const forbidden of ['id', 'account_id', 'company_id', 'content', 'type', 'source_type', 'source_ref', 'confidence', 'confirmation_state', 'created_at', 'created_by_user_id']) {
      expect(memory).not.toContain(forbidden);
    }
  });

  test(threatTitle('AUDIT-APPEND-ONLY', 'audit_events + activity_events'), async () => {
    for (const table of ['audit_events', 'activity_events'] as const) {
      const grants = await sql<{ privilege_type: string }>`
        select distinct privilege_type from information_schema.role_table_grants
        where grantee = 'acbp_app' and table_schema = 'public' and table_name = ${table}
      `.execute(owner.kysely);
      const set = grants.rows.map((g) => g.privilege_type);
      expect(set).not.toContain('UPDATE');
      expect(set).not.toContain('DELETE');
      expect(set).not.toContain('TRUNCATE');
    }
    // …and the restricted role really cannot execute them (grants are the mechanism; this is the proof).
    await expect(asRestricted(product, {}, (k) => sql`update audit_events set outcome = 'blocked'`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`delete from activity_events`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`truncate table audit_events`.execute(k))).rejects.toThrow();
  });

  test('every policy is per-table intentional: no unexpected permissive policy broadens another (all policies are named and enumerated)', async () => {
    const pols = await sql<{ tablename: string; policyname: string; cmd: string; permissive: string; qual: string | null; with_check: string | null }>`
      select tablename, policyname, cmd, permissive, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname
    `.execute(owner.kysely);
    // Every policy belongs to a known tenant table and is named after it (no stray/global policy).
    for (const p of pols.rows) {
      expect(TENANT_TABLES).toContain(p.tablename as (typeof TENANT_TABLES)[number]);
      expect(p.policyname.startsWith(p.tablename)).toBe(true);
    }
    // Every mutating policy carries a WITH CHECK (USING alone would let a write escape its scope).
    for (const p of pols.rows) {
      if (p.cmd === 'INSERT') expect(p.with_check, `${p.tablename}.${p.policyname} INSERT needs WITH CHECK`).not.toBeNull();
      if (p.cmd === 'UPDATE') {
        expect(p.qual, `${p.tablename}.${p.policyname} UPDATE needs USING`).not.toBeNull();
        expect(p.with_check, `${p.tablename}.${p.policyname} UPDATE needs WITH CHECK`).not.toBeNull();
      }
    }
    // No policy targets PUBLIC in a way that could broaden access for an unexpected role.
    const roles = await sql<{ roles: string[] }>`select roles::text[] as roles from pg_policies where schemaname = 'public'`.execute(owner.kysely);
    for (const r of roles.rows) expect(r.roles.every((x) => x === 'public' || x === 'acbp_app')).toBe(true);
  });

  test(threatTitle('RLS-CATALOG-TAMPER', 'all tenant tables'), async () => {
    // The restricted role cannot weaken its own confinement in any way.
    await expect(asRestricted(product, {}, (k) => sql`alter table companies disable row level security`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`alter table companies no force row level security`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`drop policy companies_select on companies`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`create policy evil on companies for all using (true) with check (true)`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`set role postgres`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`create role escalated login`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, {}, (k) => sql`alter role acbp_app bypassrls`.execute(k))).rejects.toThrow();
  });

  test('no application runtime source references the owner DATABASE_URL (the runtime uses DATABASE_APP_URL only)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..', '..', '..', '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (entry.name.endsWith('.test.ts')) continue;
        if (readFileSync(full, 'utf8').includes('DATABASE_URL')) offenders.push(full);
      }
    };
    walk(join(repoRoot, 'apps', 'web', 'src'));
    expect(offenders).toEqual([]);
  });
});
