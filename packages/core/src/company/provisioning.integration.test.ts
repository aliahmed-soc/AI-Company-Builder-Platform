// ACBP-P1-012 / CDR-018 — real-PostgreSQL proof of the workspace-provisioning executor, resume orchestration,
// and completion transition. Trust-critical: default post-create auto-provisioning drives a company to `active`
// with truthful material effects; kill-and-resume works after every committed checkpoint (an interrupted step
// leaves NO committed trace; completed steps never repeat); controlled failures halt the sequence with closed
// failure codes; the 3-attempt cap makes a step EXHAUSTED (resume = safe conflict, zero mutation); verification
// steps never fake success; concurrent duplicate resumes produce exactly one effect/attempt/audit per step and
// exactly one activation; backfilled draft companies are brought up idempotently; paused/inconsistent states
// fail closed; provisioning events are audit-only (activity taxonomy unchanged); GUCs clear after runs.
// Runs as the restricted `acbp_app` role under FORCE RLS. Skips without ACBP_TEST_DATABASE_URL; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, withTransaction, type DatabaseClient, type NewUser } from '@acbp/database';
import { PROVISIONING_STEPS, AUDIT_EVENTS } from '@acbp/contracts';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from './company-service.js';
import { getProvisioningStatus, resumeProvisioning, type StepEffectFn } from './provisioning-service.js';
import { AUDITED_OPERATIONS, PROVISIONING_AUDITED_OPERATION_IDS } from '../audit/audit-operations.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_pv', provider_user_id: `pvuser_${seq}`, primary_email: email, email_verified: true, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

const failEffect = (code: 'profile_missing' | 'activity_projection_missing' | 'internal_error'): StepEffectFn => () => Promise.resolve({ ok: false, failureCode: code });
const crashEffect: StepEffectFn = () => Promise.reject(new Error('simulated interruption'));

