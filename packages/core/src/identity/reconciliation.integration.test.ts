// ACBP-P1-002 — real-PostgreSQL nightly reconciliation tests. Proves forward-drift repair, idempotency,
// last-write-wins (no overwrite of newer state), non-destructive not_found/unavailable handling, no
// tombstone resurrection, and keyset pagination. Skips when ACBP_TEST_DATABASE_URL is unset; never
// mocked. Self-cleaning. Fake identities + injected reader (no live Clerk).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, type DatabaseClient, type UserRow, type ProviderIdentityKey } from '@acbp/database';
import type { AuthoritativeIdentityReader, AuthoritativeIdentityResult, VerifiedIdentityWebhookEvent } from '@acbp/contracts';
import { reconcileAllUsers } from './reconciliation.js';
import { processVerifiedIdentityEvent } from './webhook-processor.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
function createTestDatabase(): DatabaseClient {
  return createDatabase(
    parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-integration' }),
  );
}

const INSTANCE = 'ins_1';
const hex = (c: string): string => c.repeat(64);

function createEvent(userId: string, ts: string, email: string): VerifiedIdentityWebhookEvent {
  return {
    provider: 'clerk',
    providerInstanceId: INSTANCE,
    eventId: `evt_${userId}`,
    occurredAt: ts,
    payloadSha256: hex('a'),
    type: 'user.created',
    providerUserId: userId,
    orderingTimestamp: ts,
    user: { providerUserId: userId, primaryEmail: email, emailVerified: false, providerUpdatedAt: ts, providerCreatedAt: '2025-12-01T00:00:00.000Z' },
  };
}
function deleteEvent(userId: string, ts: string): VerifiedIdentityWebhookEvent {
  return { provider: 'clerk', providerInstanceId: INSTANCE, eventId: `evt_del_${userId}`, occurredAt: ts, payloadSha256: hex('d'), type: 'user.deleted', providerUserId: userId, orderingTimestamp: ts };
}

class MapReader implements AuthoritativeIdentityReader {
  constructor(private readonly byUser: Record<string, AuthoritativeIdentityResult>) {}
  read(query: ProviderIdentityKey): Promise<AuthoritativeIdentityResult> {
    return Promise.resolve(this.byUser[query.providerUserId] ?? { status: 'not_found' });
  }
}
function found(userId: string, ts: string, email: string, verified = true): AuthoritativeIdentityResult {
  return {
    status: 'found',
    snapshot: { provider: 'clerk', providerInstanceId: INSTANCE, providerUserId: userId, primaryEmail: email, emailVerified: verified, providerCreatedAt: null, providerUpdatedAt: new Date(ts) },
  };
}

