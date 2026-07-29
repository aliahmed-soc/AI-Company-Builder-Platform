// ACBP-P1-006 / CDR-013 — real-PostgreSQL trust-critical tests for the three SECURITY DEFINER bootstrap
// functions, exercised through the RESTRICTED `acbp_app` role. Proves the legitimate paths, the abuse
// cases fail closed, invite acceptance binds email from the users table (not caller input), and the
// catalog properties (owner, prosecdef, search_path, EXECUTE ACL) are exactly as intended. Setup/seed runs
// on the superuser connection (bypasses RLS). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, provisionAccountBootstrap, resolveOwnMembershipBootstrap, acceptInviteBootstrap, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `rls_${'test'}_pw_1970`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-integration' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-bootstrap-test' }));
}

let seq = 0;
async function seedUser(su: DatabaseClient, email: string | null, opts: { verified?: boolean; status?: string } = {}): Promise<string> {
  seq += 1;
  const status = opts.status ?? 'active';
  const row = await su.kysely
    .insertInto('users')
    .values({ provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: `bs_user_${seq}`, primary_email: email, email_verified: opts.verified ?? true, status, provider_updated_at: new Date().toISOString(), ...(status === 'deleted' ? { deleted_at: new Date().toISOString() } : {}) })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}
/** Seed a pending invite (superuser, bypassing RLS) and return its token hash. */
async function seedInvite(su: DatabaseClient, accountId: string, invitedEmail: string, role = 'viewer'): Promise<string> {
  seq += 1;
  const tokenHash = `hash_${seq}`;
  await su.kysely.insertInto('memberships').values({ account_id: accountId, role, status: 'invited', invited_email: invitedEmail, invite_token_hash: tokenHash }).execute();
  return tokenHash;
}

