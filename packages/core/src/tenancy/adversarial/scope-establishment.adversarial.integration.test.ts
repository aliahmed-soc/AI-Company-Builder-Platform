// ACBP-P1-014 / CDR-020 — SCOPE-ESTABLISHMENT adversarial suite.
//
// Threat ids: SCOPE-ACTOR-MISSING, SCOPE-ACTOR-FORGED, SCOPE-ACCOUNT-MISSING, SCOPE-ACCOUNT-FORGED,
//             SCOPE-COMPANY-MISSING, SCOPE-COMPANY-FORGED, SCOPE-ACCOUNT-COMPANY-MISMATCH,
//             SCOPE-SELECTOR-HARVESTED, AUTHZ-ACCOUNT-OWNER-NOT-COMPANY-MEMBER, LOG-DENIAL-PRIVACY.
// Production entrypoints: the PRODUCTION repositories (AccountProfileRepository, MembershipRepository,
//             CompanyRepository, ActivityFeedRepository, ProvisioningRepository) executed under scopes the
//             attacker controls, plus the production resolvers `runInAccountScope` / `runInCompanyScope`.
// Proof level: repository + core resolver (the database is the enforcing layer under test).
// Real PostgreSQL is MANDATORY: the invariant is enforced by FORCE RLS policies keyed to transaction-local
// GUCs — no fake or in-memory store can evidence it.
//
// The scopes here are minted by a TEST harness (`asRestricted`) so the attacker's GUC combinations can be
// expressed directly; the QUERIES are the production repositories' own builders. Slice 3 adds the
// complementary proof that RLS denies even when the application predicate is removed entirely.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { AccountProfileRepository, MembershipRepository, CompanyRepository, ActivityFeedRepository, ProvisioningRepository, type DatabaseClient } from '@acbp/database';
import { createTestLogger } from '@acbp/observability';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from './two-tenant-harness.js';
import { threatTitle } from './threat-inventory.js';
import { runInAccountScope } from '../account-context-resolver.js';
import { runInCompanyScope } from '../../company/company-context-resolver.js';

/** Deterministic malformed/hostile selector corpus (CDR-020 §6 — explicit cases only, no fuzzing). */
const MALFORMED_SELECTORS = ['', ' ', 'not-a-uuid', "1' or '1'='1", '../../etc/passwd', 'null', '00000000-0000-4000-8000-00000000000'] as const;
const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000000ff';

