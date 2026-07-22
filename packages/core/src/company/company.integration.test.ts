// ACBP-P1-010 / CDR-015 — real-PostgreSQL tests for company creation + resolution (Slice 3). Trust-critical:
// proves the create bootstrap is atomic (company + profile v1 + owner company-membership + company.created
// audit all-or-nothing), owner-gated by the ACCOUNT role, that account membership alone never grants company
// access, and that the no-SECURITY-DEFINER resolver elevates only for an active company member. Runs as the
// restricted `acbp_app` role under FORCE RLS. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, CompanyProfileRepository, type DatabaseClient, type NewUser } from '@acbp/database';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from './company-service.js';
import { runInCompanyScope } from './company-context-resolver.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_co', provider_user_id: `cuser_${seq}`, primary_email: email, email_verified: true, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('company create + resolve (real PostgreSQL, restricted role) — ACBP-P1-010/CDR-015', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let ownerId: string;
  let viewerId: string;
  let outsiderId: string;
  let accountId: string;

  const ALL = ['company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

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
    for (const t of ['company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'users'] as const) {
      await seed.kysely.deleteFrom(t).execute();
    }
    ownerId = await seedUser(seed, 'owner@example.com');
    viewerId = await seedUser(seed, 'viewer@example.com');
    outsiderId = await seedUser(seed, 'outsider@example.com');
    accountId = (await provisionPersonalAccount(app, ownerId)).accountId;
    // Add an active ACCOUNT viewer membership directly (superuser seed bypasses RLS) — proves account
    // membership alone (even viewer) does NOT grant company:create, and that a non-company-member is denied.
    await seed.kysely
      .insertInto('memberships')
      .values({ account_id: accountId, member_user_id: viewerId, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` })
      .execute();
  });

  async function count(table: 'companies' | 'company_profiles' | 'company_memberships' | 'audit_events'): Promise<number> {
    const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.ref(table)}`.execute(seed.kysely);
    return r.rows[0]?.n ?? 0;
  }

  test('an account owner creates a company: company + profile v1 + owner membership + company.created audit (atomic)', async () => {
    const res = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Acme Co' });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.companyStatus).toBe('draft');
    expect(res.creationMode).toBe('own_idea');

    // Company row (superuser read).
    const co = await seed.kysely.selectFrom('companies').selectAll().where('id', '=', res.companyId).executeTakeFirstOrThrow();
    expect(co.account_id).toBe(accountId);
    expect(co.status).toBe('draft');
    expect(co.creation_mode).toBe('own_idea');
    // Profile v1.
    const prof = await seed.kysely.selectFrom('company_profiles').selectAll().where('company_id', '=', res.companyId).executeTakeFirstOrThrow();
    expect(prof.version).toBe(1);
    expect(prof.name).toBe('Acme Co');
    expect(prof.created_by_user_id).toBe(ownerId);
    // Creator's active owner company membership.
    const mem = await seed.kysely.selectFrom('company_memberships').selectAll().where('company_id', '=', res.companyId).executeTakeFirstOrThrow();
    expect(mem).toMatchObject({ account_id: accountId, member_user_id: ownerId, role: 'owner', status: 'active' });
    // Durable company.created audit — company-scoped (company_id stamped), account-bound, subject = company id.
    const audit = await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'company.created').executeTakeFirstOrThrow();
    expect(audit.account_id).toBe(accountId);
    expect(audit.company_id).toBe(res.companyId);
    expect(audit.subject_id).toBe(res.companyId);
    expect(audit.actor_id).toBe(ownerId);
    expect(audit.payload).toEqual({ creation_mode: 'own_idea' });
  });

  test('each of the three creation modes creates a company', async () => {
    for (const mode of ['own_idea', 'platform_suggested', 'existing_business'] as const) {
      const res = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: mode, name: `Co ${mode}` });
      expect(res.status).toBe('ok');
      if (res.status === 'ok') expect(res.creationMode).toBe(mode);
    }
    expect(await count('companies')).toBe(3);
  });

  test('an account VIEWER cannot create a company (owner-gated); nothing is persisted', async () => {
    const res = await createCompany(app, { accountId, actingUserId: viewerId, creationMode: 'own_idea', name: 'Nope' });
    expect(res.status).toBe('forbidden');
    expect(await count('companies')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });

  test('a non-account-member cannot create a company', async () => {
    const res = await createCompany(app, { accountId, actingUserId: outsiderId, creationMode: 'own_idea', name: 'Nope' });
    expect(res.status).toBe('forbidden');
    expect(await count('companies')).toBe(0);
  });

  test('validation: an unknown creation mode is rejected before any write', async () => {
    const res = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'franchise', name: 'X' });
    expect(res.status).toBe('validation');
    expect(await count('companies')).toBe(0);
  });

  test('atomicity: an audit-write failure rolls the WHOLE bootstrap back (no company/profile/membership/audit)', async () => {
    const failingWriter = (): Promise<string> => Promise.reject(new Error('audit boom'));
    await expect(createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Rollback Co', description: 'x' }, { auditWriter: failingWriter })).rejects.toBeDefined();
    expect(await count('companies')).toBe(0);
    expect(await count('company_profiles')).toBe(0);
    expect(await count('company_memberships')).toBe(0);
    expect(await count('audit_events')).toBe(0);
  });

  test('resolver: the creator resolves into the company and reads its current profile (role owner)', async () => {
    const created = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Resolvable' });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;

    const run = await runInCompanyScope(app, { userId: ownerId, requestedAccountId: accountId, requestedCompanyId: created.companyId }, async (scope, role) => {
      expect(role).toBe('owner');
      const prof = await new CompanyProfileRepository(scope.db).currentRevision(created.companyId);
      return prof?.name ?? null;
    });
    expect(run.kind).toBe('ran');
    if (run.kind === 'ran') {
      expect(run.role).toBe('owner');
      expect(run.value).toBe('Resolvable');
    }
  });

  test('resolver deny: an account member WITHOUT a company membership is denied (no company access)', async () => {
    const created = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Private' });
    if (created.status !== 'ok') throw new Error('setup failed');
    // viewer is an active ACCOUNT member but has NO company membership → denied.
    const run = await runInCompanyScope(app, { userId: viewerId, requestedAccountId: accountId, requestedCompanyId: created.companyId }, () => Promise.resolve('should-not-run'));
    expect(run.kind).toBe('denied');
    if (run.kind === 'denied') expect(run.reason).toBe('company_access_denied');
  });

  test('resolver deny: a blank company id is rejected without a database hit (company_not_specified)', async () => {
    const run = await runInCompanyScope(app, { userId: ownerId, requestedAccountId: accountId, requestedCompanyId: '   ' }, () => Promise.resolve('x'));
    expect(run.kind).toBe('denied');
    if (run.kind === 'denied') expect(run.reason).toBe('company_not_specified');
  });

  test('resolver deny: a non-account-member is denied (cannot even obtain the account scope)', async () => {
    const created = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Locked' });
    if (created.status !== 'ok') throw new Error('setup failed');
    const run = await runInCompanyScope(app, { userId: outsiderId, requestedAccountId: accountId, requestedCompanyId: created.companyId }, () => Promise.resolve('x'));
    expect(run.kind).toBe('denied');
  });
});
