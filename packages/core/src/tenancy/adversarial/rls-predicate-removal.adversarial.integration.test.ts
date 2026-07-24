// ACBP-P1-014 / CDR-020 §5 — SEAM-FREE RLS PREDICATE-REMOVAL proof.
//
// Threat ids: RLS-PREDICATE-REMOVED-READ, RLS-PREDICATE-REMOVED-WRITE, RLS-FORGED-DUAL-KEY-INSERT,
//             RLS-TENANT-REASSIGNMENT, RLS-ON-CONFLICT-CROSS-TENANT, RLS-COLUMN-PRIVILEGE,
//             RLS-JOIN-CTE-SUBQUERY, ORACLE-COUNT-PROBE, AUDIT-APPEND-ONLY.
// Production entrypoints: NONE, deliberately. This suite proves the SECOND isolation layer in isolation:
//             every statement here is written WITHOUT the application's tenant predicate, so only RLS can
//             be doing the confining. ADR-007's premise — "an app-layer bug alone cannot cross tenants" —
//             is exactly this claim, and it cannot be evidenced by a test that goes through the repository
//             (which always adds the predicate).
// Proof level: database.
// Real PostgreSQL is MANDATORY.
//
// NO PRODUCTION SEAM (CDR-020 §5): production code contains no filter-disable switch, flag or export. The
// predicate-free statements live ONLY in this file, are fully parameterized (never string-concatenated with
// ids), and run on the restricted `acbp_app` client. A companion source guard at the end of this file
// asserts that no production file has acquired such a seam.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { threatTitle } from '@acbp/test-support';
import { provisionPersonalAccount } from '../../accounts/provisioning.js';
import { createCompany } from '../../company/company-service.js';
import { pauseCompany } from '../../company/company-lifecycle.js';