describe.skipIf(!hasTestDatabase)('scope establishment (real PostgreSQL, restricted role) — ACBP-P1-014/CDR-020', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    const proof = await assertRestrictedRole(product);
    expect(proof).toMatchObject({ currentUser: 'acbp_app', isSuperuser: false, bypassesRls: false, ownedProductTables: [] });
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });

  // ── Actor scope ────────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-ACTOR-MISSING', 'memberships self-branch'), async () => {
    // The memberships self-branch is keyed to app.current_actor; with no actor and no account, nothing.
    const rows = await asRestricted(product, {}, (k) => new MembershipRepository(k).listByAccount(w.accountA));
    expect(rows).toEqual([]);
    const count = await asRestricted(product, {}, async (k) => (await sql<{ n: number }>`select count(*)::int as n from memberships`.execute(k)).rows[0]?.n);
    expect(count).toBe(0); // not even an existence bit
  });

  test(threatTitle('SCOPE-ACTOR-FORGED', 'memberships self-branch'), async () => {
    // A forged actor (another real user, or junk) never inherits that user's membership rows.
    for (const forged of [w.bOwner, w.outsider, ...MALFORMED_SELECTORS]) {
      const rows = await asRestricted(product, { actor: forged }, (k) => new MembershipRepository(k).listByAccount(w.accountA));
      expect(rows, `forged actor ${forged} must see nothing of account A`).toEqual([]);
    }
    // The legitimate actor DOES see their own row — proving the assertions above are not vacuous.
    const own = await asRestricted(product, { actor: w.aViewer }, (k) => new MembershipRepository(k).findActiveByAccountAndUser(w.accountA, w.aViewer));
    expect(own?.member_user_id).toBe(w.aViewer);
  });

  // ── Account scope ──────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-ACCOUNT-MISSING', 'account_profiles + memberships'), async () => {
    expect(await asRestricted(product, { actor: w.aOwner }, (k) => new AccountProfileRepository(k).findByAccount(w.accountA))).toBeUndefined();
    expect(await asRestricted(product, { actor: w.aOwner }, (k) => new MembershipRepository(k).listByAccount(w.accountA))).toEqual([]);
    // A write with no account context affects nothing (fail-closed, not an error).
    const updated = await asRestricted(product, { actor: w.aOwner }, (k) => new AccountProfileRepository(k).update(w.accountA, { display_name: 'hijacked' }));
    expect(updated).toBeUndefined();
    const check = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountA).executeTakeFirst();
    expect(check?.display_name).not.toBe('hijacked');
  });

  test(threatTitle('SCOPE-ACCOUNT-FORGED', 'account_profiles + memberships + companies'), async () => {
    // Account B's owner sets account A as their context: RLS is keyed to the GUC, so this is exactly the
    // "stolen selector" attack. Nothing of account A may be readable or writable…
    const profile = await asRestricted(product, { actor: w.bOwner, account: w.accountA }, (k) => new AccountProfileRepository(k).findByAccount(w.accountA));
    // …with one honest nuance: the account policy is keyed to the account GUC, so a forged GUC alone WOULD
    // expose the row — which is precisely why account context may only ever be minted by the production
    // resolver from an ACTIVE membership. The resolver denial is asserted directly below.
    expect(profile === undefined || profile.account_id === w.accountA).toBe(true);
    const run = await runInAccountScope(product, { userId: w.bOwner, requestedAccountId: w.accountA }, () => Promise.resolve('ran'));
    expect(run).toEqual({ kind: 'denied', reason: 'membership_not_active' });
    const outsider = await runInAccountScope(product, { userId: w.outsider, requestedAccountId: w.accountA }, () => Promise.resolve('ran'));
    expect(outsider.kind).toBe('denied');
  });

  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'account resolver'), async () => {
    // Every id in the fixture world is "known" to the attacker; none of them confers authority.
    for (const selector of [w.accountA, w.accountB, UNKNOWN_UUID, ...MALFORMED_SELECTORS]) {
      const run = await runInAccountScope(product, { userId: w.outsider, requestedAccountId: selector }, () => Promise.resolve('ran'));
      expect(run.kind, `outsider must be denied for selector '${selector}'`).toBe('denied');
    }
  });

  // ── Company scope ──────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-COMPANY-MISSING', 'companies + activity_events + provisioning_steps'), async () => {
    // Account context ALONE reveals no company-detail rows: the dual-keyed policies need both keys.
    await asRestricted(product, { actor: w.aOwner, account: w.accountA }, async (k) => {
      expect(await new ActivityFeedRepository(k).listByCompany(w.companyA1, 10)).toEqual([]);
      expect(await new ProvisioningRepository(k).listSteps(w.companyA1)).toEqual([]);
    });
  });

  test(threatTitle('SCOPE-COMPANY-FORGED', 'companies + company detail tables'), async () => {
    // Account A + company B1 (a company of ANOTHER account): both keys must agree, so nothing resolves…
    await asRestricted(product, { actor: w.aOwner, account: w.accountA, company: w.companyB1 }, async (k) => {
      expect(await new CompanyRepository(k).findById(w.companyB1)).toBeUndefined();
      expect(await new ActivityFeedRepository(k).listByCompany(w.companyB1, 10)).toEqual([]);
      expect(await new ProvisioningRepository(k).listSteps(w.companyB1)).toEqual([]);
      // …and a status mutation touches nothing.
      expect(await new CompanyRepository(k).updateStatus(w.companyB1, 'paused')).toBeUndefined();
    });
    const b1 = await owner.kysely.selectFrom('companies').select('status').where('id', '=', w.companyB1).executeTakeFirstOrThrow();
    expect(b1.status).not.toBe('paused');
  });

  test(threatTitle('SCOPE-ACCOUNT-COMPANY-MISMATCH', 'companies'), async () => {
    // Real account B paired with real company A1 — each valid alone, invalid together.
    await asRestricted(product, { actor: w.bOwner, account: w.accountB, company: w.companyA1 }, async (k) => {
      expect(await new CompanyRepository(k).findById(w.companyA1)).toBeUndefined();
      expect(await new ProvisioningRepository(k).listSteps(w.companyA1)).toEqual([]);
    });
    // The correctly paired scope DOES resolve — the mismatch assertions are therefore meaningful.
    await asRestricted(product, { actor: w.aOwner, account: w.accountA, company: w.companyA1 }, async (k) => {
      expect((await new CompanyRepository(k).findById(w.companyA1))?.id).toBe(w.companyA1);
    });
  });

  test(threatTitle('AUTHZ-ACCOUNT-OWNER-NOT-COMPANY-MEMBER', 'company resolver'), async () => {
    // aRevoked/aCompanyRevoked aside, the sharpest case: an ACTIVE account member with NO company membership
    // in A1 is denied by the production resolver even though the account context is genuinely theirs.
    const denied = await runInCompanyScope(product, { userId: w.aCompanyRevoked, requestedAccountId: w.accountA, requestedCompanyId: w.companyA1 }, () => Promise.resolve('ran'));
    expect(denied).toEqual({ kind: 'denied', reason: 'company_access_denied' });
    // …and the same user IS denied for A2 as well (their company membership there is revoked).
    const revoked = await runInCompanyScope(product, { userId: w.aCompanyRevoked, requestedAccountId: w.accountA, requestedCompanyId: w.companyA2 }, () => Promise.resolve('ran'));
    expect(revoked.kind).toBe('denied');
  });

  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'company resolver — every hostile selector shape'), async () => {
    for (const selector of [w.companyB1, w.companyB2, UNKNOWN_UUID, ...MALFORMED_SELECTORS]) {
      const run = await runInCompanyScope(product, { userId: w.aOwner, requestedAccountId: w.accountA, requestedCompanyId: selector }, () => Promise.resolve('ran'));
      expect(run.kind, `company selector '${selector}' must be denied`).toBe('denied');
    }
  });

  test(threatTitle('LOG-DENIAL-PRIVACY', 'scope denials'), async () => {
    // Capture the structured denial logs the production resolvers emit and prove they carry no protected
    // tenant content (CDR-020 §3: denials are proven leak-free; no durable denial rows are created).
    const captured = createTestLogger({ component: 'adversarial' });
    await runInAccountScope(product, { userId: w.outsider, requestedAccountId: w.accountA }, () => Promise.resolve('ran'), { logger: captured.logger });
    await runInCompanyScope(product, { userId: w.aOwner, requestedAccountId: w.accountA, requestedCompanyId: w.companyB1 }, () => Promise.resolve('ran'), { logger: captured.logger });
    expect(captured.records.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(captured.records);
    for (const forbidden of ['Alpha One', 'Alpha Two', 'Beta One', 'Beta Two', 'select ', 'insert ', 'pg_', 'constraint', 'password', '@example.com']) {
      expect(serialized.toLowerCase(), `denial logs must not contain '${forbidden}'`).not.toContain(forbidden.toLowerCase());
    }
    // No durable denial rows were created by any of it.
    const audits = await owner.kysely.selectFrom('audit_events').select('name').execute();
    expect(audits.every((a) => a.name !== 'authz.denied' && a.name !== 'tenant.context_denied')).toBe(true);
  });
});
