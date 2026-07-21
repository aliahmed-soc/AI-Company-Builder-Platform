// ACBP-P1-004 — real-PostgreSQL tests for the membership use cases (CDR-011). Trust-critical: proves the
// role matrix is enforced server-side, invites are email-bound + single-use, revocation is immediate,
// the last owner cannot be removed, and a non-member (incl. another account's owner) cannot read or
// mutate. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no migrate-down.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { inviteMember, acceptInvite, revokeMember, listMembers } from './membership-service.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
function createTestDatabase(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-integration' }));
}
const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(client: DatabaseClient, email: string, verified = true): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_a', provider_user_id: `user_${seq}`, primary_email: email, email_verified: verified, provider_updated_at: NOW() };
  const row = await client.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('membership use cases (real PostgreSQL)', () => {
  let client: DatabaseClient;
  let ownerId: string;
  let accountId: string;

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
    await client.kysely.deleteFrom('memberships').execute();
    await client.kysely.deleteFrom('account_profiles').execute();
    await client.kysely.deleteFrom('accounts').execute();
    await client.kysely.deleteFrom('users').execute();
    ownerId = await seedUser(client, 'owner@example.com');
    accountId = (await provisionPersonalAccount(client, ownerId)).accountId;
  });

  test('provisioning makes the founder an active owner member', async () => {
    const list = await listMembers(client, { accountId, actingUserId: ownerId });
    expect(list.status).toBe('ok');
    if (list.status === 'ok') {
      expect(list.members).toHaveLength(1);
      expect(list.members[0]).toMatchObject({ role: 'owner', status: 'active', memberUserId: ownerId });
    }
  });

  test('full invite → accept flow: an owner invites a viewer who accepts with a matching verified email', async () => {
    const invite = await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'joiner@example.com', role: 'viewer' });
    expect(invite.status).toBe('ok');
    if (invite.status !== 'ok') return;

    const joinerId = await seedUser(client, 'joiner@example.com');
    const accepted = await acceptInvite(client, { token: invite.token, acceptingUserId: joinerId });
    expect(accepted).toMatchObject({ status: 'ok', accountId, role: 'viewer' });

    const list = await listMembers(client, { accountId, actingUserId: ownerId });
    expect(list.status === 'ok' && list.members.length).toBe(2);
  });

  test('role matrix: a viewer cannot invite or revoke', async () => {
    const invite = await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'viewer@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(client, 'viewer@example.com');
    await acceptInvite(client, { token: invite.token, acceptingUserId: viewerId });

    expect((await inviteMember(client, { accountId, actingUserId: viewerId, invitedEmail: 'x@example.com', role: 'viewer' })).status).toBe('forbidden');
    const ownerMembership = (await listMembers(client, { accountId, actingUserId: viewerId }));
    const ownerRow = ownerMembership.status === 'ok' ? ownerMembership.members.find((m) => m.role === 'owner') : undefined;
    expect((await revokeMember(client, { accountId, actingUserId: viewerId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('forbidden');
  });

  test('cross-account isolation: another account owner cannot list or revoke here', async () => {
    const outsiderId = await seedUser(client, 'outsider@example.com');
    await provisionPersonalAccount(client, outsiderId); // their own account
    expect((await listMembers(client, { accountId, actingUserId: outsiderId })).status).toBe('forbidden');
    // Find our owner membership id and try to revoke it as the outsider.
    const list = await listMembers(client, { accountId, actingUserId: ownerId });
    const ownerRow = list.status === 'ok' ? list.members[0] : undefined;
    expect((await revokeMember(client, { accountId, actingUserId: outsiderId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('forbidden');
  });

  test('invite is email-bound: a user whose authoritative email differs is denied (no email param)', async () => {
    const invite = await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'intended@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const attackerId = await seedUser(client, 'attacker@example.com');
    // The accept function binds the email from users.primary_email; a mismatch denies (collapsed, no oracle).
    expect((await acceptInvite(client, { token: invite.token, acceptingUserId: attackerId })).status).toBe('invalid_or_used');
  });

  test('invite token is single-use', async () => {
    const invite = await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'once@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const joinerId = await seedUser(client, 'once@example.com');
    expect((await acceptInvite(client, { token: invite.token, acceptingUserId: joinerId })).status).toBe('ok');
    // Reusing the now-consumed token fails.
    const joiner2 = await seedUser(client, 'once@example.com', true);
    expect((await acceptInvite(client, { token: invite.token, acceptingUserId: joiner2 })).status).toBe('invalid_or_used');
    expect((await acceptInvite(client, { token: 'totally-bogus', acceptingUserId: joinerId })).status).toBe('invalid_or_used');
  });

  test('revocation is immediate and the last owner cannot be removed', async () => {
    // Invite + accept a viewer, then revoke them.
    const invite = await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'temp@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(client, 'temp@example.com');
    const accepted = await acceptInvite(client, { token: invite.token, acceptingUserId: viewerId });
    if (accepted.status !== 'ok') throw new Error('setup accept failed');

    expect((await revokeMember(client, { accountId, actingUserId: ownerId, membershipId: accepted.membershipId })).status).toBe('ok');
    // The revoked viewer can no longer act as a member.
    expect((await listMembers(client, { accountId, actingUserId: viewerId })).status).toBe('forbidden');

    // The sole owner cannot revoke themselves.
    const list = await listMembers(client, { accountId, actingUserId: ownerId });
    const ownerRow = list.status === 'ok' ? list.members.find((m) => m.role === 'owner') : undefined;
    expect((await revokeMember(client, { accountId, actingUserId: ownerId, membershipId: ownerRow?.membershipId ?? 'x' })).status).toBe('last_owner');
  });

  test('a duplicate outstanding invite to the same email is a conflict', async () => {
    expect((await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'dup@example.com', role: 'viewer' })).status).toBe('ok');
    expect((await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'dup@example.com', role: 'viewer' })).status).toBe('conflict');
  });
});
