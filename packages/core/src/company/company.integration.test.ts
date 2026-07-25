// ACBP-P1-010 / CDR-015 — real-PostgreSQL tests for company creation + resolution (Slice 3). Trust-critical:
// proves the create bootstrap is atomic (company + profile v1 + owner company-membership + company.created
// audit all-or-nothing), owner-gated by the ACCOUNT role, that account membership alone never grants company
// access, and that the no-SECURITY-DEFINER resolver elevates only for an active company member. Runs as the
// restricted `acbp_app` role under FORCE RLS. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, writeAuditEvent, CompanyProfileRepository, type DatabaseClient, type NewUser } from '@acbp/database';
import { canPickUpAutonomousWork, isAuditEventName } from '@acbp/contracts';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany, type AuditWriteFn } from './company-service.js';
import { getCompany, renameCompany, pauseCompany, resumeCompany } from './company-lifecycle.js';
import { runInCompanyScope } from './company-context-resolver.js';
import { AUDITED_OPERATIONS, COMPANY_AUDITED_OPERATION_IDS, type CompanyAuditedOperation } from '../audit/audit-operations.js';
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

  const ALL = ['usage_events', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

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
    for (const t of ['usage_events', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'users'] as const) {
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

  async function count(table: 'companies' | 'company_profiles' | 'company_memberships' | 'audit_events' | 'activity_events' | 'provisioning_steps' | 'company_workspace_areas'): Promise<number> {
    const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.ref(table)}`.execute(seed.kysely);
    return r.rows[0]?.n ?? 0;
  }

  test('an account owner creates a company: company + profile v1 + owner membership + company.created audit (atomic)', async () => {
    const res = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Acme Co' }, { provisioningRunner: null }); // seam: observe the committed BOOTSTRAP state (the default auto-run is proven in provisioning.integration.test.ts)
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.companyStatus).toBe('onboarding'); // creation now ends in onboarding (P1-012 bootstrap)
    expect(res.creationMode).toBe('own_idea');

    // Company row (superuser read).
    const co = await seed.kysely.selectFrom('companies').selectAll().where('id', '=', res.companyId).executeTakeFirstOrThrow();
    expect(co.account_id).toBe(accountId);
    expect(co.status).toBe('onboarding'); // draft->onboarding happened atomically in the bootstrap (P1-012)
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
    // P1-012 bootstrap additions (same transaction): six PENDING checkpoints in canonical order + the
    // provisioning.started audit. NO step executed (no area rows), NO provisioning activity projection.
    const steps = await seed.kysely.selectFrom('provisioning_steps').selectAll().where('company_id', '=', res.companyId).orderBy('step_order', 'asc').execute();
    expect(steps.map((s) => s.step)).toEqual(['profile', 'mission_draft', 'research', 'roadmap', 'documents', 'activity']);
    for (const s of steps) {
      expect(s.status).toBe('pending');
      expect(s.attempt).toBe(0);
      expect(s.account_id).toBe(accountId);
    }
    const started = await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'provisioning.started').executeTakeFirstOrThrow();
    expect(started.company_id).toBe(res.companyId);
    expect(started.payload).toEqual({ step_count: 6 });
    expect(await count('company_workspace_areas')).toBe(0);
    // Provisioning events are AUDIT-ONLY — the activity feed still carries exactly the company.created row.
    const act = await seed.kysely.selectFrom('activity_events').select('activity_type').where('company_id', '=', res.companyId).execute();
    expect(act.map((a) => a.activity_type)).toEqual(['company.created']);
  });

  test('each of the three creation modes creates a company', async () => {
    for (const mode of ['own_idea', 'platform_suggested', 'existing_business'] as const) {
      const res = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: mode, name: `Co ${mode}`, }, { provisioningRunner: null });
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
    expect(await count('provisioning_steps')).toBe(0); // checkpoint seeding shares the same transaction (P1-012)
  });

  test('atomicity (P1-012): a provisioning.started audit failure rolls back the ENTIRE creation — company, checkpoints, onboarding transition, everything', async () => {
    // Succeed for company.created, fail ONLY the provisioning.started write (the last bootstrap step).
    const selectiveWriter: AuditWriteFn = (scope, event, ctx) =>
      event.name === 'provisioning.started' ? Promise.reject(new Error('provisioning audit boom')) : writeAuditEvent(scope, event, ctx);
    await expect(createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'PB Start' }, { auditWriter: selectiveWriter })).rejects.toBeDefined();
    // NOTHING survives — not the company (so no draft/onboarding state exists), not the checkpoints, not the
    // earlier company.created audit or its activity projection (one transaction, all-or-nothing).
    expect(await count('companies')).toBe(0);
    expect(await count('provisioning_steps')).toBe(0);
    expect(await count('company_workspace_areas')).toBe(0);
    expect(await count('audit_events')).toBe(0);
    expect(await count('activity_events')).toBe(0);
  });

  test('resolver: the creator resolves into the company and reads its current profile (role owner)', async () => {
    const created = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Resolvable' }, { provisioningRunner: null });
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
    const created = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Private' }, { provisioningRunner: null });
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
    const created = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Locked' }, { provisioningRunner: null });
    if (created.status !== 'ok') throw new Error('setup failed');
    const run = await runInCompanyScope(app, { userId: outsiderId, requestedAccountId: accountId, requestedCompanyId: created.companyId }, () => Promise.resolve('x'));
    expect(run.kind).toBe('denied');
  });

  // ── Slice 4: lifecycle (read, rename, pause/resume) + pause-pickup rig ────────────────────────────────
  async function createCompanyFor(name: string): Promise<string> {
    // provisioningRunner: null — these lifecycle tests exercise the P1-010 semantics on a NOT-yet-provisioned
    // company; the default post-create auto-run is proven in provisioning.integration.test.ts.
    const r = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name }, { provisioningRunner: null });
    if (r.status !== 'ok') throw new Error('create failed');
    return r.companyId;
  }
  /** Bring a company to `active`. Onboarding→active provisioning is P1-012; the P1-010 lifecycle tests seed the
   *  active state directly (superuser) to exercise pause/resume, which are the owner-driven transitions in scope. */
  async function createActiveCompany(name: string): Promise<string> {
    const id = await createCompanyFor(name);
    await seed.kysely.updateTable('companies').set({ status: 'active' }).where('id', '=', id).execute();
    return id;
  }
  /** Add an active company VIEWER membership for `viewerId` (superuser seed) to test the owner|viewer split. */
  async function addCompanyViewer(companyId: string): Promise<void> {
    await seed.kysely.insertInto('company_memberships').values({ account_id: accountId, company_id: companyId, member_user_id: viewerId, role: 'viewer', status: 'active' }).execute();
  }

  test('getCompany returns a truthful display status (owner and company-viewer can read)', async () => {
    const id = await createCompanyFor('Readable');
    await addCompanyViewer(id);
    const asOwner = await getCompany(app, { userId: ownerId, accountId, companyId: id });
    expect(asOwner).toMatchObject({ status: 'ok', company: { status: 'onboarding', displayStatus: 'provisioning', name: 'Readable', profileVersion: 1 } });
    // A company viewer may read.
    const asViewer = await getCompany(app, { userId: viewerId, accountId, companyId: id });
    expect(asViewer.status).toBe('ok');
    // Once active, the display status is truthful.
    await seed.kysely.updateTable('companies').set({ status: 'active' }).where('id', '=', id).execute();
    const active = await getCompany(app, { userId: ownerId, accountId, companyId: id });
    if (active.status === 'ok') expect(active.company.displayStatus).toBe('active');
  });

  test('renameCompany (owner) inserts a new profile version + company.updated; a company viewer is forbidden', async () => {
    const id = await createCompanyFor('Old Name');
    await addCompanyViewer(id);
    // Viewer cannot rename (owner-only mutation) — even though they can read.
    expect((await renameCompany(app, { userId: viewerId, accountId, companyId: id, name: 'Hacked' })).status).toBe('forbidden');

    await seed.kysely.deleteFrom('audit_events').execute();
    const r = await renameCompany(app, { userId: ownerId, accountId, companyId: id, name: 'New Name', description: 'now with a brief' });
    expect(r).toMatchObject({ status: 'ok', changed: true, version: 2 });
    const prof = await seed.kysely.selectFrom('company_profiles').selectAll().where('company_id', '=', id).orderBy('version', 'desc').executeTakeFirstOrThrow();
    expect(prof).toMatchObject({ version: 2, name: 'New Name', description: 'now with a brief' });
    const audit = await seed.kysely.selectFrom('audit_events').selectAll().executeTakeFirstOrThrow();
    expect(audit.name).toBe('company.updated');
    expect(audit.company_id).toBe(id);
    expect(audit.payload).toEqual({ changed_fields: 'name,description' });
  });

  test('renameCompany with identical values is an idempotent no-op (no new version, no audit)', async () => {
    const id = await createCompanyFor('Same');
    await seed.kysely.deleteFrom('audit_events').execute();
    const r = await renameCompany(app, { userId: ownerId, accountId, companyId: id, name: 'Same' });
    expect(r).toMatchObject({ status: 'ok', changed: false });
    expect((await seed.kysely.selectFrom('company_profiles').selectAll().where('company_id', '=', id).execute())).toHaveLength(1);
    expect((await seed.kysely.selectFrom('audit_events').selectAll().execute())).toHaveLength(0);
  });

  test('pause then resume (owner): legal transitions update status + write company.paused/resumed', async () => {
    const id = await createActiveCompany('Live Co');
    await seed.kysely.deleteFrom('audit_events').execute();

    const paused = await pauseCompany(app, { userId: ownerId, accountId, companyId: id });
    expect(paused).toMatchObject({ status: 'ok', companyStatus: 'paused' });
    const co1 = await seed.kysely.selectFrom('companies').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(co1.status).toBe('paused');
    const pauseAudit = await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'company.paused').executeTakeFirstOrThrow();
    expect(pauseAudit.company_id).toBe(id);
    // No caller-supplied free-text reason is persisted (security review LOW-1) — the payload is empty.
    expect(pauseAudit.payload).toEqual({});

    const resumed = await resumeCompany(app, { userId: ownerId, accountId, companyId: id });
    expect(resumed).toMatchObject({ status: 'ok', companyStatus: 'active' });
    const co2 = await seed.kysely.selectFrom('companies').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    expect(co2.status).toBe('active');
    expect((await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'company.resumed').execute())).toHaveLength(1);
  });

  test('atomicity: an audit-write failure rolls back a rename (no new version) and a pause (status unchanged)', async () => {
    const failingWriter = (): Promise<string> => Promise.reject(new Error('audit boom'));
    // Rename: the v2 profile insert + company.updated audit share one transaction → both roll back.
    const rid = await createCompanyFor('RB Rename');
    await seed.kysely.deleteFrom('audit_events').execute(); // isolate: drop the setup company.created audit
    await expect(renameCompany(app, { userId: ownerId, accountId, companyId: rid, name: 'RB New' }, { auditWriter: failingWriter })).rejects.toBeDefined();
    const profs = await seed.kysely.selectFrom('company_profiles').selectAll().where('company_id', '=', rid).execute();
    expect(profs).toHaveLength(1); // only v1 survives; the v2 insert was rolled back with its failed audit
    expect(profs[0]?.name).toBe('RB Rename');
    expect(await count('audit_events')).toBe(0); // the failed company.updated write left nothing
    // Pause: the status update + company.paused audit share one transaction → both roll back.
    const pid = await createActiveCompany('RB Pause');
    await seed.kysely.deleteFrom('audit_events').execute(); // isolate: drop the setup company.created audit
    await expect(pauseCompany(app, { userId: ownerId, accountId, companyId: pid }, { auditWriter: failingWriter })).rejects.toBeDefined();
    expect((await seed.kysely.selectFrom('companies').select('status').where('id', '=', pid).executeTakeFirstOrThrow()).status).toBe('active');
    expect(await count('audit_events')).toBe(0);
  });

  // ── ACBP-P1-009: synchronous in-transaction activity projection (CDR-016) ────────────────────────────
  test('each lifecycle op projects exactly one activity row (keyed by the audit event id) in the same transaction', async () => {
    const id = await createCompanyFor('Feed Co');
    // create → company.created activity, traceable to its audit row + redacted payload.
    const created = await seed.kysely.selectFrom('activity_events').selectAll().where('company_id', '=', id).executeTakeFirstOrThrow();
    const createdAudit = await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'company.created').executeTakeFirstOrThrow();
    expect(created).toMatchObject({ event_id: createdAudit.event_id, account_id: accountId, company_id: id, activity_type: 'company.created', actor_id: ownerId, subject_id: id });
    expect(created.payload).toEqual({ creation_mode: 'own_idea' });
    // EXACT temporal identity (asserted in SQL — a JS Date compare would hide sub-millisecond divergence):
    // every projected row's occurred_at equals its authoritative audit row's occurred_at bit-for-bit.
    const exact = await sql<{ n: number }>`
      select count(*)::int as n
      from activity_events act join audit_events au on au.event_id = act.event_id
      where act.occurred_at is distinct from au.occurred_at
    `.execute(seed.kysely);
    expect(exact.rows[0]?.n).toBe(0);
    // rename → company.updated activity.
    await renameCompany(app, { userId: ownerId, accountId, companyId: id, name: 'Feed Co 2' });
    expect((await seed.kysely.selectFrom('activity_events').selectAll().where('activity_type', '=', 'company.updated').where('company_id', '=', id).execute())).toHaveLength(1);
    // pause + resume → company.paused / company.resumed activity.
    await seed.kysely.updateTable('companies').set({ status: 'active' }).where('id', '=', id).execute();
    await pauseCompany(app, { userId: ownerId, accountId, companyId: id });
    await resumeCompany(app, { userId: ownerId, accountId, companyId: id });
    const types = (await seed.kysely.selectFrom('activity_events').select('activity_type').where('company_id', '=', id).execute()).map((r) => r.activity_type).sort();
    expect(types).toEqual(['company.created', 'company.paused', 'company.resumed', 'company.updated']);
    // Every activity row is traceable to an audit row of the same id (audit is authoritative).
    const auditIds = new Set((await seed.kysely.selectFrom('audit_events').select('event_id').where('company_id', '=', id).execute()).map((r) => r.event_id));
    for (const a of await seed.kysely.selectFrom('activity_events').select('event_id').where('company_id', '=', id).execute()) expect(auditIds.has(a.event_id)).toBe(true);
  });

  test('atomicity: an activity-projection failure rolls back the whole op (mutation + audit + activity)', async () => {
    const failingProjector = (): Promise<void> => Promise.reject(new Error('project boom'));
    // create bootstrap: a projection failure undoes company + profile + membership + audit + activity.
    await expect(createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'PB Create' }, { activityWriter: failingProjector })).rejects.toBeDefined();
    expect(await count('companies')).toBe(0);
    expect(await count('audit_events')).toBe(0);
    expect(await count('activity_events')).toBe(0);
    // pause: a projection failure leaves the status unchanged with no audit or activity.
    const pid = await createActiveCompany('PB Pause');
    await seed.kysely.deleteFrom('audit_events').execute();
    await seed.kysely.deleteFrom('activity_events').execute();
    await expect(pauseCompany(app, { userId: ownerId, accountId, companyId: pid }, { activityWriter: failingProjector })).rejects.toBeDefined();
    expect((await seed.kysely.selectFrom('companies').select('status').where('id', '=', pid).executeTakeFirstOrThrow()).status).toBe('active');
    expect(await count('audit_events')).toBe(0);
    expect(await count('activity_events')).toBe(0);
    // rename: its projection call is a DISTINCT inline path (not the transition helper) — prove its rollback too
    // (correctness review F1): the v2 profile insert + audit + activity all roll back together.
    const rrid = await createCompanyFor('PB Rename');
    await seed.kysely.deleteFrom('audit_events').execute();
    await seed.kysely.deleteFrom('activity_events').execute();
    await expect(renameCompany(app, { userId: ownerId, accountId, companyId: rrid, name: 'PB Renamed' }, { activityWriter: failingProjector })).rejects.toBeDefined();
    expect((await seed.kysely.selectFrom('company_profiles').selectAll().where('company_id', '=', rrid).execute())).toHaveLength(1); // v1 only
    expect(await count('audit_events')).toBe(0);
    expect(await count('activity_events')).toBe(0);
  });

  test('illegal transitions are rejected: cannot pause a draft, cannot resume an active', async () => {
    const draft = await createCompanyFor('Draft Co');
    expect(await pauseCompany(app, { userId: ownerId, accountId, companyId: draft })).toMatchObject({ status: 'invalid_transition', from: 'onboarding' }); // post-P1-012 a fresh company is onboarding
    // A genuinely DRAFT company (the backfilled pre-P1-012 shape) still cannot be paused either.
    await seed.kysely.updateTable('companies').set({ status: 'draft' }).where('id', '=', draft).execute();
    expect(await pauseCompany(app, { userId: ownerId, accountId, companyId: draft })).toMatchObject({ status: 'invalid_transition', from: 'draft' });
    const active = await createActiveCompany('Active Co');
    expect(await resumeCompany(app, { userId: ownerId, accountId, companyId: active })).toMatchObject({ status: 'invalid_transition', from: 'active' });
    // Owner resume requires the company be PAUSED — it cannot force the system-driven onboarding→active
    // provisioning transition (P1-012), so a `company.resumed` audit can never be mislabeled (review F2).
    const onboarding = await createCompanyFor('Onboarding Co');
    await seed.kysely.updateTable('companies').set({ status: 'onboarding' }).where('id', '=', onboarding).execute();
    expect(await resumeCompany(app, { userId: ownerId, accountId, companyId: onboarding })).toMatchObject({ status: 'invalid_transition', from: 'onboarding' });
  });

  test('a company viewer cannot pause (owner-only lifecycle op)', async () => {
    const id = await createActiveCompany('Guarded');
    await addCompanyViewer(id);
    expect((await pauseCompany(app, { userId: viewerId, accountId, companyId: id })).status).toBe('forbidden');
    // Status unchanged.
    expect((await seed.kysely.selectFrom('companies').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('active');
  });

  test('pause blocks new autonomous-work pickup (invariant 16 groundwork)', async () => {
    const id = await createActiveCompany('Worker Co');
    // Active → pickup allowed.
    const before = await getCompany(app, { userId: ownerId, accountId, companyId: id });
    expect(before.status).toBe('ok');
    if (before.status === 'ok') expect(canPickUpAutonomousWork(before.company.status)).toBe(true);
    // Pause → the same predicate now blocks new pickup.
    await pauseCompany(app, { userId: ownerId, accountId, companyId: id });
    const after = await getCompany(app, { userId: ownerId, accountId, companyId: id });
    expect(after.status).toBe('ok');
    if (after.status === 'ok') {
      expect(after.company.status).toBe('paused');
      expect(canPickUpAutonomousWork(after.company.status)).toBe(false);
    }
  });

  // Automated completeness: an exhaustive driver per APPROVED COMPANY operation (a new company operation without
  // a driver fails to compile). Each driver runs the REAL use case and must leave exactly one durable audit of
  // its mapped event — a company use case that ever loses its in-tx write fails CI here.
  const CO_DRIVERS: Record<CompanyAuditedOperation, () => Promise<void>> = {
    'company.create': async () => {
      await createCompanyFor('DrvCreate');
    },
    'company.update': async () => {
      const id = await createCompanyFor('DrvUpdate');
      await seed.kysely.deleteFrom('audit_events').execute();
      const r = await renameCompany(app, { userId: ownerId, accountId, companyId: id, name: 'DrvUpdated' });
      if (r.status !== 'ok') throw new Error('update driver failed');
    },
    'company.pause': async () => {
      const id = await createActiveCompany('DrvPause');
      await seed.kysely.deleteFrom('audit_events').execute();
      const r = await pauseCompany(app, { userId: ownerId, accountId, companyId: id });
      if (r.status !== 'ok') throw new Error('pause driver failed');
    },
    'company.resume': async () => {
      const id = await createActiveCompany('DrvResume');
      const p = await pauseCompany(app, { userId: ownerId, accountId, companyId: id });
      if (p.status !== 'ok') throw new Error('resume driver setup failed');
      await seed.kysely.deleteFrom('audit_events').execute();
      const r = await resumeCompany(app, { userId: ownerId, accountId, companyId: id });
      if (r.status !== 'ok') throw new Error('resume driver failed');
    },
  };

  test.each(COMPANY_AUDITED_OPERATION_IDS)('completeness: company operation %s writes exactly one durable audit of its mapped event — ACBP-P1-010', async (op) => {
    await seed.kysely.deleteFrom('audit_events').execute();
    await CO_DRIVERS[op]();
    const all = await seed.kysely.selectFrom('audit_events').selectAll().execute();
    // Exactly ONE event of the operation's MAPPED name. The create bootstrap additionally writes its
    // co-registered provisioning.started event (P1-012) — every co-written name must itself be a REGISTERED
    // event (never an unregistered/free-form write).
    expect(all.filter((e) => e.name === AUDITED_OPERATIONS[op])).toHaveLength(1);
    for (const e of all) expect(isAuditEventName(e.name)).toBe(true);
    const expected = op === 'company.create' ? ['company.created', 'provisioning.started'] : [AUDITED_OPERATIONS[op]];
    expect(all.map((e) => e.name).sort()).toEqual(expected.sort());
  });
});
