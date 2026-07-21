// ACBP-P1-003 — real-PostgreSQL tests for account provisioning + profile use cases (CDR-010). Proves
// first-sign-in provisioning is idempotent, the profile view exposes the Clerk-authoritative email
// read-only, profile edits persist, and the interim audit events are emitted. Skips when
// ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no migrate-down.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { createTestLogger } from '@acbp/observability';
import { provisionPersonalAccount } from './provisioning.js';
import { getProfileForOwner, updateProfileForOwner } from './profile.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
function createTestDatabase(): DatabaseClient {
  return createDatabase(
    parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-integration' }),
  );
}

const NOW = () => new Date().toISOString();
async function seedUser(client: DatabaseClient, overrides: Partial<NewUser> = {}): Promise<string> {
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: 'user_1', primary_email: 'owner@example.com', email_verified: true, provider_updated_at: NOW(), ...overrides };
  const row = await client.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('account provisioning + profile (real PostgreSQL)', () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createTestDatabase();
    for (const t of ['memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await client.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(client);
    expect(r.error).toBeUndefined();
  });
  afterAll(async () => {
    if (client) {
      for (const t of ['memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await client.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(client);
    }
  });
  beforeEach(async () => {
    await client.kysely.deleteFrom('account_profiles').execute();
    await client.kysely.deleteFrom('accounts').execute();
    await client.kysely.deleteFrom('users').execute();
  });

  test('first sign-in provisions an account + profile and emits account.created', async () => {
    const userId = await seedUser(client);
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const result = await provisionPersonalAccount(client, userId, { logger });
    expect(result.created).toBe(true);

    const view = await getProfileForOwner(client, userId);
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
    const userId = await seedUser(client);
    const first = await provisionPersonalAccount(client, userId);
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const second = await provisionPersonalAccount(client, userId, { logger });
    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);
    const n = await client.kysely.selectFrom('accounts').select(client.kysely.fn.countAll<string>().as('n')).where('created_by_user_id', '=', userId).executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
    expect(records.filter((r) => r.event === 'account.created')).toHaveLength(0);
  });

  test('profile edits persist and email is never changed; emits account.profile_updated', async () => {
    const userId = await seedUser(client);
    await provisionPersonalAccount(client, userId);
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const updated = await updateProfileForOwner(client, userId, { displayName: '  Ada Lovelace  ', locale: 'en-GB' }, { logger });
    expect(updated?.displayName).toBe('Ada Lovelace'); // trimmed
    expect(updated?.locale).toBe('en-GB');
    expect(updated?.email).toBe('owner@example.com'); // unchanged, Clerk-authoritative

    // Persisted: a fresh read returns the edit.
    const reread = await getProfileForOwner(client, userId);
    expect(reread?.displayName).toBe('Ada Lovelace');
    expect(reread?.locale).toBe('en-GB');

    const updatedEvents = records.filter((r) => r.event === 'account.profile_updated');
    expect(updatedEvents).toHaveLength(1);
    expect(updatedEvents[0]?.metadata).toEqual({ accountId: updated?.accountId });
  });

  test('a no-op update (empty patch) returns the current view and emits no audit event', async () => {
    const userId = await seedUser(client);
    await provisionPersonalAccount(client, userId);
    await updateProfileForOwner(client, userId, { displayName: 'Ada' });
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const view = await updateProfileForOwner(client, userId, {}, { logger });
    expect(view?.displayName).toBe('Ada'); // unchanged
    expect(records.filter((r) => r.event === 'account.profile_updated')).toHaveLength(0);
  });

  test('clearing the display name via empty string sets it to null', async () => {
    const userId = await seedUser(client);
    await provisionPersonalAccount(client, userId);
    await updateProfileForOwner(client, userId, { displayName: 'Temp' });
    const cleared = await updateProfileForOwner(client, userId, { displayName: '' });
    expect(cleared?.displayName).toBeNull();
  });

  test('profile access for a user with no account returns undefined', async () => {
    const userId = await seedUser(client, { provider_user_id: 'user_no_acct' });
    expect(await getProfileForOwner(client, userId)).toBeUndefined();
    expect(await updateProfileForOwner(client, userId, { locale: 'en' })).toBeUndefined();
  });
});
