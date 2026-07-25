// ACBP-P1-003 â€” real-PostgreSQL tests for account provisioning + profile use cases (CDR-010). Proves
// first-sign-in provisioning is idempotent, the profile view exposes the Clerk-authoritative email
// read-only, profile edits persist, and the interim audit events are emitted. Skips when
// ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no migrate-down.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { createTestLogger } from '@acbp/observability';
import { provisionPersonalAccount } from './provisioning.js';
import { getProfileForOwner, updateProfileForOwner } from './profile.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

// Provisioning + profile flows run as the restricted `acbp_app` role (subject to FORCE RLS); user fixtures
// are seeded via the superuser `seed` client. Proving the flows under `app` is the end-to-end RLS proof.
const NOW = () => new Date().toISOString();
async function seedUser(seed: DatabaseClient, overrides: Partial<NewUser> = {}): Promise<string> {
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: 'user_1', primary_email: 'owner@example.com', email_verified: true, provider_updated_at: NOW(), ...overrides };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('account provisioning + profile (real PostgreSQL, restricted role) â€” ACBP-P1-003/006', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of ['usage_events', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
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
      for (const t of ['usage_events', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });
  beforeEach(async () => {
    await seed.kysely.deleteFrom('account_profiles').execute();
    await seed.kysely.deleteFrom('accounts').execute();
    await seed.kysely.deleteFrom('users').execute();
  });

  test('first sign-in provisions an account + profile and emits account.created', async () => {
    const userId = await seedUser(seed);
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const result = await provisionPersonalAccount(app, userId, { logger });
    expect(result.created).toBe(true);

    const view = await getProfileForOwner(app, userId);
    expect(view).toBeDefined();
    expect(view?.accountId).toBe(result.accountId);
    expect(view?.displayName).toBeNull();
    expect(view?.locale).toBe('en');
    // Email is the Clerk-authoritative value from the users row (read-only).
    expect(view?.email).toBe('owner@example.com');
    expect(view?.emailVerified).toBe(true);

    const created = records.filter((r) => r.event === 'account.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata).toEqual({ accountId: result.accountId, planState: 'free' });
  });

  test('provisioning is idempotent (one account; second call created=false, no event)', async () => {
    const userId = await seedUser(seed);
    const first = await provisionPersonalAccount(app, userId);
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const second = await provisionPersonalAccount(app, userId, { logger });
    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);
    const n = await seed.kysely.selectFrom('accounts').select(seed.kysely.fn.countAll<string>().as('n')).where('created_by_user_id', '=', userId).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
    expect(records.filter((r) => r.event === 'account.created')).toHaveLength(0);
  });

  test('profile edits persist and email is never changed; emits account.profile_updated', async () => {
    const userId = await seedUser(seed);
    await provisionPersonalAccount(app, userId);
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const updated = await updateProfileForOwner(app, userId, { displayName: '  Ada Lovelace  ', locale: 'en-GB' }, { logger });
    expect(updated?.displayName).toBe('Ada Lovelace'); // trimmed
    expect(updated?.locale).toBe('en-GB');
    expect(updated?.email).toBe('owner@example.com'); // unchanged, Clerk-authoritative

    // Persisted: a fresh read returns the edit.
    const reread = await getProfileForOwner(app, userId);
    expect(reread?.displayName).toBe('Ada Lovelace');
    expect(reread?.locale).toBe('en-GB');

    const updatedEvents = records.filter((r) => r.event === 'account.profile_updated');
    expect(updatedEvents).toHaveLength(1);
    expect(updatedEvents[0]?.metadata).toEqual({ accountId: updated?.accountId });
  });

  test('a no-op update (empty patch) returns the current view and emits no audit event', async () => {
    const userId = await seedUser(seed);
    await provisionPersonalAccount(app, userId);
    await updateProfileForOwner(app, userId, { displayName: 'Ada' });
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const view = await updateProfileForOwner(app, userId, {}, { logger });
    expect(view?.displayName).toBe('Ada'); // unchanged
    expect(records.filter((r) => r.event === 'account.profile_updated')).toHaveLength(0);
  });

  test('clearing the display name via empty string sets it to null', async () => {
    const userId = await seedUser(seed);
    await provisionPersonalAccount(app, userId);
    await updateProfileForOwner(app, userId, { displayName: 'Temp' });
    const cleared = await updateProfileForOwner(app, userId, { displayName: '' });
    expect(cleared?.displayName).toBeNull();
  });

  test('profile:read and profile:update DENY for a non-owner active member, opaquely + audited (authz seam) â€” ACBP-P1-007', async () => {
    const userId = await seedUser(seed);
    const { accountId } = await provisionPersonalAccount(app, userId);
    // Force the caller to be an ACTIVE but NON-owner (viewer) member of their own account, so the P1-005
    // membership gate PASSES (runInAccountScope resolves) and the P1-007 role check is what denies. This
    // state is unreachable by product construction today (provisioning always makes the founder an owner),
    // so we seed the role directly via the superuser client to exercise the authz seam. Production code is
    // unchanged; only the DB fixture forces the otherwise-unreachable role.
    await seed.kysely.updateTable('memberships').set({ role: 'viewer' }).where('account_id', '=', accountId).where('member_user_id', '=', userId).execute();

    const { logger, records } = createTestLogger({ component: 'accounts' });
    // Both denials are OPAQUE (undefined â€” the request layer maps this to not_found/forbidden, never a role oracle).
    expect(await getProfileForOwner(app, userId, { logger })).toBeUndefined();
    expect(await updateProfileForOwner(app, userId, { displayName: 'Should Not Persist' }, { logger })).toBeUndefined();

    // The update denied BEFORE any write â€” the profile row is untouched.
    const row = await seed.kysely.selectFrom('account_profiles').select(['display_name']).where('account_id', '=', accountId).executeTakeFirst();
    expect(row?.display_name ?? null).toBeNull();

    // Both denials audited via non-PII authz.denied {action, reason, accountId, actorId}.
    const denied = records.filter((r) => r.event === 'authz.denied');
    expect(denied.map((d) => d.metadata?.['action']).sort()).toEqual(['profile:read', 'profile:update']);
    for (const d of denied) {
      expect(d.metadata).toMatchObject({ reason: 'insufficient_role', accountId, actorId: userId });
      expect(JSON.stringify(d)).not.toContain('@'); // no email/PII in the denial audit
    }
  });

  test('profile access ensures the personal account (RLS requires the account id via provisioning)', async () => {
    // Under FORCE RLS (ACBP-P1-006) the profile ops obtain the account id from the idempotent provisioning
    // bootstrap function, so first access provisions the caller's own account rather than returning undefined.
    const userId = await seedUser(seed, { provider_user_id: 'user_no_acct' });
    const view = await getProfileForOwner(app, userId);
    expect(view?.accountId).toBeDefined();
    expect(view?.locale).toBe('en');
    const updated = await updateProfileForOwner(app, userId, { locale: 'en-GB' });
    expect(updated?.locale).toBe('en-GB');
  });
});
