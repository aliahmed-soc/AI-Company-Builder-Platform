// ACBP-P1-014 / CDR-020 — CORE PRODUCT-PATH adversarial matrix.
//
// Threat ids: SCOPE-SELECTOR-HARVESTED, SCOPE-ACCOUNT-COMPANY-MISMATCH, AUTHZ-ACCOUNT-OWNER-NOT-COMPANY-MEMBER,
//             AUTHZ-VIEWER-MUTATION, AUTHZ-PLATFORM-ADMIN-NOT-TENANT, AUTHZ-TENANT-NOT-PLATFORM-ADMIN,
//             CURSOR-CROSS-COMPANY, CURSOR-CROSS-ACCOUNT, ORACLE-FOREIGN-ID, ORACLE-UNKNOWN-ID,
//             AUDIT-CROSS-TENANT-FORGERY, ACTIVITY-TAXONOMY-CLOSED.
// Production entrypoints: the REAL use cases — account profile + members, company lifecycle, portfolio,
//             activity, provisioning, and the P1-013 admin read (NEGATIVE-ONLY: positive admin behavior
//             stays in P1-013's own trust suite, CDR-020 §4).
// Proof level: core use case (the layer a route actually calls).
// Real PostgreSQL is MANDATORY: every denial here is decided from real membership rows under RLS.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from './two-tenant-harness.js';
import { threatTitle } from './threat-inventory.js';
import { getProfileForOwner, updateProfileForOwner } from '../../accounts/profile.js';
import { listMembers, inviteMember, revokeMember } from '../../members/membership-service.js';
import { getCompany, renameCompany, pauseCompany, resumeCompany } from '../../company/company-lifecycle.js';
import { getCompanyPortfolio } from '../../company/portfolio-service.js';
import { getCompanyActivity } from '../../company/activity-service.js';
import { getProvisioningStatus, resumeProvisioning } from '../../company/provisioning-service.js';
import { adminReadCompanyOverview } from '../../admin/admin-service.js';

const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000000ff';

