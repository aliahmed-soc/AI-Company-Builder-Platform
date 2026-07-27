// ACBP-P1-004 — real-PostgreSQL tests for the membership use cases (CDR-011). Trust-critical: proves the
// role matrix is enforced server-side, invites are email-bound + single-use, revocation is immediate,
// the last owner cannot be removed, and a non-member (incl. another account's owner) cannot read or
// mutate. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no migrate-down.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { closeDatabase, migrateToLatest, writeAuditEvent, type DatabaseClient, type NewUser } from '@acbp/database';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { inviteMember, acceptInvite, revokeMember, listMembers, type AuditWriteFn } from './membership-service.js';
import { AUDITED_OPERATIONS, MEMBERSHIP_AUDITED_OPERATION_IDS, type MembershipAuditedOperation } from '../audit/audit-operations.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

// The membership use cases run as the restricted `acbp_app` role (subject to FORCE RLS); schema + user
// fixtures are seeded via the superuser `seed` client. Proving the role matrix / isolation under `app` is
// the end-to-end RLS proof (ACBP-P1-006).
const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string, verified = true): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: `user_${seq}`, primary_email: email, email_verified: verified, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('membership use cases (real PostgreSQL, restricted role) — ACBP-P1-004/006', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let ownerId: string;
  let accountId: string;

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'tool_definitions', 'job_checkpoints', 'jobs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
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
      for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'tool_definitions', 'job_checkpoints', 'jobs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });
  beforeEach(async () => {
    await seed.kysely.deleteFrom('audit_events').execute();
    await seed.kysely.deleteFrom('memberships').execute();
    await seed.kysely.deleteFrom('account_profiles').execute();
    await seed.kysely.deleteFrom('accounts').execute();
    await seed.kysely.deleteFrom('users').execute();
    ownerId = await seedUser(seed, 'owner@example.com');
    accountId = (await provisionPersonalAccount(app, ownerId)).accountId;
  });

  test('provisioning makes the founder an active owner member', async () => {
    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    expect(list.status).toBe('ok');
    if (list.status === 'ok') {
      expect(list.members).toHaveLength(1);
      expect(list.members[0]).toMatchObject({ role: 'owner', status: 'active', memberUserId: ownerId });
    }
  });

  test('full invite → accept flow: an owner invites a viewer who accepts with a matching verified email', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'joiner@example.com', role: 'viewer' });
    expect(invite.status).toBe('ok');
    if (invite.status !== 'ok') return;

    const joinerId = await seedUser(seed, 'joiner@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: joinerId });
    expect(accepted).toMatchObject({ status: 'ok', accountId, role: 'viewer' });

    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    expect(list.status === 'ok' && list.members.length).toBe(2);
  });

  test('role matrix: a viewer cannot invite or revoke', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'viewer@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(seed, 'viewer@example.com');
    await acceptInvite(app, { token: invite.token, acceptingUserId: viewerId });

    expect((await inviteMember(app, { accountId, actingUserId: viewerId, invitedEmail: 'x@example.com', role: 'viewer' })).status).toBe('forbidden');
    const ownerMembership = (await listMembers(app, { accountId, actingUserId: viewerId }));
    const ownerRow = ownerMembership.status === 'ok' ? ownerMembership.members.find((m) => m.role === 'owner') : undefined;
    expect((await revokeMember(app, { accountId, actingUserId: viewerId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('forbidden');
  });

  test('cross-account isolation: another account owner cannot list or revoke here', async () => {
    const outsiderId = await seedUser(seed, 'outsider@example.com');
    await provisionPersonalAccount(app, outsiderId); // their own account
    expect((await listMembers(app, { accountId, actingUserId: outsiderId })).status).toBe('forbidden');
    // Find our owner membership id and try to revoke it as the outsider.
    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    const ownerRow = list.status === 'ok' ? list.members[0] : undefined;
    expect((await revokeMember(app, { accountId, actingUserId: outsiderId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('forbidden');
  });

  test('invite is email-bound: a user whose authoritative email differs is denied (no email param)', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'intended@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const attackerId = await seedUser(seed, 'attacker@example.com');
    // The accept function binds the email from users.primary_email; a mismatch denies (collapsed, no oracle).
    expect((await acceptInvite(app, { token: invite.token, acceptingUserId: attackerId })).status).toBe('invalid_or_used');
  });

  test('invite token is single-use', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'once@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const joinerId = await seedUser(seed, 'once@example.com');
    expect((await acceptInvite(app, { token: invite.token, acceptingUserId: joinerId })).status).toBe('ok');
    // Reusing the now-consumed token fails.
    const joiner2 = await seedUser(seed, 'once@example.com', true);
    expect((await acceptInvite(app, { token: invite.token, acceptingUserId: joiner2 })).status).toBe('invalid_or_used');
    expect((await acceptInvite(app, { token: 'totally-bogus', acceptingUserId: joinerId })).status).toBe('invalid_or_used');
  });

  test('revocation is immediate and the last owner cannot be removed', async () => {
    // Invite + accept a viewer, then revoke them.
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'temp@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(seed, 'temp@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: viewerId });
    if (accepted.status !== 'ok') throw new Error('setup accept failed');

    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: accepted.membershipId })).status).toBe('ok');
    // The revoked viewer can no longer act as a member.
    expect((await listMembers(app, { accountId, actingUserId: viewerId })).status).toBe('forbidden');

    // The sole owner cannot revoke themselves.
    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    const ownerRow = list.status === 'ok' ? list.members.find((m) => m.role === 'owner') : undefined;
    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('last_owner');
  });

  test('member:read_invited_email — an owner sees pending-invite emails; a viewer gets them redacted — ACBP-P1-007', async () => {
    // Owner creates a pending invite (an unaccepted row carrying an invited_email).
    const pending = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'pending@example.com', role: 'viewer' });
    if (pending.status !== 'ok') throw new Error('setup pending invite failed');

    // Add a viewer member who can list.
    const vInvite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'viewer@example.com', role: 'viewer' });
    if (vInvite.status !== 'ok') throw new Error('setup viewer invite failed');
    const viewerId = await seedUser(seed, 'viewer@example.com');
    if ((await acceptInvite(app, { token: vInvite.token, acceptingUserId: viewerId })).status !== 'ok') throw new Error('setup viewer accept failed');

    // Owner sees the pending invite's email; the viewer gets it redacted (member:read_invited_email → owner).
    const asOwner = await listMembers(app, { accountId, actingUserId: ownerId });
    const asViewer = await listMembers(app, { accountId, actingUserId: viewerId });
    const ownerPendingRow = asOwner.status === 'ok' ? asOwner.members.find((m) => m.status === 'invited' && m.membershipId === pending.membershipId) : undefined;
    const viewerPendingRow = asViewer.status === 'ok' ? asViewer.members.find((m) => m.status === 'invited' && m.membershipId === pending.membershipId) : undefined;
    expect(ownerPendingRow?.invitedEmail).toBe('pending@example.com');
    expect(viewerPendingRow?.invitedEmail).toBeNull();
  });

  test('a role change is reflected on the very next authorization decision (no caching) — ACBP-P1-007', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'promote@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const memberId = await seedUser(seed, 'promote@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: memberId });
    if (accepted.status !== 'ok') throw new Error('setup accept failed');

    // As a viewer, inviting is denied by the central authz.check (role loaded from the membership row).
    expect((await inviteMember(app, { accountId, actingUserId: memberId, invitedEmail: 'a@example.com', role: 'viewer' })).status).toBe('forbidden');

    // Promote the member to owner directly in the database (seed/superuser) between two requests.
    await seed.kysely.updateTable('memberships').set({ role: 'owner' }).where('id', '=', accepted.membershipId).execute();

    // The VERY NEXT call sees the new role — the decision is not cached across requests.
    expect((await inviteMember(app, { accountId, actingUserId: memberId, invitedEmail: 'a@example.com', role: 'viewer' })).status).toBe('ok');
  });

  test('a duplicate outstanding invite to the same email is a conflict', async () => {
    expect((await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'dup@example.com', role: 'viewer' })).status).toBe('ok');
    expect((await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'dup@example.com', role: 'viewer' })).status).toBe('conflict');
  });

  // ── ACBP-P1-008: durable in-transaction audit for the two high-risk membership lifecycle ops ──────────
  // These call the CORE use cases DIRECTLY (no web route), proving the mandatory durable write lives at the
  // trusted use-case seam. Audit rows are read via the superuser `seed` client (bypasses RLS to see all).
  const failingWriter: AuditWriteFn = () => Promise.reject(new Error('audit boom'));

  test('membership.invited: an invite writes exactly one durable audit row in-tx, server-bound + PII-free — ACBP-P1-008', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'audit-join@example.com', role: 'viewer' });
    expect(invite.status).toBe('ok');
    if (invite.status !== 'ok') return;
    const rows = await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'membership.invited').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'membership.invited', account_id: accountId, actor_type: 'user', actor_id: ownerId, subject_type: 'membership', subject_id: invite.membershipId, outcome: 'success' });
    expect(rows[0]?.payload).toEqual({ role: 'viewer' });
    expect(typeof rows[0]?.event_id).toBe('string');
    expect(rows[0]?.occurred_at).toBeInstanceOf(Date);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain('audit-join@example.com'); // no invited email
    expect(serialized).not.toContain(invite.token); // no invite token
  });

  test('membership.invited: an audit-write failure rolls back the invite (fail-closed) — no invite, no audit — ACBP-P1-008', async () => {
    await expect(inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'rollback@example.com', role: 'viewer' }, { auditWriter: failingWriter })).rejects.toBeDefined();
    expect(await seed.kysely.selectFrom('memberships').selectAll().where('invited_email', '=', 'rollback@example.com').execute()).toHaveLength(0);
    expect(await seed.kysely.selectFrom('audit_events').selectAll().execute()).toHaveLength(0);
  });

  test('atomicity: writing the audit THEN throwing rolls BOTH the invite and the audit row back — ACBP-P1-008', async () => {
    const writeThenThrow: AuditWriteFn = async (scope, event, ctx) => {
      await writeAuditEvent(scope, event, ctx); // the row is inserted in this tx...
      throw new Error('post-write boom'); // ...then the throw rolls the WHOLE tx back
    };
    await expect(inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'atomic@example.com', role: 'viewer' }, { auditWriter: writeThenThrow })).rejects.toBeDefined();
    expect(await seed.kysely.selectFrom('memberships').selectAll().where('invited_email', '=', 'atomic@example.com').execute()).toHaveLength(0);
    expect(await seed.kysely.selectFrom('audit_events').selectAll().execute()).toHaveLength(0);
  });

  test('invite mutation failure (duplicate) writes no success audit — ACBP-P1-008', async () => {
    expect((await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'dup2@example.com', role: 'viewer' })).status).toBe('ok');
    await seed.kysely.deleteFrom('audit_events').execute(); // clear the first, successful audit
    expect((await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'dup2@example.com', role: 'viewer' })).status).toBe('conflict');
    expect(await seed.kysely.selectFrom('audit_events').selectAll().execute()).toHaveLength(0);
  });

  test('membership.revoked: a real revocation writes exactly one durable audit row in-tx — ACBP-P1-008', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'rev@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup');
    const viewerId = await seedUser(seed, 'rev@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: viewerId });
    if (accepted.status !== 'ok') throw new Error('setup');
    await seed.kysely.deleteFrom('audit_events').execute(); // isolate the revoke audit from the invite audit
    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: accepted.membershipId })).status).toBe('ok');
    const rows = await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'membership.revoked').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'membership.revoked', account_id: accountId, actor_type: 'user', actor_id: ownerId, subject_id: accepted.membershipId, outcome: 'success' });
    expect(rows[0]?.payload).toEqual({ role: 'viewer' });
  });

  test('membership.revoked: an audit-write failure rolls back the revocation — target stays active, no audit — ACBP-P1-008', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'revfail@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup');
    const viewerId = await seedUser(seed, 'revfail@example.com');
    const accepted = await acceptInvite(app, { token: invite.token, acceptingUserId: viewerId });
    if (accepted.status !== 'ok') throw new Error('setup');
    await seed.kysely.deleteFrom('audit_events').execute();
    await expect(revokeMember(app, { accountId, actingUserId: ownerId, membershipId: accepted.membershipId }, { auditWriter: failingWriter })).rejects.toBeDefined();
    const row = await seed.kysely.selectFrom('memberships').selectAll().where('id', '=', accepted.membershipId).executeTakeFirst();
    expect(row?.status).toBe('active'); // revocation rolled back
    expect(await seed.kysely.selectFrom('audit_events').selectAll().execute()).toHaveLength(0);
  });

  test('no success audit for last-owner denial, missing target, or already-revoked no-op — ACBP-P1-008', async () => {
    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    const ownerRow = list.status === 'ok' ? list.members.find((m) => m.role === 'owner') : undefined;
    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('last_owner');
    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: '00000000-0000-0000-0000-000000000000' })).status).toBe('not_found');

    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'twice@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup');
    const vId = await seedUser(seed, 'twice@example.com');
    const acc = await acceptInvite(app, { token: invite.token, acceptingUserId: vId });
    if (acc.status !== 'ok') throw new Error('setup');
    await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: acc.membershipId }); // first (real) revoke
    await seed.kysely.deleteFrom('audit_events').execute(); // clear it
    expect((await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: acc.membershipId })).status).toBe('ok'); // idempotent no-op
    expect(await seed.kysely.selectFrom('audit_events').selectAll().execute()).toHaveLength(0); // NO new audit
  });

  test('concurrent revoke of the same membership yields exactly ONE success audit — ACBP-P1-008', async () => {
    const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'conc@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup');
    const vId = await seedUser(seed, 'conc@example.com');
    const acc = await acceptInvite(app, { token: invite.token, acceptingUserId: vId });
    if (acc.status !== 'ok') throw new Error('setup');
    await seed.kysely.deleteFrom('audit_events').execute();
    const [a, b] = await Promise.all([
      revokeMember(app, { accountId, actingUserId: ownerId, membershipId: acc.membershipId }),
      revokeMember(app, { accountId, actingUserId: ownerId, membershipId: acc.membershipId }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['ok', 'ok']);
    // Only the transaction that actually flipped active→revoked audits; the racing no-op does not.
    expect(await seed.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'membership.revoked').execute()).toHaveLength(1);
  });

  test('cross-account: an outsider cannot revoke here and writes no audit for this account — ACBP-P1-008', async () => {
    const outsiderId = await seedUser(seed, 'outsider2@example.com');
    await provisionPersonalAccount(app, outsiderId); // their OWN account
    await seed.kysely.deleteFrom('audit_events').execute();
    const list = await listMembers(app, { accountId, actingUserId: ownerId });
    const ownerRow = list.status === 'ok' ? list.members[0] : undefined;
    expect((await revokeMember(app, { accountId, actingUserId: outsiderId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('forbidden');
    expect(await seed.kysely.selectFrom('audit_events').selectAll().where('account_id', '=', accountId).execute()).toHaveLength(0);
  });

  // Automated completeness: a driver per APPROVED MEMBERSHIP operation, exhaustive over the membership subset
  // at compile time (a new membership operation without a driver fails to compile). Each driver runs the REAL
  // use case and must leave exactly one durable audit row of its mapped event — so a use case that ever loses
  // its in-tx write fails CI here, not just review discipline (closes the "parallel bookkeeping" gap). Company
  // operations are driven by the company producer test (ACBP-P1-010), keeping the domains independent.
  const OP_DRIVERS: Record<MembershipAuditedOperation, () => Promise<void>> = {
    'membership.invite': async () => {
      const r = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'op-invite@example.com', role: 'viewer' });
      if (r.status !== 'ok') throw new Error('invite driver setup failed');
    },
    'membership.revoke': async () => {
      const invite = await inviteMember(app, { accountId, actingUserId: ownerId, invitedEmail: 'op-revoke@example.com', role: 'viewer' });
      if (invite.status !== 'ok') throw new Error('revoke driver setup failed');
      const vId = await seedUser(seed, 'op-revoke@example.com');
      const acc = await acceptInvite(app, { token: invite.token, acceptingUserId: vId });
      if (acc.status !== 'ok') throw new Error('revoke driver setup failed');
      await seed.kysely.deleteFrom('audit_events').execute(); // isolate: only the revoke event should remain
      const r = await revokeMember(app, { accountId, actingUserId: ownerId, membershipId: acc.membershipId });
      if (r.status !== 'ok') throw new Error('revoke driver failed');
    },
  };

  test.each(MEMBERSHIP_AUDITED_OPERATION_IDS)('completeness: approved operation %s writes exactly one durable audit of its mapped event — ACBP-P1-008', async (op) => {
    await seed.kysely.deleteFrom('audit_events').execute();
    await OP_DRIVERS[op]();
    const all = await seed.kysely.selectFrom('audit_events').selectAll().execute();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe(AUDITED_OPERATIONS[op]);
  });
});
