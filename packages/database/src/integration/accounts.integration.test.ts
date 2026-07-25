// ACBP-P1-003 — real-PostgreSQL integration tests for the account + profile foundation (migration
// 0003; schema; repositories; CDR-010 invariants). Skips when ACBP_TEST_DATABASE_URL is unset; never
// mocked. Self-cleaning. Hosted CI runs this (preflight guard forbids silent skips).
//
// This suite does NOT run its own migrate-down: migration reversibility is covered by the
// database/user-mapping suites (kept to a single migrate-down across the shared CI database to
// minimise the destructive-window during parallel runs).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import {
  closeDatabase,
  migrateToLatest,
  AccountRepository,
  AccountProfileRepository,
  type DatabaseClient,
  type NewUser,
  type NewAccount,
  type NewAccountProfile,
} from '../index.js';
import { createTestDatabase, hasTestDatabase } from './harness.js';

const NOW = () => new Date().toISOString();

async function drop(client: DatabaseClient, table: string): Promise<void> {
  await sql.raw(`drop table if exists ${table} cascade`).execute(client.kysely);
}
async function cleanup(client: DatabaseClient): Promise<void> {
  // Drop 0003 (child-first) + 0002 tables + probe + migration bookkeeping so a re-migrate on the
  // shared CI database cannot hit a stale table (the _acbp_migration_probe lesson from P1-002).
  for (const t of ['usage_events', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'task_dependencies', 'tasks', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
    await drop(client, t);
  }
}

/** Insert a users row (FK target for accounts) and return its generated id. */
async function seedUser(client: DatabaseClient, overrides: Partial<NewUser> = {}): Promise<string> {
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: 'user_1', provider_updated_at: NOW(), ...overrides };
  const row = await client.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

/** Attempt an account insert; return the PostgreSQL SQLSTATE code, or undefined if it succeeded. */
async function accountInsertError(client: DatabaseClient, values: NewAccount): Promise<string | undefined> {
  try {
    await client.kysely.insertInto('accounts').values(values).execute();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}
async function profileInsertError(client: DatabaseClient, values: NewAccountProfile): Promise<string | undefined> {
  try {
    await client.kysely.insertInto('account_profiles').values(values).execute();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe.skipIf(!hasTestDatabase)('account + profile foundation (real PostgreSQL)', () => {
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
    // Child-first; users last (accounts FK-references users).
    await client.kysely.deleteFrom('account_profiles').execute();
    await client.kysely.deleteFrom('accounts').execute();
    await client.kysely.deleteFrom('users').execute();
  });

  test('migration 0003 created both account tables', async () => {
    const r = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema='public' and table_name in ('accounts','account_profiles')`.execute(client.kysely);
    expect(r.rows.map((x) => x.table_name).sort()).toEqual(['account_profiles', 'accounts']);
  });

  test('accounts is A-root: no company/tenant/membership/role columns', async () => {
    const cols = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema='public' and table_name='accounts'`.execute(client.kysely);
    const names = cols.rows.map((c) => c.column_name);
    for (const forbidden of ['company_id', 'tenant_id', 'organization_id', 'membership_id', 'role', 'permission']) {
      expect(names).not.toContain(forbidden);
    }
    expect(names).toContain('created_by_user_id');
  });

  test('account_profiles holds no email column (email stays Clerk-authoritative on users)', async () => {
    const cols = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema='public' and table_name='account_profiles'`.execute(client.kysely);
    const names = cols.rows.map((c) => c.column_name);
    expect(names.filter((n) => /email/i.test(n))).toEqual([]);
  });

  test('created_by_user_id must reference an existing user (FK enforced)', async () => {
    // A random uuid that is not a real user id → foreign-key violation.
    expect(await accountInsertError(client, { created_by_user_id: '00000000-0000-0000-0000-000000000000' })).toBe('23503');
  });

  test('one personal account per owner (created_by_user_id is unique)', async () => {
    const userId = await seedUser(client);
    expect(await accountInsertError(client, { created_by_user_id: userId })).toBeUndefined();
    expect(await accountInsertError(client, { created_by_user_id: userId })).toBe('23505');
  });

  test('status check rejects unknown lifecycle values; defaults to active', async () => {
    const userId = await seedUser(client);
    expect(await accountInsertError(client, { created_by_user_id: userId, status: 'frozen' })).toBe('23514');
    const row = await client.kysely.insertInto('accounts').values({ created_by_user_id: userId }).returningAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('active');
    expect(row.plan_state).toBe('free');
  });

  test('plan_state must be non-empty', async () => {
    const userId = await seedUser(client);
    expect(await accountInsertError(client, { created_by_user_id: userId, plan_state: '' })).toBe('23514');
  });

  test('AccountRepository.insertIfAbsent is idempotent per owner', async () => {
    const userId = await seedUser(client);
    const repo = new AccountRepository(client.kysely);
    const first = await repo.insertIfAbsent({ created_by_user_id: userId });
    const second = await repo.insertIfAbsent({ created_by_user_id: userId });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id); // same account, no duplicate
    const n = await sql<{ n: number }>`select count(*)::int as n from accounts where created_by_user_id=${userId}`.execute(client.kysely);
    expect(n.rows[0]?.n).toBe(1);
  });

  test('findByOwner resolves the caller-scoped account', async () => {
    const userId = await seedUser(client);
    const repo = new AccountRepository(client.kysely);
    const created = await repo.insertIfAbsent({ created_by_user_id: userId });
    const found = await repo.findByOwner(userId);
    expect(found?.id).toBe(created.row.id);
    expect(await repo.findByOwner('11111111-1111-1111-1111-111111111111')).toBeUndefined();
  });

  test('profile locale check rejects malformed values; defaults to en', async () => {
    const userId = await seedUser(client);
    const account = await client.kysely.insertInto('accounts').values({ created_by_user_id: userId }).returningAll().executeTakeFirstOrThrow();
    expect(await profileInsertError(client, { account_id: account.id, locale: 'english!' })).toBe('23514');
    const row = await client.kysely.insertInto('account_profiles').values({ account_id: account.id }).returningAll().executeTakeFirstOrThrow();
    expect(row.locale).toBe('en');
    expect(row.display_name).toBeNull();
  });

  test('profile display_name must be non-empty when set and within length bounds', async () => {
    const userId = await seedUser(client);
    const account = await client.kysely.insertInto('accounts').values({ created_by_user_id: userId }).returningAll().executeTakeFirstOrThrow();
    expect(await profileInsertError(client, { account_id: account.id, display_name: '' })).toBe('23514');
    expect(await profileInsertError(client, { account_id: account.id, display_name: 'x'.repeat(201) })).toBe('23514');
  });

  test('a profile requires an existing account (FK) and is unique per account (PK)', async () => {
    expect(await profileInsertError(client, { account_id: '00000000-0000-0000-0000-000000000000' })).toBe('23503');
    const userId = await seedUser(client);
    const account = await client.kysely.insertInto('accounts').values({ created_by_user_id: userId }).returningAll().executeTakeFirstOrThrow();
    expect(await profileInsertError(client, { account_id: account.id })).toBeUndefined();
    expect(await profileInsertError(client, { account_id: account.id })).toBe('23505'); // 1:1
  });

  test('deleting an account cascades to its profile', async () => {
    const userId = await seedUser(client);
    const account = await client.kysely.insertInto('accounts').values({ created_by_user_id: userId }).returningAll().executeTakeFirstOrThrow();
    await client.kysely.insertInto('account_profiles').values({ account_id: account.id }).execute();
    await client.kysely.deleteFrom('accounts').where('id', '=', account.id).execute();
    const n = await sql<{ n: number }>`select count(*)::int as n from account_profiles where account_id=${account.id}`.execute(client.kysely);
    expect(n.rows[0]?.n).toBe(0);
  });

  test('AccountProfileRepository.update persists edits and stamps updated_at', async () => {
    const userId = await seedUser(client);
    const accountRepo = new AccountRepository(client.kysely);
    const profileRepo = new AccountProfileRepository(client.kysely);
    const { row: account } = await accountRepo.insertIfAbsent({ created_by_user_id: userId });
    const { row: profile } = await profileRepo.insertIfAbsent({ account_id: account.id });
    const updated = await profileRepo.update(account.id, { display_name: 'Ada Lovelace', locale: 'en-GB' });
    expect(updated?.display_name).toBe('Ada Lovelace');
    expect(updated?.locale).toBe('en-GB');
    expect(new Date(updated?.updated_at ?? 0).getTime()).toBeGreaterThanOrEqual(new Date(profile.updated_at).getTime());
    // Persisted: re-read returns the edit.
    const reread = await profileRepo.findByAccount(account.id);
    expect(reread?.display_name).toBe('Ada Lovelace');
  });

  test('AccountProfileRepository.update cannot move a profile to another account', async () => {
    const userId = await seedUser(client);
    const accountRepo = new AccountRepository(client.kysely);
    const profileRepo = new AccountProfileRepository(client.kysely);
    const { row: account } = await accountRepo.insertIfAbsent({ created_by_user_id: userId });
    await profileRepo.insertIfAbsent({ account_id: account.id });
    // account_id in the patch is ignored — the row stays keyed to the original account.
    const updated = await profileRepo.update(account.id, { account_id: '22222222-2222-2222-2222-222222222222', display_name: 'Grace' });
    expect(updated?.account_id).toBe(account.id);
  });
});
