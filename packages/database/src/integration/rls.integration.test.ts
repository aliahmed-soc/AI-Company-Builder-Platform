// ACBP-P1-006 / CDR-013 — real-PostgreSQL RLS isolation proven under the RESTRICTED application role.
// Setup/seed runs on the superuser (owner) connection (which bypasses RLS); every isolation assertion runs
// on a SECOND pool connected as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner) so RLS actually applies.
// This is the "RLS suite with app filter disabled" (BACKLOG ACBP-P1-006): queries carry NO app-level
// account filter, so any row they return is one RLS permitted. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
// Synthetic, throwaway local test password for the restricted role (never a real credential).
const APP_TEST_PASSWORD = `rls_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-integration' }));
}
/** Build a client connected as the restricted `acbp_app` role by swapping the credentials in the URL. */
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-rls-test' }));
}

let seq = 0;
async function seedAccount(su: DatabaseClient, email: string): Promise<{ userId: string; accountId: string }> {
  seq += 1;
  const user = await su.kysely.insertInto('users').values({ provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: `rls_user_${seq}`, primary_email: email, email_verified: true, provider_updated_at: new Date().toISOString() }).returning('id').executeTakeFirstOrThrow();
  const account = await su.kysely.insertInto('accounts').values({ created_by_user_id: user.id }).returning('id').executeTakeFirstOrThrow();
  await su.kysely.insertInto('account_profiles').values({ account_id: account.id }).execute();
  await su.kysely.insertInto('memberships').values({ account_id: account.id, member_user_id: user.id, role: 'owner', status: 'active', accepted_at: new Date().toISOString() }).execute();
  return { userId: user.id, accountId: account.id };
}

describe.skipIf(!hasTestDatabase)('RLS isolation under the restricted role (real PostgreSQL) — ACBP-P1-006/CDR-013', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;

  beforeAll(async () => {
    su = superuserClient();
    for (const t of ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    // Give the restricted role a login + throwaway test password (deployment does this out-of-band).
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();
  });

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  /** Run `fn` as the restricted role inside a transaction with the given GUCs set transaction-locally. */
  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }

  test('the restricted role is NOSUPERUSER, NOBYPASSRLS, and not the table owner', async () => {
    const r = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`select rolsuper, rolbypassrls from pg_roles where rolname = 'acbp_app'`.execute(su.kysely);
    expect(r.rows[0]?.rolsuper).toBe(false);
    expect(r.rows[0]?.rolbypassrls).toBe(false);
    const owner = await sql<{ tableowner: string }>`select tableowner from pg_tables where tablename = 'accounts'`.execute(su.kysely);
    expect(owner.rows[0]?.tableowner).not.toBe('acbp_app');
  });

  test('missing / empty / malformed account context returns NO rows (fail-closed, no cast error)', async () => {
    await seedAccount(su, 'fc@example.com');
    // No GUC set at all.
    const none = await asApp({}, (db) => sql<{ n: number }>`select count(*)::int as n from accounts`.execute(db).then((x) => x.rows[0]?.n));
    expect(none).toBe(0);
    const empty = await asApp({ 'app.current_account': '' }, (db) => sql<{ n: number }>`select count(*)::int as n from accounts`.execute(db).then((x) => x.rows[0]?.n));
    expect(empty).toBe(0);
    const malformed = await asApp({ 'app.current_account': 'not-a-uuid' }, (db) => sql<{ n: number }>`select count(*)::int as n from accounts`.execute(db).then((x) => x.rows[0]?.n));
    expect(malformed).toBe(0);
  });

  test('correct account context sees only its own account + profile; a different context cannot SELECT them', async () => {
    const a = await seedAccount(su, 'a@example.com');
    const b = await seedAccount(su, 'b@example.com');
    const seenA = await asApp({ 'app.current_account': a.accountId }, async (db) => {
      const accts = await sql<{ id: string }>`select id from accounts`.execute(db);
      const profs = await sql<{ account_id: string }>`select account_id from account_profiles`.execute(db);
      return { accts: accts.rows.map((r) => r.id), profs: profs.rows.map((r) => r.account_id) };
    });
    expect(seenA.accts).toEqual([a.accountId]);
    expect(seenA.profs).toEqual([a.accountId]);
    // From A's context, B's rows are invisible even when addressed by id.
    const bFromA = await asApp({ 'app.current_account': a.accountId }, (db) => sql<{ n: number }>`select count(*)::int as n from accounts where id = ${b.accountId}`.execute(db).then((x) => x.rows[0]?.n));
    expect(bFromA).toBe(0);
  });

  test('the restricted role cannot INSERT an account directly (creation is bootstrap-only)', async () => {
    const a = await seedAccount(su, 'ins@example.com');
    await expect(asApp({ 'app.current_account': a.accountId }, (db) => sql`insert into accounts (created_by_user_id) values (${a.userId})`.execute(db))).rejects.toBeDefined();
  });

  test('UPDATE only affects the current account; a hidden account cannot be updated', async () => {
    const a = await seedAccount(su, 'ua@example.com');
    const b = await seedAccount(su, 'ub@example.com');
    // Update under A's context targeting B by id → 0 rows (B is hidden), so no change.
    await asApp({ 'app.current_account': a.accountId }, (db) => sql`update accounts set plan_state = 'pro' where id = ${b.accountId}`.execute(db));
    const bState = await sql<{ plan_state: string }>`select plan_state from accounts where id = ${b.accountId}`.execute(su.kysely);
    expect(bState.rows[0]?.plan_state).toBe('free');
    // Update under A's own context works.
    await asApp({ 'app.current_account': a.accountId }, (db) => sql`update accounts set plan_state = 'pro'`.execute(db));
    const aState = await sql<{ plan_state: string }>`select plan_state from accounts where id = ${a.accountId}`.execute(su.kysely);
    expect(aState.rows[0]?.plan_state).toBe('pro');
  });

  test('memberships: INSERT is confined to the current account; cross-account INSERT/move fails WITH CHECK', async () => {
    const a = await seedAccount(su, 'ma@example.com');
    const b = await seedAccount(su, 'mb@example.com');
    // Invite (insert) under A's context for account A → allowed.
    await asApp({ 'app.current_account': a.accountId }, (db) => sql`insert into memberships (account_id, role, status, invited_email, invite_token_hash) values (${a.accountId}, 'viewer', 'invited', 'x@example.com', 'hash_x')`.execute(db));
    // Insert a membership row for account B while in A's context → WITH CHECK denies.
    await expect(asApp({ 'app.current_account': a.accountId }, (db) => sql`insert into memberships (account_id, role, status, invited_email, invite_token_hash) values (${b.accountId}, 'viewer', 'invited', 'y@example.com', 'hash_y')`.execute(db))).rejects.toBeDefined();
    // Move A's owner membership to account B → WITH CHECK denies.
    await expect(asApp({ 'app.current_account': a.accountId }, (db) => sql`update memberships set account_id = ${b.accountId} where account_id = ${a.accountId}`.execute(db))).rejects.toBeDefined();
  });

  test('memberships self-branch: a member sees their own row via current_actor without account context', async () => {
    const a = await seedAccount(su, 'self@example.com');
    const seen = await asApp({ 'app.current_actor': a.userId }, (db) => sql<{ member_user_id: string | null }>`select member_user_id from memberships`.execute(db).then((x) => x.rows.map((r) => r.member_user_id)));
    expect(seen).toEqual([a.userId]);
  });

  test('account context does not leak past the transaction (SET LOCAL) on a pooled connection', async () => {
    const a = await seedAccount(su, 'leak@example.com');
    await asApp({ 'app.current_account': a.accountId }, (db) => sql`select 1`.execute(db));
    // A fresh transaction with no GUC must see nothing (no inherited context).
    const after = await asApp({}, (db) => sql<{ n: number }>`select count(*)::int as n from accounts`.execute(db).then((x) => x.rows[0]?.n));
    expect(after).toBe(0);
  });
});