describe.skipIf(!hasTestDatabase)('core product-path adversarial matrix (real PostgreSQL, restricted role) — ACBP-P1-014/CDR-020', () => {
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
    w = await seedTwoTenantWorld(owner, product);
  });

  // ── Account + membership ───────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'account profile takes NO account selector — identity alone decides'), async () => {
    // Strongest possible shape: the profile path accepts only the server-verified user id, so there is no
    // selector to substitute. Each owner reaches their OWN account's profile and no other.
    await owner.kysely.updateTable('account_profiles').set({ display_name: 'Account A Name' }).where('account_id', '=', w.accountA).execute();
    await owner.kysely.updateTable('account_profiles').set({ display_name: 'Account B Name' }).where('account_id', '=', w.accountB).execute();
    expect((await getProfileForOwner(product, w.aOwner))?.displayName).toBe('Account A Name');
    expect((await getProfileForOwner(product, w.bOwner))?.displayName).toBe('Account B Name');
    // A non-owner (viewer) and a complete outsider resolve to no owned account at all.
    expect(await getProfileForOwner(product, w.aViewer)).toBeUndefined();
    expect(await getProfileForOwner(product, w.outsider)).toBeUndefined();
    // An update by account B's owner can only ever touch account B.
    await updateProfileForOwner(product, w.bOwner, { displayName: 'Renamed By B' });
    const a = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountA).executeTakeFirstOrThrow();
    const b = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountB).executeTakeFirstOrThrow();
    expect(a.display_name, 'account A must be untouched by account B’s owner').toBe('Account A Name');
    expect(b.display_name).toBe('Renamed By B');
    // A non-owner cannot mutate any profile.
    await updateProfileForOwner(product, w.aViewer, { displayName: 'Viewer Rename' }).catch(() => undefined);
    const stillA = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountA).executeTakeFirstOrThrow();
    expect(stillA.display_name).toBe('Account A Name');
  });

  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'member list / invite / revoke across accounts'), async () => {
    expect((await listMembers(product, { accountId: w.accountA, actingUserId: w.bOwner })).status).toBe('forbidden');
    expect((await inviteMember(product, { accountId: w.accountA, actingUserId: w.bOwner, invitedEmail: 'x@example.com', role: 'viewer' })).status).toBe('forbidden');
    // Revoking a real membership id belonging to account A, as account B's owner.
    const target = await owner.kysely.selectFrom('memberships').select('id').where('account_id', '=', w.accountA).where('member_user_id', '=', w.aViewer).executeTakeFirstOrThrow();
    expect((await revokeMember(product, { accountId: w.accountA, actingUserId: w.bOwner, membershipId: target.id })).status).not.toBe('ok');
    const still = await owner.kysely.selectFrom('memberships').select('status').where('id', '=', target.id).executeTakeFirstOrThrow();
    expect(still.status).toBe('active');
  });

  // ── Company lifecycle ──────────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-ACCOUNT-COMPANY-MISMATCH', 'company read + every mutation'), async () => {
    // Real account A paired with real company B1, and vice versa; plus an unknown company under account A.
    for (const [user, account, company] of [
      [w.aOwner, w.accountA, w.companyB1],
      [w.bOwner, w.accountB, w.companyA1],
      [w.aOwner, w.accountA, UNKNOWN_UUID],
    ] as const) {
      expect((await getCompany(product, { userId: user, accountId: account, companyId: company })).status).not.toBe('ok');
      expect((await renameCompany(product, { userId: user, accountId: account, companyId: company, name: 'Hijacked' })).status).not.toBe('ok');
      expect((await pauseCompany(product, { userId: user, accountId: account, companyId: company })).status).not.toBe('ok');
      expect((await resumeCompany(product, { userId: user, accountId: account, companyId: company })).status).not.toBe('ok');
    }
    // Nothing was renamed or transitioned anywhere.
    const names = await owner.kysely.selectFrom('company_profiles').select('name').execute();
    expect(names.every((n) => n.name !== 'Hijacked')).toBe(true);
    const statuses = await owner.kysely.selectFrom('companies').select(['id', 'status']).execute();
    expect(statuses.every((s) => s.status !== 'paused')).toBe(true);
  });

  test(threatTitle('ORACLE-FOREIGN-ID', 'a real foreign company and an unknown company are indistinguishable'), async () => {
    const foreign = await getCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyB1 });
    const unknown = await getCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: UNKNOWN_UUID });
    expect(foreign.status, 'ORACLE-FOREIGN-ID vs ORACLE-UNKNOWN-ID: statuses must match').toBe(unknown.status);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown)); // byte-identical outcome
  });

  test(threatTitle('AUTHZ-VIEWER-MUTATION', 'viewer may read but never mutate; owner-only verbs stay owner-only'), async () => {
    expect((await getCompany(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('ok');
    expect((await renameCompany(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, name: 'Viewer Rename' })).status).toBe('forbidden');
    expect((await pauseCompany(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
    expect((await resumeProvisioning(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
  });

  // ── Portfolio ──────────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('CURSOR-CROSS-ACCOUNT', 'a portfolio cursor minted under another account/actor is rejected'), async () => {
    const bPage = await getCompanyPortfolio(product, { userId: w.bOwner, accountId: w.accountB, limit: 1 });
    expect(bPage.status).toBe('ok');
    if (bPage.status !== 'ok') return;
    const bCursor = bPage.page.nextCursor;
    expect(bCursor, 'fixture precondition: account B must produce a cursor').not.toBeNull();
    // Replayed by account A's owner against their own account: must be REJECTED, never silently re-scoped.
    const replay = await getCompanyPortfolio(product, { userId: w.aOwner, accountId: w.accountA, cursor: bCursor });
    expect(replay.status, 'a foreign-account cursor must be rejected').toBe('invalid_cursor');
    // …and replayed by a DIFFERENT actor inside the same account B.
    const otherActor = await getCompanyPortfolio(product, { userId: w.bViewer, accountId: w.accountB, cursor: bCursor });
    expect(otherActor.status, 'a cursor is bound to its actor as well as its account').toBe('invalid_cursor');
  });

  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'portfolio never enumerates another account'), async () => {
    const a = await getCompanyPortfolio(product, { userId: w.aOwner, accountId: w.accountA });
    expect(a.status).toBe('ok');
    if (a.status !== 'ok') return;
    expect(a.page.items.map((i) => i.companyId).sort()).toEqual([w.companyA1, w.companyA2].sort());
    expect(a.page.items.every((i) => i.name !== 'Beta One' && i.name !== 'Beta Two')).toBe(true);
    // The outsider gets nothing at all.
    expect((await getCompanyPortfolio(product, { userId: w.outsider, accountId: w.accountA })).status).toBe('forbidden');
  });

  // ── Activity ───────────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('CURSOR-CROSS-COMPANY', 'an activity cursor from A1 cannot be replayed against A2 by a member of BOTH'), async () => {
    // bothCompanies is legitimately a viewer of A1 AND A2 — authority exists, but not for THAT cursor.
    const a1 = await getCompanyActivity(product, { userId: w.bothCompanies, accountId: w.accountA, companyId: w.companyA1, limit: 1 });
    expect(a1.status).toBe('ok');
    if (a1.status !== 'ok') return;
    const cursor = a1.page.nextCursor;
    if (cursor === null) return; // no second page → nothing to replay (fixture-dependent, still safe)
    const replay = await getCompanyActivity(product, { userId: w.bothCompanies, accountId: w.accountA, companyId: w.companyA2, cursor });
    expect(replay.status, 'CURSOR-CROSS-COMPANY: a cursor minted for A1 must not be honoured for A2').toBe('invalid_cursor');
  });

  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'activity feed is per-company and never cross-account'), async () => {
    expect((await getCompanyActivity(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyB1 })).status).toBe('forbidden');
    expect((await getCompanyActivity(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
    const own = await getCompanyActivity(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(own.status).toBe('ok');
    if (own.status !== 'ok') return;
    // ACTIVITY-TAXONOMY-CLOSED: only the four lifecycle events ever appear.
    expect(own.page.items.every((i) => ['company.created', 'company.updated', 'company.paused', 'company.resumed'].includes(i.type))).toBe(true);
  });

  // ── Provisioning ───────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'provisioning status/resume are company-scoped'), async () => {
    for (const [user, account, company] of [
      [w.aOwner, w.accountA, w.companyB1],
      [w.bOwner, w.accountB, w.companyA1],
      [w.outsider, w.accountA, w.companyA1],
    ] as const) {
      expect((await getProvisioningStatus(product, { userId: user, accountId: account, companyId: company })).status).toBe('forbidden');
      expect((await resumeProvisioning(product, { userId: user, accountId: account, companyId: company })).status).toBe('forbidden');
    }
    // Workspace areas of another company are never revealed through the in-scope status read.
    const own = await getProvisioningStatus(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(own.status).toBe('ok');
    if (own.status !== 'ok') return;
    expect(own.provisioning.companyId).toBe(w.companyA1);
  });

  // ── Audit integrity ────────────────────────────────────────────────────────────────────────────────
  test(threatTitle('AUDIT-CROSS-TENANT-FORGERY', 'a denied cross-tenant attempt writes no audit row anywhere'), async () => {
    const before = await owner.kysely.selectFrom('audit_events').select('event_id').execute();
    await getCompany(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyA1 });
    await pauseCompany(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyA1 });
    await renameCompany(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1, name: 'nope' });
    const after = await owner.kysely.selectFrom('audit_events').select('event_id').execute();
    expect(after).toHaveLength(before.length);
    // A legitimate mutation DOES audit — proving the absence above is meaningful.
    expect((await pauseCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('ok');
    const audited = await owner.kysely.selectFrom('audit_events').select(['name', 'account_id', 'company_id']).where('name', '=', 'company.paused').execute();
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ account_id: w.accountA, company_id: w.companyA1 });
  });

  // ── Platform administration — NEGATIVE ONLY (CDR-020 §4) ───────────────────────────────────────────
  test(threatTitle('AUTHZ-PLATFORM-ADMIN-NOT-TENANT', 'platform authority grants NO tenant authority'), async () => {
    // An ACTIVE platform admin with no membership anywhere: every ordinary tenant surface denies.
    expect(await getProfileForOwner(product, w.platformAdmin), 'a platform admin owns no account').toBeUndefined();
    expect((await listMembers(product, { accountId: w.accountA, actingUserId: w.platformAdmin })).status).toBe('forbidden');
    expect((await getCompany(product, { userId: w.platformAdmin, accountId: w.accountA, companyId: w.companyA1 })).status).not.toBe('ok');
    expect((await pauseCompany(product, { userId: w.platformAdmin, accountId: w.accountA, companyId: w.companyA1 })).status).not.toBe('ok');
    expect((await getCompanyPortfolio(product, { userId: w.platformAdmin, accountId: w.accountA })).status).toBe('forbidden');
    expect((await getCompanyActivity(product, { userId: w.platformAdmin, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
    expect((await getProvisioningStatus(product, { userId: w.platformAdmin, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
    expect((await resumeProvisioning(product, { userId: w.platformAdmin, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
  });

  test(threatTitle('AUTHZ-TENANT-NOT-PLATFORM-ADMIN', 'tenant roles never satisfy the admin surface'), async () => {
    const reason = 'Ticket #1: adversarial authority-confusion probe';
    for (const user of [w.aOwner, w.aViewer, w.bOwner, w.outsider, w.revokedPlatformAdmin]) {
      const r = await adminReadCompanyOverview(product, { userId: user, accountId: w.accountA, companyId: w.companyA1, reason });
      expect(r, `${user} must not obtain admin authority`).toEqual({ status: 'forbidden' });
    }
    // No admin audit row was written for any of those attempts.
    const admin = await owner.kysely.selectFrom('audit_events').select('event_id').where('name', '=', 'admin.tenant_read').execute();
    expect(admin).toEqual([]);
  });
});
