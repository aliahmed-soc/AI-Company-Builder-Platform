// ACBP-P1-013 / CDR-019 — real-PostgreSQL proof of the platform-admin tenant read. Trust-critical: the reason
// gate runs BEFORE any database access; admin standing is a fresh self-check (tenant roles, account ownership
// and forged claims never grant it; revoked admins deny); the target pair is relationship-verified in-database
// with ONE coarse denial for every cause (no existence oracle); exactly one admin.tenant_read audit lands in
// the TARGET tenant's trail (actor_type='admin', real actor id, verbatim reason) and audit failure returns
// nothing; concurrent A/B reads stay isolated; GUCs clear on every path; no activity projection; and the admin
// path is structurally impersonation-free (source guard). Runs as `acbp_app` under FORCE RLS. Skips without
// ACBP_TEST_DATABASE_URL; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, withTransaction, type DatabaseClient, type NewUser } from '@acbp/database';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { adminReadCompanyOverview } from './admin-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_ad', provider_user_id: `aduser_${seq}`, primary_email: email, email_verified: true, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('platform-admin tenant read (real PostgreSQL, restricted role) — ACBP-P1-013/CDR-019', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let adminId = '';
  let revokedAdminId = '';
  let ownerId = '';
  let viewerId = '';
  let accountA = '';
  let accountB = '';
  let companyA = '';
  let companyB = '';

  const ALL = ['platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(seed);
    expect(r.error).toBeUndefined();
    await enableAppLogin(seed);
    app = createAppClient();
  });
  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (seed) {
      await disableAppLogin(seed);
      for (const t of ALL) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });
  beforeEach(async () => {
    for (const t of ['platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'users'] as const) {
      await seed.kysely.deleteFrom(t).execute();
    }
    adminId = await seedUser(seed, 'admin@example.com');
    revokedAdminId = await seedUser(seed, 'revoked@example.com');
    ownerId = await seedUser(seed, 'owner@example.com');
    viewerId = await seedUser(seed, 'viewer@example.com');
    // Operational (owner-connection) admin setup — the runbook path.
    await sql`insert into platform_admins (user_id) values (${adminId}::uuid)`.execute(seed.kysely);
    await sql`insert into platform_admins (user_id, status, revoked_at) values (${revokedAdminId}::uuid, 'revoked', now())`.execute(seed.kysely);
    // Two tenants, one company each (created through the REAL bootstrap; auto-provisioned to active).
    accountA = (await provisionPersonalAccount(app, ownerId)).accountId;
    await seed.kysely.insertInto('memberships').values({ account_id: accountA, member_user_id: viewerId, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` }).execute();
    const otherOwner = await seedUser(seed, 'other@example.com');
    accountB = (await provisionPersonalAccount(app, otherOwner)).accountId;
    const a = await createCompany(app, { accountId: accountA, actingUserId: ownerId, creationMode: 'own_idea', name: 'Alpha' });
    const b = await createCompany(app, { accountId: accountB, actingUserId: otherOwner, creationMode: 'existing_business', name: 'Beta' });
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('setup failed');
    companyA = a.companyId;
    companyB = b.companyId;
  });

  const REASON = 'Ticket #77: verify company state after support report';
  async function adminAudits(companyId: string) {
    return seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'admin.tenant_read').where('company_id', '=', companyId).execute();
  }

  test('happy path: active admin + valid reason + matching pair → four-field DTO + exactly one TARGET-tenant admin audit', async () => {
    const r = await adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: companyA, reason: REASON });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(Object.keys(r.company).sort()).toEqual(['companyId', 'createdAt', 'creationMode', 'status']);
    expect(r.company).toMatchObject({ companyId: companyA, status: 'active', creationMode: 'own_idea' });
    expect(Number.isFinite(Date.parse(r.company.createdAt))).toBe(true);
    // The response never carries the account id, actor ids, or admin-standing details.
    const json = JSON.stringify(r);
    expect(json).not.toContain(accountA);
    expect(json).not.toContain(adminId);

    const audits = await adminAudits(companyA);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ account_id: accountA, company_id: companyA, actor_type: 'admin', actor_id: adminId, subject_type: 'company', subject_id: companyA, outcome: 'success' });
    expect(audits[0]?.payload).toEqual({ reason: REASON, scope: 'company_overview' });
    // AUDIT-ONLY: no activity projection; the feed taxonomy stays the four lifecycle events.
    const act = await seed.kysely.selectFrom('activity_events').select('activity_type').where('company_id', '=', companyA).execute();
    expect(act.every((x) => ['company.created', 'company.updated', 'company.paused', 'company.resumed'].includes(x.activity_type))).toBe(true);
  });

  test('the reason is retained VERBATIM (leading/trailing whitespace + astral content preserved exactly)', async () => {
    const raw = '  \u{1F50D} inspect после report  ';
    const r = await adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: companyA, reason: raw });
    expect(r.status).toBe('ok');
    const audits = await adminAudits(companyA);
    expect(audits[0]?.payload['reason']).toBe(raw);
  });

  test('reason gate runs FIRST: invalid reasons return invalid_reason (even for non-admins) and write NOTHING', async () => {
    for (const bad of [undefined, '', '   ', 'x'.repeat(513), 42]) {
      expect((await adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: companyA, reason: bad })).status).toBe('invalid_reason');
      // A NON-admin with a bad reason ALSO gets invalid_reason — proving the validator precedes the admin lookup.
      expect((await adminReadCompanyOverview(app, { userId: ownerId, accountId: accountA, companyId: companyA, reason: bad })).status).toBe('invalid_reason');
    }
    expect(await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'admin.tenant_read').execute()).toHaveLength(0);
  });

  test('authority: tenant roles NEVER grant admin — owner/viewer/ordinary/revoked-admin all get ONE coarse forbidden, zero writes', async () => {
    for (const caller of [ownerId, viewerId, revokedAdminId]) {
      const r = await adminReadCompanyOverview(app, { userId: caller, accountId: accountA, companyId: companyA, reason: REASON });
      expect(r).toEqual({ status: 'forbidden' });
    }
    expect(await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'admin.tenant_read').execute()).toHaveLength(0);
  });

  test('target isolation: mismatched pair / unknown ids get the SAME coarse forbidden (no existence oracle); the right pair still works per-request', async () => {
    // Company B addressed under account A → relationship check fails → forbidden.
    expect(await adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: companyB, reason: REASON })).toEqual({ status: 'forbidden' });
    // Unknown company / unknown account → the IDENTICAL result shape.
    expect(await adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: '00000000-0000-4000-8000-000000000000', reason: REASON })).toEqual({ status: 'forbidden' });
    expect(await adminReadCompanyOverview(app, { userId: adminId, accountId: '00000000-0000-4000-8000-000000000001', companyId: companyA, reason: REASON })).toEqual({ status: 'forbidden' });
    // No audit rows for any denial.
    expect(await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'admin.tenant_read').execute()).toHaveLength(0);
    // Each tenant is reachable ONLY via its own explicitly-targeted request (fresh scope per request).
    expect((await adminReadCompanyOverview(app, { userId: adminId, accountId: accountB, companyId: companyB, reason: REASON })).status).toBe('ok');
    expect((await adminAudits(companyB))).toHaveLength(1);
    expect(await adminAudits(companyA)).toHaveLength(0);
  });

  test('audit atomicity: an audit-write failure rolls back and returns NO company data (and no audit row)', async () => {
    const failing = (): Promise<string> => Promise.reject(new Error('audit boom'));
    await expect(adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: companyA, reason: REASON }, { auditWriter: failing })).rejects.toBeDefined();
    expect(await adminAudits(companyA)).toHaveLength(0);
  });

  test('concurrent reads of companies A and B stay isolated: each result and each audit lands on its own tenant', async () => {
    const [ra, rb] = await Promise.all([
      adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: companyA, reason: 'Ticket #1: A' }),
      adminReadCompanyOverview(app, { userId: adminId, accountId: accountB, companyId: companyB, reason: 'Ticket #2: B' }),
    ]);
    expect(ra.status === 'ok' && ra.company.companyId).toBe(companyA);
    expect(rb.status === 'ok' && rb.company.companyId).toBe(companyB);
    expect(ra.status === 'ok' && ra.company.creationMode).toBe('own_idea');
    expect(rb.status === 'ok' && rb.company.creationMode).toBe('existing_business');
    const aAudits = await adminAudits(companyA);
    const bAudits = await adminAudits(companyB);
    expect(aAudits).toHaveLength(1);
    expect(bAudits).toHaveLength(1);
    expect(aAudits[0]?.payload['reason']).toBe('Ticket #1: A');
    expect(bAudits[0]?.payload['reason']).toBe('Ticket #2: B');
  });

  test('GUC cleanup: after success, denial and audit-failure rollback, a bare transaction sees no leaked context', async () => {
    await adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: companyA, reason: REASON });
    await adminReadCompanyOverview(app, { userId: ownerId, accountId: accountA, companyId: companyA, reason: REASON });
    await adminReadCompanyOverview(app, { userId: adminId, accountId: accountA, companyId: companyA, reason: REASON }, { auditWriter: () => Promise.reject(new Error('boom')) }).catch(() => undefined);
    const gucs = await withTransaction(app, async (tx) => {
      const r = await sql<{ a: string | null; c: string | null; u: string | null }>`select current_setting('app.current_account', true) as a, current_setting('app.current_company', true) as c, current_setting('app.current_actor', true) as u`.execute(tx.kysely);
      return r.rows[0]!;
    });
    for (const v of [gucs.a, gucs.c, gucs.u]) expect(v === '' || v === null).toBe(true);
  });

  test('NO-IMPERSONATION source guard: the admin path contains no impersonation-shaped identifier or membership write', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = [
      readFileSync(join(here, 'admin-service.ts'), 'utf8'),
      readFileSync(join(here, '..', '..', '..', 'database', 'src', 'admin-access.ts'), 'utf8'),
    ];
    for (const src of sources) {
      for (const forbidden of [/impersonat/i, /actAsUser/i, /assumedUserId/i, /delegatedSession/i]) {
        expect(forbidden.test(src)).toBe(false);
      }
      // The admin path never writes a membership and never touches member/profile tables.
      expect(/insertInto\((['"`])(memberships|company_memberships)\1\)/.test(src)).toBe(false);
      expect(src.includes('company_profiles')).toBe(false);
    }
  });
});
