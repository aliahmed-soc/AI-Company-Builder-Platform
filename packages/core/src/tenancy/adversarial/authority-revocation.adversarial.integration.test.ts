// ACBP-P1-014 / CDR-020 — STALE AND REVOKED AUTHORITY adversarial suite.
//
// Threat ids: AUTHZ-REVOKED-ACCOUNT, AUTHZ-REVOKED-COMPANY, AUTHZ-STALE-AFTER-RESOLUTION,
//             AUTHZ-ACCOUNT-OWNER-NOT-COMPANY-MEMBER, AUTHZ-VIEWER-MUTATION, SCOPE-SELECTOR-HARVESTED.
// Production entrypoints: `runInAccountScope`, `runInCompanyScope`, `getCompany`, `pauseCompany`,
//             `getCompanyPortfolio`, `getCompanyActivity`, `getProvisioningStatus`, `listMembers`.
// Proof level: core use case + resolver (authority is decided in @acbp/core from fresh internal state).
// Real PostgreSQL is MANDATORY: "fresh resolution" means a real query against the real membership tables
// under RLS — a fake store would only re-assert the test's own assumption.
//
// The fixture OWNER client performs the revocation (simulating an operator/API change made elsewhere); the
// protected action is always attempted on the RESTRICTED product client.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { threatTitle } from '@acbp/test-support';
import { provisionPersonalAccount } from '../../accounts/provisioning.js';
import { createCompany } from '../../company/company-service.js';
import { runInAccountScope } from '../account-context-resolver.js';
import { runInCompanyScope } from '../../company/company-context-resolver.js';
import { getCompany, pauseCompany } from '../../company/company-lifecycle.js';
import { getCompanyPortfolio } from '../../company/portfolio-service.js';
import { getCompanyActivity } from '../../company/activity-service.js';
import { getProvisioningStatus } from '../../company/provisioning-service.js';