describe.skipIf(!hasTestDatabase)('nightly reconciliation (real PostgreSQL)', () => {
  let client: DatabaseClient;
  const getUser = (userId: string): Promise<UserRow | undefined> =>
    client.kysely.selectFrom('users').selectAll().where('provider', '=', 'clerk').where('provider_instance_id', '=', INSTANCE).where('provider_user_id', '=', userId).executeTakeFirst();

  beforeAll(async () => {
    client = createTestDatabase();
    for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'job_checkpoints', 'jobs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) await client.kysely.schema.dropTable(t).ifExists().cascade().execute();
    const r = await migrateToLatest(client);
    expect(r.error).toBeUndefined();
  });
  afterAll(async () => {
    if (client) {
      for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'job_checkpoints', 'jobs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await client.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(client);
    }
  });
  beforeEach(async () => {
    await client.kysely.deleteFrom('identity_webhook_receipts').execute();
    await client.kysely.deleteFrom('users').execute();
  });

  test('repairs forward drift, then is idempotent', async () => {
    await processVerifiedIdentityEvent(client, createEvent('user_a', '2026-01-01T10:00:00.000Z', 'old@example.com'));
    const reader = new MapReader({ user_a: found('user_a', '2026-01-01T12:00:00.000Z', 'new@example.com', true) });
    const first = await reconcileAllUsers(client, reader);
    expect(first).toEqual({ scanned: 1, inSync: 0, repaired: 1, providerMissing: 0, providerUnavailable: 0 });
    const u = await getUser('user_a');
    expect(u?.primary_email).toBe('new@example.com');
    expect(u?.email_verified).toBe(true);
    expect(u?.last_event_id).toBe('evt_user_a'); // reconciliation leaves last_event_id unchanged
    const second = await reconcileAllUsers(client, reader);
    expect(second).toEqual({ scanned: 1, inSync: 1, repaired: 0, providerMissing: 0, providerUnavailable: 0 });
  });

  test('does not overwrite a newer stored row (last-write-wins)', async () => {
    await processVerifiedIdentityEvent(client, createEvent('user_a', '2026-02-01T00:00:00.000Z', 'keep@example.com'));
    const reader = new MapReader({ user_a: found('user_a', '2026-01-01T00:00:00.000Z', 'stale@example.com') });
    const s = await reconcileAllUsers(client, reader);
    expect(s.repaired).toBe(0);
    expect(s.inSync).toBe(1);
    expect((await getUser('user_a'))?.primary_email).toBe('keep@example.com');
  });

  test('provider not_found is non-destructive (row stays active)', async () => {
    await processVerifiedIdentityEvent(client, createEvent('gone', '2026-01-01T10:00:00.000Z', 'gone@example.com'));
    const s = await reconcileAllUsers(client, new MapReader({ gone: { status: 'not_found' } }));
    expect(s.providerMissing).toBe(1);
    const u = await getUser('gone');
    expect(u?.status).toBe('active');
    expect(u?.primary_email).toBe('gone@example.com');
  });

  test('provider unavailable is skipped without change', async () => {
    await processVerifiedIdentityEvent(client, createEvent('user_a', '2026-01-01T10:00:00.000Z', 'keep@example.com'));
    const err = { category: 'provider_unavailable', code: 'DEPENDENCY_UNAVAILABLE', message: 'x', retryable: true } as const;
    const s = await reconcileAllUsers(client, new MapReader({ user_a: { status: 'unavailable', error: err } }));
    expect(s.providerUnavailable).toBe(1);
    expect((await getUser('user_a'))?.primary_email).toBe('keep@example.com');
  });

  test('tombstones are not scanned and never resurrected', async () => {
    await processVerifiedIdentityEvent(client, createEvent('active_u', '2026-01-01T10:00:00.000Z', 'a@example.com'));
    await processVerifiedIdentityEvent(client, deleteEvent('dead_u', '2026-01-02T10:00:00.000Z')); // delete-before-create tombstone
    const reader = new MapReader({ active_u: found('active_u', '2026-01-03T00:00:00.000Z', 'a2@example.com'), dead_u: found('dead_u', '2026-01-09T00:00:00.000Z', 'ghost@example.com') });
    const s = await reconcileAllUsers(client, reader);
    expect(s.scanned).toBe(1); // only the active row
    expect(s.repaired).toBe(1);
    const dead = await getUser('dead_u');
    expect(dead?.status).toBe('deleted');
    expect(dead?.primary_email).toBeNull(); // never resurrected / re-populated
  });

  test('keyset pagination reconciles every active row across batches', async () => {
    for (let i = 0; i < 5; i++) await processVerifiedIdentityEvent(client, createEvent(`u${i}`, '2026-01-01T10:00:00.000Z', `u${i}old@example.com`));
    const reader = new MapReader(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`u${i}`, found(`u${i}`, '2026-01-05T00:00:00.000Z', `u${i}new@example.com`)])));
    const s = await reconcileAllUsers(client, reader, { batchSize: 2 });
    expect(s.scanned).toBe(5);
    expect(s.repaired).toBe(5);
    expect((await getUser('u3'))?.primary_email).toBe('u3new@example.com');
  });
});