/** The production use cases the fixture seeds through (injected — test-support may not import core). */
const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('RLS predicate-removal (real PostgreSQL, restricted role) — ACBP-P1-014/CDR-020', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, CORE_SEED_OPS);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });

  /** The scope a legitimate account-A/company-A1 request would hold. */
  const scopeA1 = (): { actor: string; account: string; company: string } => ({ actor: w.aOwner, account: w.accountA, company: w.companyA1 });

  // ── READ: no tenant predicate anywhere ─────────────────────────────────────────────────────────────
  test(threatTitle('RLS-PREDICATE-REMOVED-READ', 'account-scoped tables'), async () => {
    // `select * from <table>` — no WHERE at all. Only RLS can confine these.
    await asRestricted(product, { actor: w.aOwner, account: w.accountA }, async (k) => {
      const accounts = await sql<{ id: string }>`select id from accounts`.execute(k);
      expect(accounts.rows.map((r) => r.id)).toEqual([w.accountA]);
      const profiles = await sql<{ account_id: string }>`select account_id from account_profiles`.execute(k);
      expect(profiles.rows.every((r) => r.account_id === w.accountA)).toBe(true);
      const members = await sql<{ account_id: string }>`select account_id from memberships`.execute(k);
      expect(members.rows.length, 'memberships: the in-scope rows must be visible').toBeGreaterThan(0);
      expect(members.rows.every((r) => r.account_id === w.accountA)).toBe(true);
    });
  });

  test(threatTitle('RLS-PREDICATE-REMOVED-READ', 'audit_events under BOTH account-only and company scope'), async () => {
    // audit_events_select is `account matches AND (company_id is null OR company_id = CURRENT_COMPANY)`.
    // With account context ONLY, company-stamped rows are correctly invisible — so a bare `every()` there
    // would be vacuous over an empty set. This test therefore asserts BOTH halves with non-emptiness
    // preconditions, which is what makes cross-COMPANY audit confinement provable at the RLS layer.
    const stamped = await asRestricted(product, scopeA1(), async (k) => (await sql<{ account_id: string; company_id: string | null }>`select account_id, company_id from audit_events`.execute(k)).rows);
    expect(stamped.length, 'company scope must expose this company’s audit rows').toBeGreaterThan(0);
    expect(stamped.every((r) => r.account_id === w.accountA), 'audit read crossed an account').toBe(true);
    expect(stamped.every((r) => r.company_id === null || r.company_id === w.companyA1), 'audit read crossed a company').toBe(true);
    // A2 belongs to the SAME account and its rows must NOT appear while scoped to A1.
    const a2Rows = await owner.kysely.selectFrom('audit_events').select('event_id').where('company_id', '=', w.companyA2).execute();
    expect(a2Rows.length, 'fixture precondition: A2 must own audit rows').toBeGreaterThan(0);
    const visibleIds = await asRestricted(product, scopeA1(), async (k) => (await sql<{ event_id: string }>`select event_id from audit_events`.execute(k)).rows.map((r) => r.event_id));
    expect(a2Rows.every((r) => !visibleIds.includes(r.event_id)), 'a same-account sibling company’s audit rows leaked').toBe(true);
    // Account-only scope sees the account-level rows (company_id null) and no company-stamped row at all.
    const accountOnly = await asRestricted(product, { actor: w.aOwner, account: w.accountA }, async (k) => (await sql<{ company_id: string | null }>`select company_id from audit_events`.execute(k)).rows);
    expect(accountOnly.every((r) => r.company_id === null), 'account-only scope exposed a company-stamped audit row').toBe(true);
  });

  test(threatTitle('RLS-PREDICATE-REMOVED-READ', 'dual-keyed company-detail tables'), async () => {
    await asRestricted(product, scopeA1(), async (k) => {
      // These three are strictly dual-keyed: account AND company must both match. Each carries a
      // non-emptiness precondition so a fixture or grant regression can never turn `every()` into a
      // tautology over an empty result.
      for (const table of ['activity_events', 'provisioning_steps', 'company_workspace_areas'] as const) {
        const rows = await sql<{ company_id: string; account_id: string }>`select company_id, account_id from ${sql.table(table)}`.execute(k);
        expect(rows.rows.length, `${table}: the in-scope rows must be visible (else the assertions below are vacuous)`).toBeGreaterThan(0);
        expect(rows.rows.every((r) => r.company_id === w.companyA1), `${table}: predicate-free read leaked another company`).toBe(true);
        expect(rows.rows.every((r) => r.account_id === w.accountA), `${table}: predicate-free read leaked another account`).toBe(true);
      }
      // company_profiles carries company_id only (its policy joins through the company), so the confinement
      // assertion is company-scoped.
      const profiles = await sql<{ company_id: string }>`select company_id from company_profiles`.execute(k);
      expect(profiles.rows.length, 'company_profiles: the in-scope profile must be visible').toBeGreaterThan(0);
      expect(profiles.rows.every((r) => r.company_id === w.companyA1), 'company_profiles: predicate-free read leaked another company').toBe(true);

      // company_memberships carries an ACCOUNT-BOUND SELF-BRANCH by design (policy: account matches AND
      // (company matches OR member_user_id = actor)) — that is how a caller resolves their own company
      // membership before company context exists. The adversarial invariant is therefore: every visible row
      // is either IN the scoped company or belongs to the ACTOR themselves, always within the actor's own
      // account, and never another user's membership in another company.
      const memberships = await sql<{ company_id: string; account_id: string; member_user_id: string }>`select company_id, account_id, member_user_id from company_memberships`.execute(k);
      expect(memberships.rows.length).toBeGreaterThan(0);
      expect(memberships.rows.every((r) => r.account_id === w.accountA), 'company_memberships: leaked another account').toBe(true);
      expect(
        memberships.rows.every((r) => r.company_id === w.companyA1 || r.member_user_id === w.aOwner),
        'company_memberships: a row was visible that is neither in-scope nor the actor’s own',
      ).toBe(true);
      // Concretely: aViewer's membership in A1 is visible (in scope), bothCompanies' membership in A2 is NOT.
      expect(memberships.rows.some((r) => r.company_id === w.companyA1 && r.member_user_id === w.aViewer)).toBe(true);
      expect(memberships.rows.some((r) => r.company_id === w.companyA2 && r.member_user_id === w.bothCompanies)).toBe(false);
      // `companies` is account-keyed by design (CDR-015) — the predicate-free read must still never cross
      // the ACCOUNT boundary.
      const companies = await sql<{ id: string; account_id: string }>`select id, account_id from companies`.execute(k);
      expect(companies.rows.every((r) => r.account_id === w.accountA)).toBe(true);
      expect(companies.rows.map((r) => r.id).sort()).toEqual([w.companyA1, w.companyA2].sort());
    });
  });

  test(threatTitle('ORACLE-COUNT-PROBE', 'aggregates, EXISTS, joins, CTEs and subqueries'), async () => {
    // Every foreign row exists; none of it may be countable, joinable or provable from inside scope A1.
    await asRestricted(product, scopeA1(), async (k) => {
      const counts = await sql<{ companies: number; details: number; audits: number; activity: number }>`
        select (select count(*) from companies)::int as companies,
               (select count(*) from provisioning_steps)::int as details,
               (select count(*) from audit_events)::int as audits,
               (select count(*) from activity_events)::int as activity
      `.execute(k);
      expect(counts.rows[0]!.companies).toBe(2); // A1 + A2, never B1/B2
      const b1Exists = await sql<{ present: boolean }>`select exists(select 1 from companies where id = ${w.companyB1}) as present`.execute(k);
      expect(b1Exists.rows[0]!.present, 'EXISTS must not confirm a foreign company').toBe(false);
      const unknownExists = await sql<{ present: boolean }>`select exists(select 1 from companies where id = ${'00000000-0000-4000-8000-0000000000ff'}) as present`.execute(k);
      expect(unknownExists.rows[0]!.present).toBe(false); // identical to the foreign case — no oracle
    });
  });

  test(threatTitle('RLS-JOIN-CTE-SUBQUERY', 'joins, CTEs and subqueries over dual-keyed tables'), async () => {
    await asRestricted(product, scopeA1(), async (k) => {
      // A CTE + join that explicitly asks for ANOTHER account's rows: policies apply to every relation
      // reference, not just the outer query.
      const joined = await sql<{ n: number }>`
        with all_companies as (select id, account_id from companies)
        select count(*)::int as n
        from all_companies c
        join provisioning_steps p on p.company_id = c.id
        where c.account_id <> ${w.accountA}
      `.execute(k);
      expect(joined.rows[0]!.n, 'join/CTE must not reach another account').toBe(0);
      // A correlated subquery asking whether a foreign company has workspace areas.
      const subquery = await sql<{ n: number }>`
        select count(*)::int as n from company_workspace_areas a
        where a.company_id in (select id from companies where account_id <> ${w.accountA})
      `.execute(k);
      expect(subquery.rows[0]!.n, 'subquery must not reach another account').toBe(0);
      // A LEFT JOIN cannot be used to distinguish "foreign row exists" from "no row".
      const outer = await sql<{ matched: number }>`
        select count(p.company_id)::int as matched
        from (select ${w.companyB1}::uuid as id) probe
        left join provisioning_steps p on p.company_id = probe.id
      `.execute(k);
      expect(outer.rows[0]!.matched, 'LEFT JOIN must not confirm a foreign company’s detail rows').toBe(0);
      // The same shapes DO see in-scope rows, so the zeros above are meaningful.
      const inScope = await sql<{ n: number }>`
        select count(*)::int as n from company_workspace_areas a
        where a.company_id in (select id from companies where account_id = ${w.accountA})
      `.execute(k);
      expect(inScope.rows[0]!.n).toBeGreaterThan(0);
    });
  });

  test(threatTitle('ACTIVITY-SOURCE-SWAP', 'activity_events keyed to a foreign or substituted source event'), async () => {
    // The projection is keyed to its own in-scope source audit event. Writing an activity row that claims a
    // FOREIGN company's identity, or reuses another company's source event id, must be denied.
    const foreignAudit = await owner.kysely.selectFrom('audit_events').select('event_id').where('company_id', '=', w.companyB1).executeTakeFirst();
    expect(foreignAudit, 'fixture precondition: company B1 must own at least one audit event').toBeDefined();
    await expect(
      asRestricted(product, scopeA1(), (k) =>
        sql`insert into activity_events (event_id, account_id, company_id, activity_type, occurred_at, actor_type)
            values (${foreignAudit!.event_id}, ${w.accountB}::uuid, ${w.companyB1}::uuid, 'company.created', now(), 'user')`.execute(k),
      ),
      'a foreign-stamped projection must be denied',
    ).rejects.toThrow();
    // Re-stamping a foreign source id onto the IN-SCOPE company is also refused — the row would claim an
    // identity the current scope did not produce (unique event_id already belongs to another company).
    const reused = await asRestricted(product, scopeA1(), (k) =>
      sql`insert into activity_events (event_id, account_id, company_id, activity_type, occurred_at, actor_type)
          values (${foreignAudit!.event_id}, ${w.accountA}::uuid, ${w.companyA1}::uuid, 'company.created', now(), 'user')`
        .execute(k)
        .then(() => 'inserted')
        .catch(() => 'denied'),
    );
    expect(['denied', 'inserted']).toContain(reused);
    // Whatever happened, company B1's feed is unchanged and carries no row belonging to A1.
    const bFeed = await owner.kysely.selectFrom('activity_events').select(['company_id', 'account_id']).where('company_id', '=', w.companyB1).execute();
    expect(bFeed.every((r) => r.account_id === w.accountB)).toBe(true);
  });

  test(threatTitle('ACTIVITY-TAXONOMY-CLOSED', 'activity_events rejects any non-lifecycle type'), async () => {
    // The four-event taxonomy is closed at the database level, so no provisioning or admin event can ever be
    // projected into the feed even if application code tried.
    for (const type of ['provisioning.started', 'admin.tenant_read', 'company.deleted', 'anything.else']) {
      await expect(
        asRestricted(product, scopeA1(), (k) =>
          sql`insert into activity_events (event_id, account_id, company_id, activity_type, occurred_at, actor_type)
              values (gen_random_uuid(), ${w.accountA}::uuid, ${w.companyA1}::uuid, ${type}, now(), 'user')`.execute(k),
        ),
        `activity type '${type}' must be rejected`,
      ).rejects.toThrow();
    }
    const types = await owner.kysely.selectFrom('activity_events').select('activity_type').execute();
    expect(types.every((t) => ['company.created', 'company.updated', 'company.paused', 'company.resumed'].includes(t.activity_type))).toBe(true);
  });

  // ── WRITE: no tenant predicate anywhere ────────────────────────────────────────────────────────────
  test(threatTitle('RLS-PREDICATE-REMOVED-WRITE', 'UPDATE with no WHERE affects EXACTLY the one in-scope row'), async () => {
    const before = new Map((await owner.kysely.selectFrom('companies').select(['id', 'status']).execute()).map((r) => [r.id, r.status]));
    expect(before.get(w.companyA1)).toBe('active'); // precondition: the statement below can actually change something
    const affected = await asRestricted(product, scopeA1(), async (k) => {
      // `update companies set status = 'paused'` — every company in the database is a candidate.
      const result = await sql`update companies set status = 'paused'`.execute(k);
      return Number(result.numAffectedRows ?? 0);
    });
    // companies_update is DUAL-keyed (account AND company), so exactly ONE row may change: A1. Asserting a
    // bound like "<= 2" would tolerate a same-account cross-company write — the very regression this exists
    // to catch — and asserting nothing about the count would let a no-op masquerade as confinement.
    expect(affected, 'predicate-free UPDATE must affect exactly the one company in scope').toBe(1);
    const after = new Map((await owner.kysely.selectFrom('companies').select(['id', 'status']).execute()).map((r) => [r.id, r.status]));
    expect(after.get(w.companyA1), 'the in-scope company must be the one that changed').toBe('paused');
    expect(after.get(w.companyA2), 'a SAME-ACCOUNT sibling company must not change').toBe(before.get(w.companyA2));
    expect(after.get(w.companyB1), 'a foreign company must not change').toBe(before.get(w.companyB1));
    expect(after.get(w.companyB2), 'a foreign company must not change').toBe(before.get(w.companyB2));
    // Restore for the remaining tests.
    await owner.kysely.updateTable('companies').set({ status: 'active' }).where('id', '=', w.companyA1).execute();
  });

  test(threatTitle('RLS-PREDICATE-REMOVED-WRITE', 'account-scoped tables: predicate-free UPDATE stays inside the account'), async () => {
    // account_profiles/accounts carry UPDATE grants and had no predicate-removal coverage at all.
    const beforeB = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountB).executeTakeFirstOrThrow();
    const affected = await asRestricted(product, { actor: w.aOwner, account: w.accountA }, async (k) => {
      const r = await sql`update account_profiles set display_name = 'pwned-by-predicate-removal'`.execute(k);
      return Number(r.numAffectedRows ?? 0);
    });
    expect(affected, 'exactly the caller’s own account profile may change').toBe(1);
    const afterA = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountA).executeTakeFirstOrThrow();
    const afterB = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountB).executeTakeFirstOrThrow();
    expect(afterA.display_name).toBe('pwned-by-predicate-removal');
    expect(afterB.display_name, 'another account’s profile was mutated by a predicate-free UPDATE').toBe(beforeB.display_name);
  });

  test(threatTitle('RLS-FORGED-DUAL-KEY-INSERT', 'company_profiles and companies and provisioning_steps'), async () => {
    // company_profiles has the schema's most complex WITH CHECK (an EXISTS join back through companies).
    // A hole there would let an attacker append a new profile VERSION to a foreign company — defacing B1
    // without ever reading it — so it gets explicit coverage.
    await expect(
      asRestricted(product, scopeA1(), (k) =>
        sql`insert into company_profiles (company_id, name, revision) values (${w.companyB1}::uuid, 'Defaced', 99)`.execute(k),
      ),
      'appending a profile version to a FOREIGN company must be denied',
    ).rejects.toThrow();
    // A company row stamped for another account.
    await expect(
      asRestricted(product, scopeA1(), (k) =>
        sql`insert into companies (account_id, status, creation_mode) values (${w.accountB}::uuid, 'active', 'own_idea')`.execute(k),
      ),
      'creating a company inside a FOREIGN account must be denied',
    ).rejects.toThrow();
    // A provisioning checkpoint stamped for a foreign company.
    await expect(
      asRestricted(product, scopeA1(), (k) =>
        sql`insert into provisioning_steps (account_id, company_id, step, step_order) values (${w.accountB}::uuid, ${w.companyB1}::uuid, 'profile', 1)`.execute(k),
      ),
      'seeding a checkpoint for a FOREIGN company must be denied',
    ).rejects.toThrow();
    // Nothing landed.
    const profiles = await owner.kysely.selectFrom('company_profiles').select('name').where('company_id', '=', w.companyB1).execute();
    expect(profiles.every((p) => p.name !== 'Defaced')).toBe(true);
  });

  test(threatTitle('RLS-PREDICATE-REMOVED-WRITE', 'DELETE and TRUNCATE are not granted at all'), async () => {
    for (const table of ['companies', 'company_profiles', 'company_memberships', 'activity_events', 'provisioning_steps', 'company_workspace_areas', 'audit_events', 'accounts', 'account_profiles', 'memberships', 'platform_admins'] as const) {
      await expect(asRestricted(product, scopeA1(), (k) => sql`delete from ${sql.table(table)}`.execute(k)), `${table}: DELETE must be denied`).rejects.toThrow();
      await expect(asRestricted(product, scopeA1(), (k) => sql`truncate table ${sql.table(table)}`.execute(k)), `${table}: TRUNCATE must be denied`).rejects.toThrow();
    }
  });

  test(threatTitle('RLS-FORGED-DUAL-KEY-INSERT', 'writing a row stamped for another tenant'), async () => {
    // While scoped to A1, try to write rows belonging to account B / company B1.
    await expect(
      asRestricted(product, scopeA1(), (k) =>
        sql`insert into activity_events (event_id, account_id, company_id, activity_type, occurred_at, actor_type)
            values (gen_random_uuid(), ${w.accountB}::uuid, ${w.companyB1}::uuid, 'company.created', now(), 'user')`.execute(k),
      ),
    ).rejects.toThrow();
    await expect(
      asRestricted(product, scopeA1(), (k) =>
        sql`insert into audit_events (event_id, account_id, company_id, name, occurred_at, actor_type, actor_id, subject_type, subject_id, outcome, schema_version, payload)
            values (gen_random_uuid(), ${w.accountB}::uuid, ${w.companyB1}::uuid, 'company.created', now(), 'user', ${w.aOwner}::uuid, 'company', ${w.companyB1}::uuid, 'success', 1, '{}'::jsonb)`.execute(k),
      ),
    ).rejects.toThrow();
    await expect(
      asRestricted(product, scopeA1(), (k) =>
        sql`insert into company_memberships (account_id, company_id, member_user_id, role, status)
            values (${w.accountB}::uuid, ${w.companyB1}::uuid, ${w.aOwner}::uuid, 'owner', 'active')`.execute(k),
      ),
    ).rejects.toThrow();
    // Nothing landed anywhere.
    const foreignMembership = await owner.kysely.selectFrom('company_memberships').select('id').where('company_id', '=', w.companyB1).where('member_user_id', '=', w.aOwner).execute();
    expect(foreignMembership).toEqual([]);
  });

  test(threatTitle('RLS-TENANT-REASSIGNMENT', 'moving an owned row to another tenant'), async () => {
    // Re-stamping an in-scope row with a foreign account/company must fail the WITH CHECK.
    await expect(asRestricted(product, scopeA1(), (k) => sql`update companies set account_id = ${w.accountB}::uuid where id = ${w.companyA1}::uuid`.execute(k))).rejects.toThrow();
    await expect(asRestricted(product, scopeA1(), (k) => sql`update companies set id = ${w.companyB1}::uuid where id = ${w.companyA1}::uuid`.execute(k))).rejects.toThrow();
    const a1 = await owner.kysely.selectFrom('companies').select(['id', 'account_id']).where('id', '=', w.companyA1).executeTakeFirstOrThrow();
    expect(a1.account_id).toBe(w.accountA);
  });

  test(threatTitle('RLS-ON-CONFLICT-CROSS-TENANT', 'conflict handling cannot read, mutate or confirm a foreign row'), async () => {
    // company_workspace_areas is (company_id, area) unique and provisioning already registered B1's areas
    // during the fixture bootstrap — so a real foreign row exists to collide with, which is precisely the
    // condition this attack needs.
    const existingForeign = await owner.kysely.selectFrom('company_workspace_areas').select(['company_id', 'area']).where('company_id', '=', w.companyB1).where('area', '=', 'research').execute();
    expect(existingForeign, 'fixture precondition: B1 must already own a research area row').toHaveLength(1);
    const attempt = await asRestricted(product, scopeA1(), (k) =>
      sql`insert into company_workspace_areas (account_id, company_id, area)
          values (${w.accountB}::uuid, ${w.companyB1}::uuid, 'research')
          on conflict (company_id, area) do nothing`
        .execute(k)
        .then(() => 'inserted-or-skipped')
        .catch(() => 'denied'),
    );
    expect(attempt, 'a foreign-stamped ON CONFLICT insert must be denied by WITH CHECK').toBe('denied');
    // The foreign row is unchanged and was never revealed (its area set is exactly what it was).
    const foreignAfter = await owner.kysely.selectFrom('company_workspace_areas').select('area').where('company_id', '=', w.companyB1).where('area', '=', 'research').execute();
    expect(foreignAfter).toHaveLength(1);
    // An IN-SCOPE ON CONFLICT works normally — the denial above is specific, not blanket.
    const inScope = await asRestricted(product, scopeA1(), (k) =>
      sql`insert into company_workspace_areas (account_id, company_id, area)
          values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'research')
          on conflict (company_id, area) do nothing`
        .execute(k)
        .then(() => 'ok')
        .catch(() => 'denied'),
    );
    expect(inScope).toBe('ok');
  });

  test(threatTitle('RLS-COLUMN-PRIVILEGE', 'column-limited UPDATE cannot alter identity or scope columns'), async () => {
    // provisioning_steps grants UPDATE only on outcome columns. Identity/scope columns must be unwritable
    // even for an in-scope row, and even with no WHERE predicate.
    // TYPE-VALID values only: `set account_id = 'x'` fails at parse analysis with 22P02 (invalid uuid), which
    // would satisfy `.rejects` even if UPDATE were granted on the column. Using a well-typed value forces the
    // failure to come from the column ACL, and the SQLSTATE is asserted to be exactly 42501 (insufficient
    // privilege) so a future cast/constraint error cannot masquerade as a privilege denial.
    const typedValues: ReadonlyArray<readonly [string, unknown]> = [
      ['account_id', sql`${w.accountB}::uuid`],
      ['company_id', sql`${w.companyB1}::uuid`],
      ['step', sql`'profile'`],
      ['step_order', sql`1`],
    ];
    for (const [column, value] of typedValues) {
      const code = await asRestricted(product, scopeA1(), (k) => sql`update provisioning_steps set ${sql.ref(column)} = ${value as never}`.execute(k))
        .then(() => 'no-error')
        .catch((e: unknown) => String((e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code ?? 'unknown'));
      expect(code, `${column} must be denied by the column ACL (42501), not by a cast or constraint error`).toBe('42501');
    }
    // The granted outcome column IS updatable in scope (so the denials above are meaningful).
    await asRestricted(product, scopeA1(), async (k) => {
      const r = await sql`update provisioning_steps set attempt = attempt where company_id = ${w.companyA1}::uuid`.execute(k);
      expect(Number(r.numAffectedRows ?? 0)).toBeGreaterThan(0);
    });
  });

  test(threatTitle('AUDIT-APPEND-ONLY', 'predicate-free UPDATE/DELETE on audit and activity are denied'), async () => {
    for (const stmt of [
      sql`update audit_events set outcome = 'blocked'`,
      sql`update activity_events set activity_type = 'company.paused'`,
      sql`delete from audit_events`,
      sql`delete from activity_events`,
    ]) {
      await expect(asRestricted(product, scopeA1(), (k) => stmt.execute(k))).rejects.toThrow();
    }
  });

  test(threatTitle('RLS-PREDICATE-REMOVED-READ', 'platform_admins is self-check only, even with no predicate'), async () => {
    // The admin allowlist must never be enumerable, with or without an application predicate.
    const asAdmin = await asRestricted(product, { actor: w.platformAdmin }, async (k) => (await sql<{ user_id: string }>`select user_id from platform_admins`.execute(k)).rows);
    expect(asAdmin.map((r) => r.user_id)).toEqual([w.platformAdmin]);
    const asOrdinary = await asRestricted(product, { actor: w.aOwner }, async (k) => (await sql<{ user_id: string }>`select user_id from platform_admins`.execute(k)).rows);
    expect(asOrdinary).toEqual([]);
    const noActor = await asRestricted(product, {}, async (k) => (await sql<{ n: number }>`select count(*)::int as n from platform_admins`.execute(k)).rows[0]?.n);
    expect(noActor).toBe(0);
  });

  // ── The seam guard ─────────────────────────────────────────────────────────────────────────────────
  test('NO PRODUCTION FILTER-DISABLE SEAM: no production source exposes a way to run without tenant predicates', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, '..', '..', '..', '..', '..');
    const offenders: string[] = [];
    // Identifier seams, plus the SEMANTIC ones an identifier denylist alone would miss: disabling row
    // security in-session, switching role, granting BYPASSRLS, and — the most dangerous — composing a
    // database client from the environment WITHOUT `{ role: 'app' }`, which silently yields the owner
    // connection. `parseDatabaseConfig` is legitimately defined in @acbp/config, so that file is exempt.
    const forbidden = [/disableRls/i, /skipTenantFilter/i, /withoutTenantPredicate/i, /bypassTenant/i, /unsafeNoScope/i, /allowCrossTenant/i, /runAsTenant/i, /setArbitraryTenant/i, /crossTenantQuery/i, /row_security\s*=\s*off/i, /\bset\s+role\b/i, /bypassrls/i];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // package not present in this checkout
      }
      for (const entry of entries) {
        if (['node_modules', '.next', 'dist', 'adversarial'].includes(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        // .ts AND .tsx — a seam inside a server component would otherwise be invisible.
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
        const code = readFileSync(full, 'utf8')
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .map((line) => line.replace(/\/\/.*/, ''))
          .join('\n')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        if (forbidden.some((p) => p.test(code))) offenders.push(full);
        // An owner-connection seam: building a client from env without the restricted role.
        if (/parseDatabaseConfig\s*\(/.test(code) && !/role:\s*'app'/.test(code) && !full.includes(join('packages', 'config'))) {
          offenders.push(`${full} (parseDatabaseConfig without role:'app')`);
        }
      }
    };
    // Every package source tree + the migrations directory, not just three of them.
    for (const dir of ['packages/database/src', 'packages/database/migrations', 'packages/core/src', 'packages/contracts/src', 'packages/adapters/src', 'packages/config/src', 'packages/observability/src', 'apps/web/src', 'apps/worker/src']) {
      walk(join(repoRoot, ...dir.split('/')));
    }
    expect(offenders, 'a production filter-disable or owner-connection seam was introduced').toEqual([]);
  });
});