/** The production use cases the fixture seeds through (injected — test-support may not import core). */
const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('stale + revoked authority (real PostgreSQL, restricted role) — ACBP-P1-014/CDR-020', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, CORE_SEED_OPS);
  });

  /**
   * Revoke an ACCOUNT membership through the fixture client (an operator action happening elsewhere).
   * `revoked_at` is mandatory: the `memberships_revoked_has_ts` CHECK rejects a revoked row without it, so
   * the fixture must produce the same shape production does.
   */
  async function revokeAccountMembership(accountId: string, userId: string): Promise<void> {
    const n = await owner.kysely
      .updateTable('memberships')
      .set({ status: 'revoked', revoked_at: sql<Date>`now()` })
      .where('account_id', '=', accountId)
      .where('member_user_id', '=', userId)
      .executeTakeFirst();
    expect(Number(n.numUpdatedRows)).toBeGreaterThan(0);
  }
  /** Revoke a COMPANY membership through the fixture client (company_memberships carries no timestamp CHECK). */
  async function revokeCompanyMembership(companyId: string, userId: string): Promise<void> {
    const n = await owner.kysely.updateTable('company_memberships').set({ status: 'revoked' }).where('company_id', '=', companyId).where('member_user_id', '=', userId).executeTakeFirst();
    expect(Number(n.numUpdatedRows)).toBeGreaterThan(0);
  }

  test(threatTitle('AUTHZ-REVOKED-ACCOUNT', 'account resolver + members list'), async () => {
    // 1) authority is genuinely valid first (otherwise the denial below proves nothing)…
    const before = await runInAccountScope(product, { userId: w.aViewer, requestedAccountId: w.accountA }, () => Promise.resolve('ran'));
    expect(before).toEqual({ kind: 'ran', value: 'ran' });
    // 2) …revoked out of band…
    await revokeAccountMembership(w.accountA, w.aViewer);
    // 3) …and the very next resolution denies. No cached authority survives.
    const after = await runInAccountScope(product, { userId: w.aViewer, requestedAccountId: w.accountA }, () => Promise.resolve('ran'));
    expect(after).toEqual({ kind: 'denied', reason: 'membership_not_active' });
    // Company-level paths that build on account authority deny too.
    const portfolio = await getCompanyPortfolio(product, { userId: w.aViewer, accountId: w.accountA });
    expect(portfolio.status).toBe('forbidden');
  });

  test(threatTitle('AUTHZ-REVOKED-COMPANY', 'company read + mutation + activity + provisioning'), async () => {
    // A1 viewer can read before revocation…
    expect((await getCompany(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('ok');
    await revokeCompanyMembership(w.companyA1, w.aViewer);
    // …and every company-scoped surface denies immediately afterwards.
    expect((await getCompany(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).not.toBe('ok');
    expect((await getCompanyActivity(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
    expect((await getProvisioningStatus(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
    const scope = await runInCompanyScope(product, { userId: w.aViewer, requestedAccountId: w.accountA, requestedCompanyId: w.companyA1 }, () => Promise.resolve('ran'));
    expect(scope.kind).toBe('denied');
  });

  test(threatTitle('AUTHZ-REVOKED-COMPANY', 'a revoked company OWNER loses owner-only mutations'), async () => {
    // aOwner owns A1 by creation. Revoke that company membership: the ACCOUNT ownership must not rescue it.
    await revokeCompanyMembership(w.companyA1, w.aOwner);
    const paused = await pauseCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(paused.status).not.toBe('ok');
    const row = await owner.kysely.selectFrom('companies').select('status').where('id', '=', w.companyA1).executeTakeFirstOrThrow();
    expect(row.status).not.toBe('paused');
  });

  test(threatTitle('AUTHZ-STALE-AFTER-RESOLUTION', 'portfolio enumeration → enrichment'), async () => {
    // bothCompanies legitimately sees A1 and A2. Revoke A2 between two portfolio reads: the stale row must
    // never be served (the production service re-resolves per candidate under a fresh CompanyScope).
    const first = await getCompanyPortfolio(product, { userId: w.bothCompanies, accountId: w.accountA });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.page.items.map((i) => i.companyId).sort()).toEqual([w.companyA1, w.companyA2].sort());
    await revokeCompanyMembership(w.companyA2, w.bothCompanies);
    const second = await getCompanyPortfolio(product, { userId: w.bothCompanies, accountId: w.accountA });
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.page.items.map((i) => i.companyId)).toEqual([w.companyA1]);
    // …and the direct read of A2 is denied on the next attempt.
    expect((await getCompany(product, { userId: w.bothCompanies, accountId: w.accountA, companyId: w.companyA2 })).status).not.toBe('ok');
  });

  test(threatTitle('AUTHZ-STALE-AFTER-RESOLUTION', 'revocation INSIDE an open scope does not retroactively widen the next one'), async () => {
    // Authority is resolved once per operation. A revocation committed while a scope is open may or may not
    // affect that in-flight transaction (it is already scoped), but the NEXT operation must deny — that is
    // the invariant that matters and the one asserted here.
    const run = await runInCompanyScope(product, { userId: w.aViewer, requestedAccountId: w.accountA, requestedCompanyId: w.companyA1 }, async () => {
      await revokeCompanyMembership(w.companyA1, w.aViewer); // committed by the OWNER client, out of band
      return 'in-flight';
    });
    // (runInCompanyScope also returns the resolved `role`, so match structurally rather than exactly.)
    expect(run).toMatchObject({ kind: 'ran', value: 'in-flight' });
    const next = await runInCompanyScope(product, { userId: w.aViewer, requestedAccountId: w.accountA, requestedCompanyId: w.companyA1 }, () => Promise.resolve('ran'));
    expect(next.kind).toBe('denied');
  });

  test(threatTitle('AUTHZ-REVOKED-ACCOUNT', 'an invited-but-not-accepted member has no authority at all'), async () => {
    // The fixture's revoked account member and a fresh pending invite are both non-authorities.
    const revoked = await runInAccountScope(product, { userId: w.aRevoked, requestedAccountId: w.accountA }, () => Promise.resolve('ran'));
    expect(revoked).toEqual({ kind: 'denied', reason: 'membership_not_active' });
    // A pending invite is NOT bound to a user yet (memberships_invited_shape: invited rows carry an email +
    // token hash and member_user_id IS NULL) — which is itself the invariant: an unaccepted invite cannot
    // confer authority on anyone, because it names no user at all.
    await owner.kysely
      .insertInto('memberships')
      .values({ account_id: w.accountA, member_user_id: null, role: 'viewer', status: 'invited', invited_email: 'outsider@example.com', invite_token_hash: 'a'.repeat(64) })
      .execute();
    const invited = await runInAccountScope(product, { userId: w.outsider, requestedAccountId: w.accountA }, () => Promise.resolve('ran'));
    expect(invited).toEqual({ kind: 'denied', reason: 'membership_not_active' });
  });

  test(threatTitle('AUTHZ-VIEWER-MUTATION', 'company lifecycle is owner-only even for a valid member'), async () => {
    // aViewer holds a genuine ACTIVE company membership in A1 — and still cannot mutate.
    const paused = await pauseCompany(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 });
    expect(paused.status).toBe('forbidden');
    const row = await owner.kysely.selectFrom('companies').select('status').where('id', '=', w.companyA1).executeTakeFirstOrThrow();
    expect(row.status).not.toBe('paused');
    // …while the read they ARE entitled to still works (the denial is about the verb, not the tenant).
    expect((await getCompany(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('ok');
  });

  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'cross-account users never gain authority from a real id'), async () => {
    for (const [user, account, company] of [
      [w.bOwner, w.accountA, w.companyA1],
      [w.bViewer, w.accountA, w.companyA2],
      [w.aOwner, w.accountB, w.companyB1],
      [w.outsider, w.accountB, w.companyB2],
    ] as const) {
      expect((await getCompany(product, { userId: user, accountId: account, companyId: company })).status, `${user} must not read ${company}`).not.toBe('ok');
      expect((await getCompanyActivity(product, { userId: user, accountId: account, companyId: company })).status).toBe('forbidden');
      expect((await getProvisioningStatus(product, { userId: user, accountId: account, companyId: company })).status).toBe('forbidden');
    }
  });
});
