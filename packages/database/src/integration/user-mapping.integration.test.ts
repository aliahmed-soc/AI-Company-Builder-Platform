// ACBP-P1-002 — real-PostgreSQL integration tests for the user-mapping + webhook-receipt foundation
// (migration 0002; schema; CDR-008 invariants). Skips when ACBP_TEST_DATABASE_URL is unset; never
// mocked. Self-cleaning. Hosted CI runs this (preflight guard forbids silent skips).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, migrateDown, type DatabaseClient, type NewUser, type NewIdentityWebhookReceipt } from '../index.js';
import { createTestDatabase, hasTestDatabase } from './harness.js';

const HEX64 = 'a'.repeat(64);
const NOW = () => new Date().toISOString();

async function drop(client: DatabaseClient, table: string): Promise<void> {
  await sql.raw(`drop table if exists ${table} cascade`).execute(client.kysely);
}
async function cleanup(client: DatabaseClient): Promise<void> {
  // account_profiles/accounts (0003) are dropped child-first so a re-migrate on the shared CI
  // database cannot hit a stale later-ticket table (the _acbp_migration_probe lesson).
  for (const t of ['company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
    await drop(client, t);
  }
}
/** Attempt an insert; return the PostgreSQL SQLSTATE code, or undefined if it succeeded. */
async function userInsertError(client: DatabaseClient, values: NewUser): Promise<string | undefined> {
  try {
    await client.kysely.insertInto('users').values(values).execute();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}
function baseUser(overrides: Partial<NewUser> = {}): NewUser {
  return { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: 'user_1', provider_updated_at: NOW(), ...overrides };
}
function baseReceipt(overrides: Partial<NewIdentityWebhookReceipt> = {}): NewIdentityWebhookReceipt {
  return { provider: 'clerk', provider_instance_id: 'ins_a', event_id: 'evt_1', event_type: 'user.created', occurred_at: NOW(), ordering_timestamp: NOW(), payload_sha256: HEX64, ...overrides };
}

describe.skipIf(!hasTestDatabase)('user-mapping foundation (real PostgreSQL)', () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createTestDatabase();
    await cleanup(client);
    const r = await migrateToLatest(client);
    expect(r.error).toBeUndefined();
  });
  afterAll(async () => {
    if (client) {
      await cleanup(client);
      await closeDatabase(client);
    }
  });
  beforeEach(async () => {
    await client.kysely.deleteFrom('identity_webhook_receipts').execute();
    await client.kysely.deleteFrom('users').execute();
  });

  test('migration up created both tables', async () => {
    const r = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema='public' and table_name in ('users','identity_webhook_receipts')`.execute(client.kysely);
    expect(r.rows.map((x) => x.table_name).sort()).toEqual(['identity_webhook_receipts', 'users']);
  });

  test('provider identity uniqueness (provider, instance, user_id) is enforced', async () => {
    expect(await userInsertError(client, baseUser())).toBeUndefined();
    expect(await userInsertError(client, baseUser())).toBe('23505'); // duplicate identity
  });

  test('same provider_user_id in a different provider instance is allowed', async () => {
    expect(await userInsertError(client, baseUser({ provider_instance_id: 'ins_a' }))).toBeUndefined();
    expect(await userInsertError(client, baseUser({ provider_instance_id: 'ins_b' }))).toBeUndefined();
  });

  test('the same email across different provider identities is allowed (email not unique)', async () => {
    expect(await userInsertError(client, baseUser({ provider_user_id: 'user_1', primary_email: 'shared@example.com' }))).toBeUndefined();
    expect(await userInsertError(client, baseUser({ provider_user_id: 'user_2', primary_email: 'shared@example.com' }))).toBeUndefined();
    const n = await sql<{ n: number }>`select count(*)::int as n from users where primary_email='shared@example.com'`.execute(client.kysely);
    expect(n.rows[0]?.n).toBe(2);
  });

  test('status check constraint rejects unknown lifecycle values', async () => {
    expect(await userInsertError(client, baseUser({ status: 'pending' }))).toBe('23514');
  });

  test('active row may not carry deleted_at; deleted row must', async () => {
    expect(await userInsertError(client, baseUser({ status: 'active', deleted_at: NOW() }))).toBe('23514');
    expect(await userInsertError(client, baseUser({ provider_user_id: 'user_x', status: 'deleted', deleted_at: null }))).toBe('23514');
  });

  test('deleted rows cannot retain a primary email', async () => {
    expect(await userInsertError(client, baseUser({ status: 'deleted', deleted_at: NOW(), email_verified: false, primary_email: 'still@example.com' }))).toBe('23514');
  });

  test('deleted rows cannot remain email_verified=true', async () => {
    expect(await userInsertError(client, baseUser({ status: 'deleted', deleted_at: NOW(), primary_email: null, email_verified: true }))).toBe('23514');
  });

  test('a soft-deleted row with redacted PII is valid', async () => {
    expect(await userInsertError(client, baseUser({ status: 'deleted', deleted_at: NOW(), primary_email: null, email_verified: false }))).toBeUndefined();
  });

  test('receipt primary key (provider, instance, event_id) is enforced', async () => {
    await client.kysely.insertInto('identity_webhook_receipts').values(baseReceipt()).execute();
    let code: string | undefined;
    try {
      await client.kysely.insertInto('identity_webhook_receipts').values(baseReceipt()).execute();
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23505');
  });

  test('the same event_id in a different provider instance is allowed', async () => {
    await client.kysely.insertInto('identity_webhook_receipts').values(baseReceipt({ provider_instance_id: 'ins_a' })).execute();
    await client.kysely.insertInto('identity_webhook_receipts').values(baseReceipt({ provider_instance_id: 'ins_b' })).execute();
    const n = await sql<{ n: number }>`select count(*)::int as n from identity_webhook_receipts where event_id='evt_1'`.execute(client.kysely);
    expect(n.rows[0]?.n).toBe(2);
  });

  test('payload_sha256 must be lowercase 64-hex', async () => {
    let code: string | undefined;
    try {
      await client.kysely.insertInto('identity_webhook_receipts').values(baseReceipt({ payload_sha256: 'not-a-hash' })).execute();
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe('23514');
    // uppercase hex is also rejected (must be lowercase)
    let code2: string | undefined;
    try {
      await client.kysely.insertInto('identity_webhook_receipts').values(baseReceipt({ payload_sha256: 'A'.repeat(64) })).execute();
    } catch (e) {
      code2 = (e as { code?: string }).code;
    }
    expect(code2).toBe('23514');
  });

  test('the receipt table stores no raw payload (only the sha256 digest)', async () => {
    const cols = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema='public' and table_name='identity_webhook_receipts'`.execute(client.kysely);
    const names = cols.rows.map((c) => c.column_name);
    const payloadish = names.filter((n) => /payload|body|raw|signature|secret|header/i.test(n));
    expect(payloadish).toEqual(['payload_sha256']); // the ONLY payload-related column is the digest
  });

  test('the users table has no tenant/account/membership/role columns (CDR-008 users-only)', async () => {
    const cols = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema='public' and table_name='users'`.execute(client.kysely);
    const names = cols.rows.map((c) => c.column_name);
    for (const forbidden of ['tenant_id', 'account_id', 'company_id', 'organization_id', 'membership_id', 'role', 'permission', 'display_name']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('migration down removes the user-mapping tables and re-apply restores them', async () => {
    // Reverse one batch at a time until the user-mapping tables are gone. This stays correct as later
    // migrations (0003+) are added on top of 0002 — they (which may FK-reference users) reverse first.
    const usersTables = async () => {
      const r = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_schema='public' and table_name in ('users','identity_webhook_receipts')`.execute(client.kysely);
      return r.rows[0]?.n ?? 0;
    };
    for (let i = 0; i < 50 && (await usersTables()) > 0; i++) {
      const down = await migrateDown(client);
      expect(down.error).toBeUndefined();
      if ((down.results?.length ?? 0) === 0) break;
    }
    expect(await usersTables()).toBe(0);
    const reapply = await migrateToLatest(client);
    expect(reapply.error).toBeUndefined();
    expect(await usersTables()).toBe(2);
  });
});