describe.skipIf(!hasTestDatabase)('workspace provisioning execution (real PostgreSQL, restricted role) — ACBP-P1-012/CDR-018', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let ownerId: string;
  let viewerId: string;
  let outsiderId: string;
  let accountId: string;

  const ALL = ['usage_events', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

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
    for (const t of ['usage_events', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'users'] as const) {
      await seed.kysely.deleteFrom(t).execute();
    }
    ownerId = await seedUser(seed, 'owner@example.com');
    viewerId = await seedUser(seed, 'viewer@example.com');
    outsiderId = await seedUser(seed, 'outsider@example.com');
    accountId = (await provisionPersonalAccount(app, ownerId)).accountId;
    await seed.kysely.insertInto('memberships').values({ account_id: accountId, member_user_id: viewerId, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` }).execute();
  });

  /** Bootstrap-only create (no auto-run): the canonical starting point for executor tests. */
  async function createOnboarding(name: string): Promise<string> {
    const r = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name }, { provisioningRunner: null });
    if (r.status !== 'ok') throw new Error('create failed');
    return r.companyId;
  }
  async function auditNames(companyId: string): Promise<string[]> {
    const rows = await seed.kysely.selectFrom('audit_events').select('name').where('company_id', '=', companyId).orderBy('event_id', 'asc').execute();
    return rows.map((r) => r.name);
  }
  async function stepRows(companyId: string) {
    return seed.kysely.selectFrom('provisioning_steps').selectAll().where('company_id', '=', companyId).orderBy('step_order', 'asc').execute();
  }
  async function companyStatus(companyId: string): Promise<string> {
    return (await seed.kysely.selectFrom('companies').select('status').where('id', '=', companyId).executeTakeFirstOrThrow()).status;
  }

  test('DEFAULT create auto-provisions end-to-end: six completed steps, four areas, active company, audit-only events', async () => {
    const r = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name: 'Auto Co' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.companyStatus).toBe('active'); // the returned status is the truthful FINAL state
    expect(await companyStatus(r.companyId)).toBe('active');

    const steps = await stepRows(r.companyId);
    expect(steps.map((s) => s.step)).toEqual([...PROVISIONING_STEPS]);
    for (const s of steps) {
      expect(s.status).toBe('completed');
      expect(s.attempt).toBe(1);
      expect(s.started_at).not.toBeNull();
      expect(s.completed_at).not.toBeNull();
      expect(s.failure_code).toBeNull();
    }
    const areas = await seed.kysely.selectFrom('company_workspace_areas').select('area').where('company_id', '=', r.companyId).orderBy('area', 'asc').execute();
    expect(areas.map((a) => a.area)).toEqual(['documents', 'mission_draft', 'research', 'roadmap']);
    // Exact audit trail: bootstrap pair + (started, completed) per step + the completion event.
    const names = await auditNames(r.companyId);
    expect(names.filter((n) => n === 'provisioning.step_started')).toHaveLength(6);
    expect(names.filter((n) => n === 'provisioning.step_completed')).toHaveLength(6);
    expect(names.filter((n) => n === 'provisioning.completed')).toHaveLength(1);
    expect(names.filter((n) => n === 'provisioning.started')).toHaveLength(1);
    expect(names.filter((n) => n === 'company.created')).toHaveLength(1);
    expect(names).toHaveLength(15);
    // System actor on execution events; every audited name is registered.
    const sys = await seed.kysely.selectFrom('audit_events').select(['name', 'actor_type']).where('company_id', '=', r.companyId).where('name', 'like', 'provisioning.step%').execute();
    for (const e of sys) expect(e.actor_type).toBe('system');
    // AUDIT-ONLY: the activity feed still carries exactly the company.created projection.
    const act = await seed.kysely.selectFrom('activity_events').select('activity_type').where('company_id', '=', r.companyId).execute();
    expect(act.map((a) => a.activity_type)).toEqual(['company.created']);
  });

  test('kill-and-resume after EVERY committed checkpoint: an interrupted step leaves no trace; completed steps never repeat', async () => {
    for (let k = 0; k < PROVISIONING_STEPS.length; k++) {
      const crashStep = PROVISIONING_STEPS[k]!;
      const co = await createOnboarding(`Kill at ${crashStep}`);
      // Run until the crash step: the unexpected error aborts THAT step's transaction (its checkpoint stays
      // exactly as it was) and the whole resume call rejects — like a process kill between checkpoints.
      await expect(resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, { stepEffects: { [crashStep]: crashEffect } })).rejects.toBeDefined();
      const afterCrash = await stepRows(co);
      for (let i = 0; i < PROVISIONING_STEPS.length; i++) {
        const row = afterCrash[i]!;
        if (i < k) expect(row.status).toBe('completed');
        else {
          expect(row.status).toBe('pending'); // the interrupted step committed NOTHING (no running, no attempt)
          expect(row.attempt).toBe(0);
        }
      }
      expect(await companyStatus(co)).toBe('onboarding');
      // Resume WITHOUT the fault: continues from the interrupted step; earlier steps are never re-executed.
      const resumed = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co });
      expect(resumed.status).toBe('ok');
      if (resumed.status === 'ok') expect(resumed.provisioning.completed).toBe(true);
      expect(await companyStatus(co)).toBe('active');
      const finalSteps = await stepRows(co);
      for (const s of finalSteps) {
        expect(s.status).toBe('completed');
        expect(s.attempt).toBe(1); // exactly one committed attempt each — completed steps never repeated
      }
      const names = await auditNames(co);
      expect(names.filter((n) => n === 'provisioning.step_started')).toHaveLength(6); // one per step TOTAL
      expect(names.filter((n) => n === 'provisioning.completed')).toHaveLength(1); // activation exactly once
    }
  }, 60000);

  test('controlled failure halts; explicit retries are user-audited; attempt cap 3 exhausts; exhausted resume mutates NOTHING', async () => {
    const co = await createOnboarding('Cap Co');
    const failResearch = { stepEffects: { research: failEffect('internal_error') } };

    // Attempt 1 (auto path of resume): halts at research; later steps stay pending (sequence halted).
    const r1 = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, failResearch);
    expect(r1.status).toBe('ok');
    if (r1.status === 'ok') {
      expect(r1.provisioning.resumable).toBe(true);
      expect(r1.provisioning.exhausted).toBe(false);
      expect(r1.provisioning.nextIncompleteStep).toBe('research');
    }
    let rows = await stepRows(co);
    expect(rows.find((s) => s.step === 'research')).toMatchObject({ status: 'failed', attempt: 1, failure_code: 'internal_error' });
    expect(rows.find((s) => s.step === 'roadmap')?.status).toBe('pending');
    expect(rows.find((s) => s.step === 'documents')?.status).toBe('pending');

    // Attempts 2 and 3 — each an explicit owner retry, audited as a USER retry_requested with next_attempt.
    const r2 = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, failResearch);
    expect(r2.status).toBe('ok');
    const r3 = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, failResearch);
    expect(r3.status).toBe('ok');
    if (r3.status === 'ok') {
      expect(r3.provisioning.exhausted).toBe(true);
      expect(r3.provisioning.resumable).toBe(false);
    }
    rows = await stepRows(co);
    expect(rows.find((s) => s.step === 'research')).toMatchObject({ status: 'failed', attempt: 3 });
    const retries = await seed.kysely.selectFrom('audit_events').selectAll().where('company_id', '=', co).where('name', '=', 'provisioning.retry_requested').orderBy('event_id', 'asc').execute();
    expect(retries).toHaveLength(2);
    expect(retries.map((e) => e.actor_type)).toEqual(['user', 'user']);
    expect(retries.map((e) => e.payload)).toEqual([{ step: 'research', next_attempt: 2 }, { step: 'research', next_attempt: 3 }]);
    // Retry-run system step events carry the retry event as causation.
    const causedSteps = await seed.kysely.selectFrom('audit_events').selectAll().where('company_id', '=', co).where('name', '=', 'provisioning.step_failed').orderBy('event_id', 'asc').execute();
    expect(causedSteps).toHaveLength(3);
    expect(causedSteps[1]?.causation_id).toBe(retries[0]?.event_id);
    expect(causedSteps[2]?.causation_id).toBe(retries[1]?.event_id);

    // EXHAUSTED: a fourth resume — even with the effect fixed — is a safe conflict and performs NO mutation.
    const before = { steps: await stepRows(co), audits: (await auditNames(co)).length };
    const r4 = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co });
    expect(r4.status).toBe('conflict');
    expect(await stepRows(co)).toEqual(before.steps);
    expect((await auditNames(co)).length).toBe(before.audits);
    expect(await companyStatus(co)).toBe('onboarding'); // no step failure/exhaustion can ever activate
  });

  test('verification steps never fake success: missing profile / missing activity projection fail with their closed codes', async () => {
    // profile_missing: remove the v1 profile revision out-of-band.
    const co1 = await createOnboarding('No Profile');
    await seed.kysely.deleteFrom('company_profiles').where('company_id', '=', co1).execute();
    const r1 = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co1 });
    expect(r1.status).toBe('ok');
    expect((await stepRows(co1)).find((s) => s.step === 'profile')).toMatchObject({ status: 'failed', attempt: 1, failure_code: 'profile_missing' });

    // activity_projection_missing: remove the company.created projection out-of-band; earlier steps succeed.
    const co2 = await createOnboarding('No Activity');
    await seed.kysely.deleteFrom('activity_events').where('company_id', '=', co2).execute();
    const r2 = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co2 });
    expect(r2.status).toBe('ok');
    const rows2 = await stepRows(co2);
    for (const s of rows2.filter((x) => x.step !== 'activity')) expect(s.status).toBe('completed');
    expect(rows2.find((s) => s.step === 'activity')).toMatchObject({ status: 'failed', failure_code: 'activity_projection_missing' });
    expect(await companyStatus(co2)).toBe('onboarding'); // five of six completed is NOT activation
  });

  test('CONCURRENT duplicate resumes: one effect, one attempt, one audit transition per step; ONE activation', async () => {
    const co = await createOnboarding('Race Co');
    const [a, b] = await Promise.all([
      resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }),
      resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }),
    ]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    expect(await companyStatus(co)).toBe('active');
    const rows = await stepRows(co);
    for (const s of rows) {
      expect(s.status).toBe('completed');
      expect(s.attempt).toBe(1); // no double attempt increment anywhere
    }
    const names = await auditNames(co);
    expect(names.filter((n) => n === 'provisioning.step_started')).toHaveLength(6);
    expect(names.filter((n) => n === 'provisioning.step_completed')).toHaveLength(6);
    expect(names.filter((n) => n === 'provisioning.completed')).toHaveLength(1); // no double onboarding→active
    const areas = await seed.kysely.selectFrom('company_workspace_areas').select('area').where('company_id', '=', co).execute();
    expect(areas).toHaveLength(4); // no duplicate area rows
  });

  test('CONCURRENT resumes racing a FAILED step: no unaudited automatic retry; each executed retry is user-authorized exactly once', async () => {
    const co = await createOnboarding('Retry Race Co');
    const failResearch = { stepEffects: { research: failEffect('internal_error') } };
    // Wave 1: two concurrent resumes on a FRESH sequence with research failing. Whichever run reaches research
    // first commits its controlled failure (attempt 1); the OTHER run holds no retry authorization for that
    // just-failed attempt → it HALTS. Exactly ONE committed attempt, ZERO retry events.
    const [w1a, w1b] = await Promise.all([
      resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, failResearch),
      resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, failResearch),
    ]);
    expect(w1a.status).toBe('ok');
    expect(w1b.status).toBe('ok');
    expect((await stepRows(co)).find((s) => s.step === 'research')).toMatchObject({ status: 'failed', attempt: 1 });
    expect((await auditNames(co)).filter((n) => n === 'provisioning.retry_requested')).toHaveLength(0);
    expect((await auditNames(co)).filter((n) => n === 'provisioning.step_failed')).toHaveLength(1);

    // Wave 2: two concurrent resumes RETRYING the failed step. Both Phase A's authorize (research, attempt 1);
    // only the run that actually executes consumes it (retry_requested written IN that step transaction); the
    // other's authorization no longer matches attempt 2 → halts. Exactly ONE executed retry, ONE retry event.
    const [w2a, w2b] = await Promise.all([
      resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, failResearch),
      resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, failResearch),
    ]);
    expect(w2a.status).toBe('ok');
    expect(w2b.status).toBe('ok');
    expect((await stepRows(co)).find((s) => s.step === 'research')).toMatchObject({ status: 'failed', attempt: 2 });
    const retries = await seed.kysely.selectFrom('audit_events').selectAll().where('company_id', '=', co).where('name', '=', 'provisioning.retry_requested').execute();
    expect(retries).toHaveLength(1);
    expect(retries[0]?.actor_type).toBe('user');
    expect(retries[0]?.payload).toEqual({ step: 'research', next_attempt: 2 }); // exact — audited at execution time
    expect((await auditNames(co)).filter((n) => n === 'provisioning.step_failed')).toHaveLength(2);
  });

  test('recovery: crash between the sixth step and activation (all completed + onboarding) — resume activates exactly once', async () => {
    const co = await createOnboarding('Almost Done Co');
    // Simulate the crash window: all six checkpoints durably completed, activation transaction never ran.
    await seed.kysely
      .updateTable('provisioning_steps')
      .set({ status: 'completed', attempt: 1, started_at: sql<Date>`now()`, completed_at: sql<Date>`now()` })
      .where('company_id', '=', co)
      .execute();
    expect(await companyStatus(co)).toBe('onboarding');
    const r = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.provisioning.completed).toBe(true);
      expect(r.provisioning.companyStatus).toBe('active');
    }
    expect(await companyStatus(co)).toBe('active');
    const names = await auditNames(co);
    expect(names.filter((n) => n === 'provisioning.completed')).toHaveLength(1);
    expect(names.filter((n) => n === 'provisioning.step_started')).toHaveLength(0); // no step was re-executed
  });

  test('completed provisioning: resume is a pure idempotent read (no mutation, no rerun)', async () => {
    const co = await createOnboarding('Done Co');
    expect((await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co })).status).toBe('ok');
    const before = { steps: await stepRows(co), audits: (await auditNames(co)).length };
    const again = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co });
    expect(again.status).toBe('ok');
    if (again.status === 'ok') expect(again.provisioning.completed).toBe(true);
    expect(await stepRows(co)).toEqual(before.steps);
    expect((await auditNames(co)).length).toBe(before.audits);
  });

  test('BACKFILLED draft company: resume transitions draft→onboarding once, emits provisioning.started once, provisions to active', async () => {
    // Simulate a pre-P1-012 company exactly as migration 0010 leaves it: draft + six pending checkpoints +
    // P1-010 artifacts (profile v1, owner membership, company.created audit + activity projection).
    const co = await createOnboarding('Legacy Co');
    await seed.kysely.updateTable('companies').set({ status: 'draft' }).where('id', '=', co).execute();
    await seed.kysely.deleteFrom('audit_events').where('company_id', '=', co).where('name', '=', 'provisioning.started').execute();

    const r = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.provisioning.completed).toBe(true);
    expect(await companyStatus(co)).toBe('active');
    const names = await auditNames(co);
    expect(names.filter((n) => n === 'provisioning.started')).toHaveLength(1); // emitted exactly once, system actor
    const started = await seed.kysely.selectFrom('audit_events').select('actor_type').where('company_id', '=', co).where('name', '=', 'provisioning.started').executeTakeFirstOrThrow();
    expect(started.actor_type).toBe('system');
  });

  test('PAUSED company with incomplete checkpoints: resume fails closed (conflict) and mutates nothing', async () => {
    const co = await createOnboarding('Paused Co');
    await seed.kysely.updateTable('companies').set({ status: 'paused' }).where('id', '=', co).execute();
    const before = await stepRows(co);
    const r = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co });
    expect(r.status).toBe('conflict');
    expect(await stepRows(co)).toEqual(before);
    expect(await companyStatus(co)).toBe('paused'); // pause state untouched
  });

  test('authorization: owner read+resume; viewer read-only; non-member/forged/cross-account denied coarsely', async () => {
    const co = await createOnboarding('Authz Co');
    // Owner: read ok.
    expect((await getProvisioningStatus(app, { userId: ownerId, accountId, companyId: co })).status).toBe('ok');
    // Viewer with an active COMPANY membership: read ok, resume forbidden.
    await seed.kysely.insertInto('company_memberships').values({ account_id: accountId, company_id: co, member_user_id: viewerId, role: 'viewer', status: 'active' }).execute();
    expect((await getProvisioningStatus(app, { userId: viewerId, accountId, companyId: co })).status).toBe('ok');
    expect((await resumeProvisioning(app, { userId: viewerId, accountId, companyId: co })).status).toBe('forbidden');
    // An account member WITHOUT company membership: both denied (account ownership is not company authority).
    expect((await getProvisioningStatus(app, { userId: outsiderId, accountId, companyId: co })).status).toBe('forbidden');
    // Revoked company membership: denied.
    await seed.kysely.updateTable('company_memberships').set({ status: 'revoked' }).where('company_id', '=', co).where('member_user_id', '=', viewerId).execute();
    expect((await getProvisioningStatus(app, { userId: viewerId, accountId, companyId: co })).status).toBe('forbidden');
    // Cross-account forgery: another account's owner addressing this company under THEIR account → denied.
    const otherOwner = await seedUser(seed, 'other@example.com');
    const otherAccount = (await provisionPersonalAccount(app, otherOwner)).accountId;
    expect((await getProvisioningStatus(app, { userId: otherOwner, accountId: otherAccount, companyId: co })).status).toBe('forbidden');
    expect((await resumeProvisioning(app, { userId: otherOwner, accountId: otherAccount, companyId: co })).status).toBe('forbidden');
    // Nothing was mutated by any denied call.
    expect((await stepRows(co)).every((s) => s.status === 'pending')).toBe(true);
  });

  test('DTO privacy: the provisioning status exposes only the approved fields (no accountId/actor/free text)', async () => {
    const co = await createOnboarding('DTO Co');
    const r = await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co }, { stepEffects: { roadmap: failEffect('internal_error') } });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const json = JSON.stringify(r.provisioning);
    expect(json).not.toContain(accountId);
    expect(json).not.toContain(ownerId);
    expect(json).not.toContain('simulated');
    expect(json).not.toContain('stack');
    expect(Object.keys(r.provisioning).sort()).toEqual(['companyId', 'companyStatus', 'completed', 'exhausted', 'nextIncompleteStep', 'resumable', 'steps'].sort());
    for (const s of r.provisioning.steps) {
      expect(Object.keys(s).sort()).toEqual(['attempt', 'completedAt', 'failedAt', 'failureCode', 'order', 'requestedAt', 'startedAt', 'status', 'step'].sort());
    }
  });

  test('GUC cleanup: after full provisioning runs, a bare transaction sees no leaked account/company context', async () => {
    const co = await createOnboarding('GUC Co');
    await resumeProvisioning(app, { userId: ownerId, accountId, companyId: co });
    const gucs = await withTransaction(app, async (tx) => {
      const r = await sql<{ a: string | null; c: string | null }>`select current_setting('app.current_account', true) as a, current_setting('app.current_company', true) as c`.execute(tx.kysely);
      return r.rows[0]!;
    });
    expect(gucs.a === '' || gucs.a === null).toBe(true);
    expect(gucs.c === '' || gucs.c === null).toBe(true);
  });

  test('completeness: every provisioning operation writes its mapped registered event in the driver scenarios', async () => {
    // Structural coverage over the PROVISIONING partition: one company exercises start/step_start/step_complete/
    // complete (happy path); a second exercises step_fail/retry_request (fail + explicit retry).
    const happy = await createOnboarding('Complete A');
    await resumeProvisioning(app, { userId: ownerId, accountId, companyId: happy });
    const failing = await createOnboarding('Complete B');
    await resumeProvisioning(app, { userId: ownerId, accountId, companyId: failing }, { stepEffects: { documents: failEffect('internal_error') } });
    await resumeProvisioning(app, { userId: ownerId, accountId, companyId: failing }, { stepEffects: { documents: failEffect('internal_error') } });

    const produced = new Set([...(await auditNames(happy)), ...(await auditNames(failing))]);
    for (const op of PROVISIONING_AUDITED_OPERATION_IDS) {
      expect(produced.has(AUDITED_OPERATIONS[op])).toBe(true);
    }
    // And nothing unregistered was ever written.
    for (const n of produced) expect(Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, n)).toBe(true);
  });
});
