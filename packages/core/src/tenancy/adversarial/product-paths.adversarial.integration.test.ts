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
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { threatTitle } from '@acbp/test-support';
import { provisionPersonalAccount } from '../../accounts/provisioning.js';
import { createCompany } from '../../company/company-service.js';
import { getProfileForOwner, updateProfileForOwner } from '../../accounts/profile.js';
import { listMembers, inviteMember, revokeMember } from '../../members/membership-service.js';
import { getCompany, renameCompany, pauseCompany, resumeCompany } from '../../company/company-lifecycle.js';
import { getCompanyPortfolio } from '../../company/portfolio-service.js';
import { getCompanyActivity } from '../../company/activity-service.js';
import { getProvisioningStatus, resumeProvisioning } from '../../company/provisioning-service.js';
import { adminReadCompanyOverview } from '../../admin/admin-service.js';

const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000000ff';

/** The production use cases the fixture seeds through (injected — test-support may not import core). */
const CORE_SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

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
    w = await seedTwoTenantWorld(owner, product, CORE_SEED_OPS);
  });

  // ── Account + membership ───────────────────────────────────────────────────────────────────────────
  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'account profile takes NO account selector — identity alone decides'), async () => {
    // Strongest possible shape: the profile path accepts only the server-verified user id, so there is no
    // selector to substitute. Each owner reaches their OWN account's profile and no other.
    await owner.kysely.updateTable('account_profiles').set({ display_name: 'Account A Name' }).where('account_id', '=', w.accountA).execute();
    await owner.kysely.updateTable('account_profiles').set({ display_name: 'Account B Name' }).where('account_id', '=', w.accountB).execute();
    expect((await getProfileForOwner(product, w.aOwner))?.displayName).toBe('Account A Name');
    expect((await getProfileForOwner(product, w.bOwner))?.displayName).toBe('Account B Name');
    // Every user has their OWN personal account (P1-003), so a viewer or outsider does NOT resolve to
    // nothing — they resolve to THEMSELVES. The isolation property is that they never reach someone else's:
    // no account A or B profile is ever returned to a caller who does not own it.
    for (const user of [w.aViewer, w.outsider, w.bViewer, w.bothCompanies]) {
      const own = await getProfileForOwner(product, user);
      expect(own?.accountId, `${user} must not reach account A`).not.toBe(w.accountA);
      expect(own?.accountId, `${user} must not reach account B`).not.toBe(w.accountB);
      expect(own?.displayName).not.toBe('Account A Name');
      expect(own?.displayName).not.toBe('Account B Name');
    }
    // An update by account B's owner can only ever touch account B.
    await updateProfileForOwner(product, w.bOwner, { displayName: 'Renamed By B' });
    const a = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountA).executeTakeFirstOrThrow();
    const b = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountB).executeTakeFirstOrThrow();
    expect(a.display_name, 'account A must be untouched by account B’s owner').toBe('Account A Name');
    expect(b.display_name).toBe('Renamed By B');
    // A viewer's update lands on their OWN personal account, never on account A.
    await updateProfileForOwner(product, w.aViewer, { displayName: 'Viewer Rename' }).catch(() => undefined);
    const stillA = await owner.kysely.selectFrom('account_profiles').select('display_name').where('account_id', '=', w.accountA).executeTakeFirstOrThrow();
    expect(stillA.display_name, 'a viewer’s profile update must not touch account A').toBe('Account A Name');
    const renamedElsewhere = await owner.kysely.selectFrom('account_profiles').select('account_id').where('display_name', '=', 'Viewer Rename').execute();
    expect(renamedElsewhere.every((r) => r.account_id !== w.accountA && r.account_id !== w.accountB)).toBe(true);
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
    // Statuses must be exactly the fixture's: A1/A2/B1 active, B2 paused by design. (Asserting "nothing is
    // paused" would silently pass if a mutation flipped B2 back, and is simply false for B2.)
    const statuses = new Map((await owner.kysely.selectFrom('companies').select(['id', 'status']).execute()).map((r) => [r.id, r.status]));
    expect(statuses.get(w.companyA1)).toBe('active');
    expect(statuses.get(w.companyA2)).toBe('active');
    expect(statuses.get(w.companyB1)).toBe('active');
    expect(statuses.get(w.companyB2)).toBe('paused');
  });

  test(`${threatTitle('ORACLE-FOREIGN-ID', 'company read')} [ORACLE-UNKNOWN-ID] a real foreign company and an unknown company are indistinguishable`, async () => {
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
    // A company starts with exactly ONE activity row (company.created), so a limit-1 page has no next
    // cursor and an early return would make this test silently assert nothing. Generate a second row first,
    // then require the cursor as a HARD precondition — an adversarial suite must never skip its own case.
    expect((await pauseCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('ok');
    expect((await resumeCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('ok');

    // bothCompanies is legitimately a viewer of A1 AND A2 — authority exists, but not for THAT cursor.
    const a1 = await getCompanyActivity(product, { userId: w.bothCompanies, accountId: w.accountA, companyId: w.companyA1, limit: 1 });
    expect(a1.status).toBe('ok');
    if (a1.status !== 'ok') return;
    const cursor = a1.page.nextCursor;
    expect(cursor, 'fixture precondition: A1 must have enough activity to produce a cursor').not.toBeNull();
    const replay = await getCompanyActivity(product, { userId: w.bothCompanies, accountId: w.accountA, companyId: w.companyA2, cursor });
    expect(replay.status, 'CURSOR-CROSS-COMPANY: a cursor minted for A1 must not be honoured for A2').toBe('invalid_cursor');
    // …and the same cursor still works for the company it was minted for.
    const continued = await getCompanyActivity(product, { userId: w.bothCompanies, accountId: w.accountA, companyId: w.companyA1, cursor });
    expect(continued.status, 'the cursor must remain valid for its OWN company').toBe('ok');
  });

  test(threatTitle('ORACLE-FOREIGN-ID', 'mutating verbs leak no state either — including invalid_transition'), async () => {
    // rename/pause/resume have richer result taxonomies than read: `invalid_transition` carries `from`,
    // i.e. the TARGET's current status. B2 is paused in the fixture, so pausing it is exactly the request
    // that would surface that state if authority were checked after the transition check.
    const foreignPaused = await pauseCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyB2 });
    const unknown = await pauseCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: UNKNOWN_UUID });
    expect(JSON.stringify(foreignPaused), 'pausing an already-paused FOREIGN company must be indistinguishable from an unknown one').toBe(JSON.stringify(unknown));
    expect(JSON.stringify(foreignPaused)).not.toContain('paused'); // no `from` state leaked

    const foreignResume = await resumeCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyB2 });
    const unknownResume = await resumeCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: UNKNOWN_UUID });
    expect(JSON.stringify(foreignResume)).toBe(JSON.stringify(unknownResume));

    const foreignRename = await renameCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyB1, name: 'Probe' });
    const unknownRename = await renameCompany(product, { userId: w.aOwner, accountId: w.accountA, companyId: UNKNOWN_UUID, name: 'Probe' });
    expect(JSON.stringify(foreignRename)).toBe(JSON.stringify(unknownRename));
    // Nothing moved.
    const b2 = await owner.kysely.selectFrom('companies').select('status').where('id', '=', w.companyB2).executeTakeFirstOrThrow();
    expect(b2.status).toBe('paused');
  });

  test(threatTitle('SCOPE-SELECTOR-HARVESTED', 'activity feed is per-company and never cross-account'), async () => {
    expect((await getCompanyActivity(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyB1 })).status).toBe('forbidden');
    expect((await getCompanyActivity(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
    const own = await getCompanyActivity(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(own.status).toBe('ok');
    if (own.status !== 'ok') return;
    // ACTIVITY-TAXONOMY-CLOSED — with a non-emptiness precondition and an explicit NEGATIVE: the fixture
    // generates provisioning audit events, so "no provisioning/admin type appears" is a real claim, not one
    // satisfied by an empty feed.
    expect(own.page.items.length, 'the feed must be non-empty or the taxonomy assertion is vacuous').toBeGreaterThan(0);
    expect(own.page.items.some((i) => i.type === 'company.created')).toBe(true);
    expect(own.page.items.every((i) => ['company.created', 'company.updated', 'company.paused', 'company.resumed'].includes(i.type))).toBe(true);
    const provisioningAudits = await owner.kysely.selectFrom('audit_events').select('name').where('company_id', '=', w.companyA1).execute();
    expect(provisioningAudits.some((a) => a.name.startsWith('provisioning.')), 'fixture precondition: provisioning events must exist to be excludable').toBe(true);
    expect(own.page.items.some((i) => String(i.type).startsWith('provisioning.') || String(i.type).startsWith('admin.')), 'a provisioning/admin event was projected into the feed').toBe(false);
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
    // Scoped to A1: the fixture also pauses B2 (deliberately), so an unscoped count would see two rows.
    const audited = await owner.kysely.selectFrom('audit_events').select(['name', 'account_id', 'company_id']).where('name', '=', 'company.paused').where('company_id', '=', w.companyA1).execute();
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ account_id: w.accountA, company_id: w.companyA1 });
  });

  // ── Platform administration — NEGATIVE ONLY (CDR-020 §4) ───────────────────────────────────────────
  test(threatTitle('AUTHZ-PLATFORM-ADMIN-NOT-TENANT', 'platform authority grants NO tenant authority'), async () => {
    // An ACTIVE platform admin with no membership anywhere: every ordinary tenant surface denies.
    // The admin has their own personal account like any user — but it is never account A or B.
    const adminProfile = await getProfileForOwner(product, w.platformAdmin);
    expect(adminProfile?.accountId, 'a platform admin must not reach a tenant account').not.toBe(w.accountA);
    expect(adminProfile?.accountId).not.toBe(w.accountB);
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
