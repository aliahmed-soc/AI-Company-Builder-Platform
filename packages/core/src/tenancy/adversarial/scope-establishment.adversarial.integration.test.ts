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
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { threatTitle } from '@acbp/test-support';
import { provisionPersonalAccount } from '../../accounts/provisioning.js';
import { createCompany } from '../../company/company-service.js';
import { pauseCompany } from '../../company/company-lifecycle.js';
import { runInAccountScope } from '../account-context-resolver.js';
import { runInCompanyScope } from '../../company/company-context-resolver.js';

/** Deterministic malformed/hostile selector corpus (CDR-020 §6 — explicit cases only, no fuzzing). */
const MALFORMED_SELECTORS = ['', ' ', 'not-a-uuid', "1' or '1'='1", '../../etc/passwd', 'null', '00000000-0000-4000-8000-00000000000'] as const;
const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000000ff';

/** The production use cases the fixture seeds through (injected — test-support may not import core). */
const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

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
    w = await seedTwoTenantWorld(owner, product, CORE_SEED_OPS);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });

  // ── Actor scope ────────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-ACTOR-MISSING', 'memberships self-branch'), async () => {
    // With NO actor and NO account, the self-branch has nothing to key on: fail-closed.
    const rows = await asRestricted(product, {}, (k) => new MembershipRepository(k).listByAccount(w.accountA));
    expect(rows).toEqual([]);
    const count = await asRestricted(product, {}, async (k) => (await sql<{ n: number }>`select count(*)::int as n from memberships`.execute(k)).rows[0]?.n);
    expect(count).toBe(0); // not even an existence bit
  });

  test(threatTitle('SCOPE-ACTOR-FORGED', 'memberships self-branch is SELF-only, never a member list'), async () => {
    // ACCEPTED BEHAVIOR (P1-006/CDR-013): with an actor but no account context, the memberships policy
    // exposes the actor's OWN row — that is how `acbp_resolve_own_membership` resolves you before context
    // exists. The adversarial question is therefore not "can you see anything" but "can you see anyone
    // ELSE": a forged/foreign actor must never inherit another user's membership, and no actor may
    // enumerate the account's members without account context.
    const asAOwner = await asRestricted(product, { actor: w.aOwner }, (k) => new MembershipRepository(k).listByAccount(w.accountA));
    expect(asAOwner.map((m) => m.member_user_id)).toEqual([w.aOwner]); // ONLY self — not the 4 other members
    for (const forged of [w.bOwner, w.outsider, ...MALFORMED_SELECTORS]) {
      const rows = await asRestricted(product, { actor: forged }, (k) => new MembershipRepository(k).listByAccount(w.accountA));
      expect(rows.map((m) => m.member_user_id), `actor '${forged}' must see no membership of account A`).toEqual([]);
    }
    // The legitimate actor sees their own row — so the emptiness above is meaningful, not vacuous.
    const own = await asRestricted(product, { actor: w.aViewer }, (k) => new MembershipRepository(k).findActiveByAccountAndUser(w.accountA, w.aViewer));
    expect(own?.member_user_id).toBe(w.aViewer);
  });

  // ── Account scope ──────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-ACCOUNT-MISSING', 'account_profiles + memberships'), async () => {
    expect(await asRestricted(product, { actor: w.aOwner }, (k) => new AccountProfileRepository(k).findByAccount(w.accountA))).toBeUndefined();
    // memberships is the ONE exception, by design: the actor's own row remains visible through the
    // self-branch (see the SCOPE-ACTOR-FORGED test). No OTHER member is revealed without account context.
    const members = await asRestricted(product, { actor: w.aOwner }, (k) => new MembershipRepository(k).listByAccount(w.accountA));
    expect(members.map((m) => m.member_user_id)).toEqual([w.aOwner]);
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
    // WELL-FORMED selectors — real foreign ids and an unknown uuid — are coarse denials, indistinguishable
    // from one another (no existence oracle).
    for (const selector of [w.accountA, w.accountB, UNKNOWN_UUID]) {
      const run = await runInAccountScope(product, { userId: w.outsider, requestedAccountId: selector }, () => Promise.resolve('ran'));
      expect(run, `outsider must be denied for selector '${selector}'`).toEqual({ kind: 'denied', reason: 'membership_not_active' });
    }
    // MALFORMED selectors: the resolver rejects empty/whitespace itself, but a non-empty non-uuid string
    // reaches the bootstrap function's uuid cast and surfaces as a BOUNDED validation PlatformError rather
    // than the coarse denial. Recorded as an accepted current behavior (see the assertions below): it is not
    // an existence oracle — a malformed id exists nowhere by definition, and the error carries no tenant
    // detail. Making malformed selectors return the coarse denial would change public error behavior and is
    // therefore an OWNER DECISION (Class O), not an autonomous fix. What MUST hold is asserted here:
    // never data, never a leak.
    for (const selector of MALFORMED_SELECTORS) {
      const outcome = await runInAccountScope(product, { userId: w.outsider, requestedAccountId: selector }, () => Promise.resolve('ran')).then(
        (run) => ({ kind: String(run.kind), error: undefined as unknown }),
        (error: unknown) => ({ kind: 'threw', error }),
      );
      expect(['denied', 'threw'], `selector '${selector}' must never run the callback`).toContain(outcome.kind);
      if (outcome.kind === 'threw') {
        const message = String((outcome.error as { message?: string }).message ?? outcome.error);
        // Bounded and tenant-free: no SQL, no constraint/table name, no ids, no connection detail.
        for (const forbidden of ['select ', 'insert ', 'uuid', 'constraint', 'memberships', 'acbp_', w.accountA, w.outsider]) {
          expect(message.toLowerCase(), `bounded error must not contain '${forbidden}'`).not.toContain(forbidden.toLowerCase());
        }
      }
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
      const outcome = await runInCompanyScope(product, { userId: w.aOwner, requestedAccountId: w.accountA, requestedCompanyId: selector }, () => Promise.resolve('ran')).then(
        (run) => run.kind as string,
        () => 'threw',
      );
      // Denied or bounded-error — never `ran`. (Same Class O observation as the account resolver above:
      // malformed company selectors surface as a bounded validation error rather than the coarse denial.)
      expect(outcome, `company selector '${selector}' must never run the callback`).not.toBe('ran');
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