describe.skipIf(!hasTestDatabase)('SECURITY DEFINER bootstrap functions (real PostgreSQL) — ACBP-P1-006/CDR-013', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;

  beforeAll(async () => {
    su = superuserClient();
    for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
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
      for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  // ── Provisioning ────────────────────────────────────────────────────────────────────────────────
  test('provisioning creates the user\'s own account + profile + owner membership, idempotently', async () => {
    const userId = await seedUser(su, 'prov@example.com');
    const first = await provisionAccountBootstrap(app.kysely, userId);
    expect(first.created).toBe(true);
    const second = await provisionAccountBootstrap(app.kysely, userId);
    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);
    // Verify the shape via the superuser (bypass) connection.
    const acct = await sql<{ created_by_user_id: string }>`select created_by_user_id from accounts where id = ${first.accountId}`.execute(su.kysely);
    expect(acct.rows[0]?.created_by_user_id).toBe(userId);
    const prof = await sql<{ n: number }>`select count(*)::int as n from account_profiles where account_id = ${first.accountId}`.execute(su.kysely);
    expect(prof.rows[0]?.n).toBe(1);
    const mem = await sql<{ role: string; status: string }>`select role, status from memberships where account_id = ${first.accountId} and member_user_id = ${userId}`.execute(su.kysely);
    expect(mem.rows[0]).toMatchObject({ role: 'owner', status: 'active' });
  });

  // ── Own-membership resolution ───────────────────────────────────────────────────────────────────
  test('resolution returns only the caller\'s own active membership; wrong account / other user / revoked deny', async () => {
    const owner = await seedUser(su, 'ro@example.com');
    const { accountId } = await provisionAccountBootstrap(app.kysely, owner);
    const other = await seedUser(su, 'ro2@example.com');
    const otherAccount = (await provisionAccountBootstrap(app.kysely, other)).accountId;

    expect(await resolveOwnMembershipBootstrap(app.kysely, owner, accountId)).toEqual({ role: 'owner' });
    // Wrong account (owner is not a member of otherAccount).
    expect(await resolveOwnMembershipBootstrap(app.kysely, owner, otherAccount)).toBeNull();
    // Another user cannot resolve someone else's membership.
    expect(await resolveOwnMembershipBootstrap(app.kysely, other, accountId)).toBeNull();
    // Revocation is immediate.
    await sql`update memberships set status = 'revoked', revoked_at = now() where account_id = ${accountId} and member_user_id = ${owner}`.execute(su.kysely);
    expect(await resolveOwnMembershipBootstrap(app.kysely, owner, accountId)).toBeNull();
  });

  // ── Invite acceptance ───────────────────────────────────────────────────────────────────────────
  test('acceptance activates when the authoritative user email matches the invite (email is NOT a param)', async () => {
    const owner = await seedUser(su, 'ai-owner@example.com');
    const { accountId } = await provisionAccountBootstrap(app.kysely, owner);
    const tokenHash = await seedInvite(su, accountId, 'joiner@example.com', 'viewer');
    const joiner = await seedUser(su, 'joiner@example.com', { verified: true });

    const accepted = await acceptInviteBootstrap(app.kysely, tokenHash, joiner);
    expect(accepted).toMatchObject({ accountId, role: 'viewer' });
    // The newly-active member can now resolve context normally.
    expect(await resolveOwnMembershipBootstrap(app.kysely, joiner, accountId)).toEqual({ role: 'viewer' });
    // The token hash was consumed.
    const consumed = await sql<{ invite_token_hash: string | null; status: string }>`select invite_token_hash, status from memberships where id = ${accepted?.membershipId}`.execute(su.kysely);
    expect(consumed.rows[0]).toMatchObject({ invite_token_hash: null, status: 'active' });
  });

  test('acceptance fails closed: wrong hash, email mismatch, unverified user, deleted user, and reuse all deny', async () => {
    const owner = await seedUser(su, 'fc-owner@example.com');
    const { accountId } = await provisionAccountBootstrap(app.kysely, owner);

    // Wrong token hash.
    const u1 = await seedUser(su, 'a1@example.com');
    expect(await acceptInviteBootstrap(app.kysely, 'no_such_hash', u1)).toBeNull();

    // Email mismatch (authoritative user email != invited_email) — a caller cannot supply an email.
    const hMismatch = await seedInvite(su, accountId, 'intended@example.com');
    const attacker = await seedUser(su, 'attacker@example.com');
    expect(await acceptInviteBootstrap(app.kysely, hMismatch, attacker)).toBeNull();

    // Unverified user.
    const hUnverified = await seedInvite(su, accountId, 'unv@example.com');
    const unv = await seedUser(su, 'unv@example.com', { verified: false });
    expect(await acceptInviteBootstrap(app.kysely, hUnverified, unv)).toBeNull();

    // Deleted/tombstoned user — a real deleted user has its email redacted to NULL (CDR-008), so the
    // function's active+verified-email requirement denies it.
    const hDeleted = await seedInvite(su, accountId, 'del@example.com');
    const del = await seedUser(su, null, { verified: false, status: 'deleted' });
    expect(await acceptInviteBootstrap(app.kysely, hDeleted, del)).toBeNull();

    // Single-use: a consumed invite cannot be re-accepted.
    const hOnce = await seedInvite(su, accountId, 'once@example.com');
    const once = await seedUser(su, 'once@example.com');
    expect(await acceptInviteBootstrap(app.kysely, hOnce, once)).not.toBeNull();
    const once2 = await seedUser(su, 'once@example.com'); // a second identity with the same email
    expect(await acceptInviteBootstrap(app.kysely, hOnce, once2)).toBeNull();
  });

  test('a revoked invitation cannot be accepted', async () => {
    const owner = await seedUser(su, 'rev-owner@example.com');
    const { accountId } = await provisionAccountBootstrap(app.kysely, owner);
    const h = await seedInvite(su, accountId, 'revd@example.com');
    await sql`update memberships set status = 'revoked', revoked_at = now(), invite_token_hash = null where invite_token_hash = ${h}`.execute(su.kysely);
    const user = await seedUser(su, 'revd@example.com');
    expect(await acceptInviteBootstrap(app.kysely, h, user)).toBeNull();
  });

  // ── Abuse: the restricted role cannot bypass the functions by touching hidden rows directly ────────
  test('the restricted role cannot self-activate a pending invite by direct UPDATE (RLS hides the row)', async () => {
    const owner = await seedUser(su, 'abuse-owner@example.com');
    const { accountId } = await provisionAccountBootstrap(app.kysely, owner);
    const h = await seedInvite(su, accountId, 'abuse@example.com');
    const attacker = await seedUser(su, 'abuse@example.com');
    // As acbp_app with NO account context, try to activate the pending invite directly.
    await withTransaction(app, async (tx) => {
      await sql`update memberships set status = 'active', member_user_id = ${attacker} where invite_token_hash = ${h}`.execute(tx.kysely);
    });
    // The pending row is untouched (RLS hid it from the restricted role).
    const still = await sql<{ status: string; member_user_id: string | null }>`select status, member_user_id from memberships where invite_token_hash = ${h}`.execute(su.kysely);
    expect(still.rows[0]).toMatchObject({ status: 'invited', member_user_id: null });
  });

  // ── Catalog: exactly three SECURITY DEFINER functions, and every acbp_ function unowned by the app role ──
  test('catalog: exactly three SECURITY DEFINER functions with a fixed search_path; no acbp_ function is owned by acbp_app', async () => {
    const fns = await sql<{ proname: string; prosecdef: boolean; proconfig: string[] | null; owner: string }>`
      select p.proname, p.prosecdef, p.proconfig, (select rolname from pg_roles where oid = p.proowner) as owner
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'acbp\\_%'
      order by p.proname
    `.execute(su.kysely);
    // D2 — the SECURITY DEFINER allowlist is what must stay closed at three. `acbp_check_credit_settlement`
    // (migration 0041) is a plain trigger function and deliberately NOT SECURITY DEFINER, so comparing EVERY `acbp_`
    // function against the bootstrap list reported a breach where no privilege was escalated. Named explicitly rather
    // than filtered away, so a genuinely new non-definer function still has to be admitted here on purpose.
    const names = fns.rows.map((r) => r.proname);
    expect(names).toEqual(['acbp_accept_invite', 'acbp_check_credit_settlement', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    expect(fns.rows.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual(['acbp_accept_invite', 'acbp_provision_account', 'acbp_resolve_own_membership']);
    for (const f of fns.rows.filter((r) => r.prosecdef)) {
      expect(f.prosecdef).toBe(true);
      // pg_catalog FIRST (so no pg_temp object can shadow a built-in); pg_temp pinned last, no writable schema.
      const sp = (f.proconfig ?? []).find((c) => c.toLowerCase().startsWith('search_path='));
      expect(sp?.replace(/\s/g, '').toLowerCase()).toBe('search_path=pg_catalog,pg_temp');
    }
    // OWNERSHIP applies to EVERY acbp_ function, definer or not: a function the app role owns is one it can replace.
    for (const f of fns.rows) expect(f.owner).not.toBe('acbp_app');
  });

  test('catalog: only the restricted app role has EXECUTE; PUBLIC does not', async () => {
    const grants = await sql<{ routine_name: string; grantee: string; privilege_type: string }>`
      select routine_name, grantee, privilege_type
      from information_schema.routine_privileges
      where routine_schema = 'public' and routine_name like 'acbp\\_%'
    `.execute(su.kysely);
    const grantees = new Set(grants.rows.map((r) => r.grantee));
    expect(grantees.has('acbp_app')).toBe(true);
    expect(grantees.has('PUBLIC')).toBe(false);
  });
});
