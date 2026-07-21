// ACBP-P1-005 / CDR-012 — real-PostgreSQL tests for the membership-backed account-context resolver.
// Trust-critical: proves account context resolves ONLY from an ACTIVE internal membership, that invited /
// revoked / missing / cross-account all deny, and that revocation takes effect on the next resolution.
// Skips when ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning; runs no migrate-down.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { isResolvedAccountContext, isDeniedAccountContext } from '@acbp/contracts';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { inviteMember, acceptInvite, revokeMember } from '../members/membership-service.js';
import { resolveAccountContext, runInAccountScope } from './account-context-resolver.js';

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

describe.skipIf(!hasTestDatabase)('account-context resolver (real PostgreSQL) — ACBP-P1-005/CDR-012', () => {
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

  test('the founding owner (active membership) resolves to their account context', async () => {
    const r = await resolveAccountContext(client, { userId: ownerId, requestedAccountId: accountId });
    expect(isResolvedAccountContext(r)).toBe(true);
    if (isResolvedAccountContext(r)) expect(r.context).toEqual({ accountId, actorId: ownerId });
  });

  test('an accepted viewer (active membership) resolves', async () => {
    const invite = await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'viewer@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(client, 'viewer@example.com');
    await acceptInvite(client, { token: invite.token, acceptingUserId: viewerId });

    const r = await resolveAccountContext(client, { userId: viewerId, requestedAccountId: accountId });
    expect(isResolvedAccountContext(r) && r.context.actorId).toBe(viewerId);
  });

  test('an INVITED-but-not-accepted user has no active membership → denied', async () => {
    await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'pending@example.com', role: 'viewer' });
    const pendingUserId = await seedUser(client, 'pending@example.com'); // signed in but never accepted
    const r = await resolveAccountContext(client, { userId: pendingUserId, requestedAccountId: accountId });
    expect(isDeniedAccountContext(r) && r.reason).toBe('membership_not_active');
  });

  test('a user with NO membership is denied', async () => {
    const strangerId = await seedUser(client, 'stranger@example.com');
    const r = await resolveAccountContext(client, { userId: strangerId, requestedAccountId: accountId });
    expect(isDeniedAccountContext(r) && r.reason).toBe('membership_not_active');
  });

  test('cross-account: another account’s owner cannot resolve OUR account', async () => {
    const outsiderId = await seedUser(client, 'outsider@example.com');
    const outsiderAccount = (await provisionPersonalAccount(client, outsiderId)).accountId;
    // Outsider is a valid owner of THEIR account, but requesting OURS denies (no membership here).
    const cross = await resolveAccountContext(client, { userId: outsiderId, requestedAccountId: accountId });
    expect(isDeniedAccountContext(cross) && cross.reason).toBe('membership_not_active');
    // And their own account still resolves — proving isolation, not a blanket denial.
    const own = await resolveAccountContext(client, { userId: outsiderId, requestedAccountId: outsiderAccount });
    expect(isResolvedAccountContext(own)).toBe(true);
  });

  test('revocation takes effect immediately on the next resolution', async () => {
    const invite = await inviteMember(client, { accountId, actingUserId: ownerId, invitedEmail: 'temp@example.com', role: 'viewer' });
    if (invite.status !== 'ok') throw new Error('setup invite failed');
    const viewerId = await seedUser(client, 'temp@example.com');
    const accepted = await acceptInvite(client, { token: invite.token, acceptingUserId: viewerId });
    if (accepted.status !== 'ok') throw new Error('setup accept failed');

    // Active before revocation.
    expect(isResolvedAccountContext(await resolveAccountContext(client, { userId: viewerId, requestedAccountId: accountId }))).toBe(true);
    await revokeMember(client, { accountId, actingUserId: ownerId, membershipId: accepted.membershipId });
    // Denied immediately after.
    const after = await resolveAccountContext(client, { userId: viewerId, requestedAccountId: accountId });
    expect(isDeniedAccountContext(after) && after.reason).toBe('membership_not_active');
  });

  test('a blank requested account id is denied as account_not_specified', async () => {
    const r = await resolveAccountContext(client, { userId: ownerId, requestedAccountId: '' });
    expect(isDeniedAccountContext(r) && r.reason).toBe('account_not_specified');
  });

  test('runInAccountScope runs the callback under a validated account scope for a member', async () => {
    // The SET LOCAL GUC behavior itself is proven in the @acbp/database account-tenant integration suite;
    // here we prove the composition mints a scope carrying the validated account and runs the callback.
    const run = await runInAccountScope(client, { userId: ownerId, requestedAccountId: accountId }, (scope) => Promise.resolve(scope.account.accountId));
    expect(run.kind).toBe('ran');
    if (run.kind === 'ran') expect(run.value).toBe(accountId);
  });

  test('runInAccountScope denies and NEVER runs the callback for a non-member (fail-closed)', async () => {
    const strangerId = await seedUser(client, 'stranger2@example.com');
    let ran = false;
    const run = await runInAccountScope(client, { userId: strangerId, requestedAccountId: accountId }, () => {
      ran = true;
      return Promise.resolve(1);
    });
    expect(run.kind).toBe('denied');
    expect(ran).toBe(false);
    if (run.kind === 'denied') expect(run.reason).toBe('membership_not_active');
  });
});
