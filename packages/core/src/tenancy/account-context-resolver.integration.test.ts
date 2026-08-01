// ACBP-P1-005 / CDR-012 — real-PostgreSQL tests for the membership-backed account-context resolver.
// Trust-critical: proves account context resolves ONLY from an ACTIVE internal membership, that invited /
// revoked / missing / cross-account all deny, and that revocation takes effect on the next resolution.
// Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no migrate-down.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { isResolvedAccountContext, isDeniedAccountContext } from '@acbp/contracts';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { inviteMember, acceptInvite, revokeMember } from '../members/membership-service.js';
import { resolveAccountContext, runInAccountScope } from './account-context-resolver.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from './rls-integration-support.js';

// `seed` = superuser (schema + fixtures, bypasses RLS); `app` = restricted acbp_app (the actual
// application operations, subject to FORCE RLS). Proving the flows work under `app` is the RLS proof.
const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string, verified = true): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: `user_${seq}`, primary_email: email, email_verified: verified, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('account-context resolver (real PostgreSQL, restricted role) — ACBP-P1-005/006', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let ownerId: string;
  let accountId: string;

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
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
      for (const t of ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });
  beforeEach(async () => {
    await seed.kysely.deleteFrom('memberships').execute();
    await seed.kysely.deleteFrom('account_profiles').execute();
    await seed.kysely.deleteFrom('accounts').execute();
    await seed.kysely.deleteFrom('users').execute();
    ownerId = await seedUser(seed, 'owner@example.com');
    accountId = (await provisionPersonalAccount(app, ownerId)).accountId;
  });

  test('the founding owner (active membership) resolves to their account context', async () => {
    const r = await resolveAccountContext(app, { userId: ownerId, requestedAccountId: accountId });
    expect(isResolvedAccountContext(r)).toBe(true);
    if (isResolvedAccountContext(r)) expect(r.context).toEqual({ accountId, actorId: ownerId });
  });

  test('an accepted viewer (active membership) resolves', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'viewer@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(seed, 'viewer@example.com');
    await acceptInvite(app, { token: invite.token, acceptingUserId: viewerId });

    const r = await resolveAccountContext(app, { userId: viewerId, requestedAccountId: accountId });
    expect(isResolvedAccountContext(r) && r.context.actorId).toBe(viewerId);
  });

  test('an INVITED-but-not-accepted user has no active membership → denied', async () => {
    await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'pending@example.com', role: 'viewer' });
    const pendingUserId = await seedUser(seed, 'pending@example.com'); // signed in but never accepted
    const r = await resolveAccountContext(app, { userId: pendingUserId, requestedAccountId: accountId });
    expect(isDeniedAccountContext(r) && r.reason).toBe('membership_not_active');
  });

  test('a user with NO membership is denied', async () => {
    const strangerId = await seedUser(seed, 'stranger@example.com');
    const r = await resolveAccountContext(app, { userId: strangerId, requestedAccountId: accountId });
    expect(isDeniedAccountContext(r) && r.reason).toBe('membership_not_active');
  });

  test('cross-account: another account’s owner cannot resolve OUR account', async () => {
    const outsiderId = await seedUser(seed, 'outsider@example.com');
    const outsiderAccount = (await provisionPersonalAccount(app, outsiderId)).accountId;
    // Outsider is a valid owner of THEIR account, but requesting OURS denies (no membership here).
    const cross = await resolveAccountContext(app, { userId: outsiderId, requestedAccountId: accountId });
    expect(isDeniedAccountContext(cross) && cross.reason).toBe('membership_not_active');
    // And their own account still resolves — proving isolation, not a blanket denial.
    const own = await resolveAccountContext(app, { userId: outsiderId, requestedAccountId: outsiderAccount });
    expect(isResolvedAccountContext(own)).toBe(true);
  });

  test('revocation takes effect immediately on the next resolution', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'temp@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(seed, 'temp@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: viewerId });
    if (accepted.status !== 'ok') throw new Error('setup accept failed');

    // Active before revocation.
    expect(isResolvedAccountContext(await resolveAccountContext(app, { userId: viewerId, requestedAccountId: accountId }))).toBe(true);
    await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: accepted.membershipId });
    // Denied immediately after.
    const after = await resolveAccountContext(app, { userId: viewerId, requestedAccountId: accountId });
    expect(isDeniedAccountContext(after) && after.reason).toBe('membership_not_active');
  });

  test('a blank requested account id is denied as account_not_specified', async () => {
    const r = await resolveAccountContext(app, { userId: ownerId, requestedAccountId: '' });
    expect(isDeniedAccountContext(r) && r.reason).toBe('account_not_specified');
  });

  test('runInAccountScope runs the callback under a validated account scope for a member', async () => {
    // The SET LOCAL GUC behavior itself is proven in the @acbp/database account-tenant integration suite;
    // here we prove the composition mints a scope carrying the validated account and runs the callback.
    const run = await runInAccountScope(app, { userId: ownerId, requestedAccountId: accountId }, (scope) => Promise.resolve(scope.account.accountId));
    expect(run.kind).toBe('ran');
    if (run.kind === 'ran') expect(run.value).toBe(accountId);
  });

  test('runInAccountScope denies and NEVER runs the callback for a non-member (fail-closed)', async () => {
    const strangerId = await seedUser(seed, 'stranger2@example.com');
    let ran = false;
    const run = await runInAccountScope(app, { userId: strangerId, requestedAccountId: accountId }, () => {
      ran = true;
      return Promise.resolve(1);
    });
    expect(run.kind).toBe('denied');
    expect(ran).toBe(false);
    if (run.kind === 'denied') expect(run.reason).toBe('membership_not_active');
  });
});
