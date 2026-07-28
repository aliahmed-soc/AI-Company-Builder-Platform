// ACBP-P1-004 — real-PostgreSQL tests for the membership foundation (migration 0004; schema; repository;
// CDR-011 invariants). Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no
// migrate-down (reversibility is covered by the database/user-mapping suites).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, MembershipRepository, type DatabaseClient, type NewUser, type NewMembership } from '../index.js';
import { createTestDatabase, hasTestDatabase } from './harness.js';

const NOW = () => new Date().toISOString();
const HASH = (c: string) => c.repeat(64);

async function drop(client: DatabaseClient, table: string): Promise<void> {
  await sql.raw(`drop table if exists ${table} cascade`).execute(client.kysely);
}
async function cleanup(client: DatabaseClient): Promise<void> {
  for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'artifacts', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
    await drop(client, t);
  }
}
async function seedUser(client: DatabaseClient, overrides: Partial<NewUser> = {}): Promise<string> {
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: 'user_1', provider_updated_at: NOW(), ...overrides };
  const row = await client.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}
async function seedAccount(client: DatabaseClient, ownerUserId: string): Promise<string> {
  const row = await client.kysely.insertInto('accounts').values({ created_by_user_id: ownerUserId }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}
async function membershipInsertError(client: DatabaseClient, values: NewMembership): Promise<string | undefined> {
  try {
    await client.kysely.insertInto('memberships').values(values).execute();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

describe.skipIf(!hasTestDatabase)('membership foundation (real PostgreSQL)', () => {
  let client: DatabaseClient;
  let userId: string;
  let accountId: string;

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
    await client.kysely.deleteFrom('memberships').execute();
    await client.kysely.deleteFrom('account_profiles').execute();
    await client.kysely.deleteFrom('accounts').execute();
    await client.kysely.deleteFrom('users').execute();
    userId = await seedUser(client);
    accountId = await seedAccount(client, userId);
  });

  test('migration 0004 created the memberships table with no company FK yet', async () => {
    const t = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema='public' and table_name='memberships'`.execute(client.kysely);
    expect(t.rows).toHaveLength(1);
    // company_id column exists but has NO foreign key (companies is P1-010).
    const fks = await sql<{ constraint_name: string }>`
      select con.conname as constraint_name
      from pg_constraint con join pg_class rel on rel.oid = con.conrelid
      where rel.relname='memberships' and con.contype='f'`.execute(client.kysely);
    const names = fks.rows.map((r) => r.constraint_name);
    expect(names).toContain('memberships_account_fk');
    expect(names).toContain('memberships_member_user_fk');
    expect(names.some((n) => n.includes('company'))).toBe(false); // no company FK
  });

  test('account_id and member_user_id are foreign keys', async () => {
    // Bad account on a pending invite (member_user_id null).
    expect(await membershipInsertError(client, { account_id: '00000000-0000-0000-0000-000000000000', role: 'viewer', status: 'invited', invited_email: 'x@example.com', invite_token_hash: HASH('a') })).toBe('23503');
    // Bad member_user_id on an active membership.
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: '00000000-0000-0000-0000-000000000000', role: 'owner', status: 'active' })).toBe('23503');
  });

  test('role and status check constraints reject unknown values', async () => {
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: userId, role: 'admin', status: 'active' })).toBe('23514');
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: userId, role: 'owner', status: 'frozen' })).toBe('23514');
  });

  test('an active membership must be bound to a user', async () => {
    expect(await membershipInsertError(client, { account_id: accountId, role: 'owner', status: 'active', member_user_id: null })).toBe('23514');
  });

  test('a pending invite must carry email + token hash and no user', async () => {
    expect(await membershipInsertError(client, { account_id: accountId, role: 'viewer', status: 'invited', invited_email: null, invite_token_hash: HASH('a') })).toBe('23514');
    expect(await membershipInsertError(client, { account_id: accountId, role: 'viewer', status: 'invited', invited_email: 'x@example.com', invite_token_hash: null })).toBe('23514');
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: userId, role: 'viewer', status: 'invited', invited_email: 'x@example.com', invite_token_hash: HASH('a') })).toBe('23514');
  });

  test('a token hash may exist only on a pending invite; a revoked row needs a timestamp', async () => {
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: userId, role: 'owner', status: 'active', invite_token_hash: HASH('a') })).toBe('23514');
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: userId, role: 'viewer', status: 'revoked', revoked_at: null })).toBe('23514');
  });

  test('at most one active membership per (account, user)', async () => {
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: userId, role: 'owner', status: 'active' })).toBeUndefined();
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: userId, role: 'viewer', status: 'active' })).toBe('23505');
  });

  test('at most one outstanding invite per (account, email); token hash is unique', async () => {
    expect(await membershipInsertError(client, { account_id: accountId, role: 'viewer', status: 'invited', invited_email: 'dup@example.com', invite_token_hash: HASH('a') })).toBeUndefined();
    // Same account+email, different token → still blocked (one outstanding invite).
    expect(await membershipInsertError(client, { account_id: accountId, role: 'viewer', status: 'invited', invited_email: 'dup@example.com', invite_token_hash: HASH('b') })).toBe('23505');
    // Different email, reuse the FIRST token hash → token-hash uniqueness blocks it.
    expect(await membershipInsertError(client, { account_id: accountId, role: 'viewer', status: 'invited', invited_email: 'other@example.com', invite_token_hash: HASH('a') })).toBe('23505');
  });

  test('company_id accepts a value with no FK enforcement (structural hook)', async () => {
    // No companies table exists, so any uuid is accepted (P1-010 will attach the FK).
    expect(await membershipInsertError(client, { account_id: accountId, member_user_id: userId, role: 'owner', status: 'active', company_id: '99999999-9999-9999-9999-999999999999' })).toBeUndefined();
  });

  test('MembershipRepository.insertOwnerIfAbsent is idempotent', async () => {
    const repo = new MembershipRepository(client.kysely);
    const first = await repo.insertOwnerIfAbsent(accountId, userId);
    const second = await repo.insertOwnerIfAbsent(accountId, userId);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(first.row.role).toBe('owner');
    expect(first.row.status).toBe('active');
    const n = await sql<{ n: number }>`select count(*)::int as n from memberships where account_id=${accountId}`.execute(client.kysely);
    expect(n.rows[0]?.n).toBe(1);
  });

  test('an invite can be accepted (bound to a user, token cleared) via the repository', async () => {
    const repo = new MembershipRepository(client.kysely);
    const invite = await repo.insert({ account_id: accountId, role: 'viewer', status: 'invited', invited_email: 'joiner@example.com', invite_token_hash: HASH('c'), invited_by_user_id: userId });
    const joiner = await seedUser(client, { provider_user_id: 'user_joiner', primary_email: 'joiner@example.com', email_verified: true });
    const accepted = await repo.update(invite.id, { status: 'active', member_user_id: joiner, invite_token_hash: null, accepted_at: NOW() });
    expect(accepted?.status).toBe('active');
    expect(accepted?.member_user_id).toBe(joiner);
    expect(accepted?.invite_token_hash).toBeNull();
    // The active membership is now resolvable for that user.
    expect((await repo.findActiveByAccountAndUser(accountId, joiner))?.id).toBe(invite.id);
  });

  test('owner backfill inserts one active owner per account and is idempotent', async () => {
    // Replicates migration 0004's backfill statement against the seeded account (which currently has none).
    const backfill = () =>
      sql`insert into memberships (account_id, member_user_id, role, status, accepted_at)
          select a.id, a.created_by_user_id, 'owner', 'active', now()
          from accounts a
          on conflict (account_id, member_user_id) where status = 'active' do nothing`.execute(client.kysely);
    await backfill();
    await backfill(); // idempotent
    const rows = await client.kysely.selectFrom('memberships').selectAll().where('account_id', '=', accountId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe('owner');
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.member_user_id).toBe(userId);
  });
});
