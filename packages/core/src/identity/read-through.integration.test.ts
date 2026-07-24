// ACBP-P1-002 Slice 3 — real-PostgreSQL read-through reconciliation tests. Proves authoritative
// convergence, race handling (read-through/read-through and read-through/webhook), the last_event_id=null
// ordering interaction, no-resurrection, and that read-through writes NO webhook receipt. Skips when
// ACBP_TEST_DATABASE_URL is unset; never mocked. Self-cleaning. Fake identities + an injected reader
// (no live Clerk). Lives in @acbp/core (core → database is allowed; the reverse would be a cycle).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, type DatabaseClient, type UserRow, type ProviderIdentityKey } from '@acbp/database';
import { PlatformError } from '@acbp/contracts';
import type { AuthoritativeIdentityReader, AuthoritativeIdentityResult, AuthoritativeIdentitySnapshot, VerifiedIdentityWebhookEvent } from '@acbp/contracts';
import { resolveOrReconcileInternalUser } from './read-through.js';
import { processVerifiedIdentityEvent } from './webhook-processor.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
function createTestDatabase(): DatabaseClient {
  return createDatabase(
    parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-integration' }),
  );
}

const INSTANCE = 'ins_1';
const KEY: ProviderIdentityKey = { provider: 'clerk', providerInstanceId: INSTANCE, providerUserId: 'user_1' };
const hex = (c: string): string => c.repeat(64);

class FixedReader implements AuthoritativeIdentityReader {
  calls = 0;
  constructor(private readonly result: AuthoritativeIdentityResult) {}
  read(): Promise<AuthoritativeIdentityResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}
function snapshot(over: Partial<AuthoritativeIdentitySnapshot> = {}): AuthoritativeIdentitySnapshot {
  return {
    provider: 'clerk',
    providerInstanceId: INSTANCE,
    providerUserId: 'user_1',
    primaryEmail: 'rt@example.com',
    emailVerified: true,
    providerCreatedAt: new Date('2025-12-01T00:00:00.000Z'),
    providerUpdatedAt: new Date('2026-01-01T12:00:00.000Z'),
    ...over,
  };
}
const found = (over?: Partial<AuthoritativeIdentitySnapshot>): FixedReader => new FixedReader({ status: 'found', snapshot: snapshot(over) });

function upsert(o: Partial<{ type: 'user.created' | 'user.updated'; eventId: string; ts: string; hash: string; email: string | null; verified: boolean }> = {}): VerifiedIdentityWebhookEvent {
  const ts = o.ts ?? '2026-01-01T12:00:00.000Z';
  return {
    provider: 'clerk',
    providerInstanceId: INSTANCE,
    eventId: o.eventId ?? 'evt_1',
    occurredAt: ts,
    payloadSha256: o.hash ?? hex('a'),
    type: o.type ?? 'user.created',
    providerUserId: 'user_1',
    orderingTimestamp: ts,
    user: { providerUserId: 'user_1', primaryEmail: o.email === undefined ? 'wh@example.com' : o.email, emailVerified: o.verified ?? true, providerUpdatedAt: ts, providerCreatedAt: '2025-12-01T00:00:00.000Z' },
  };
}
function del(o: Partial<{ eventId: string; ts: string; hash: string }> = {}): VerifiedIdentityWebhookEvent {
  const ts = o.ts ?? '2026-02-01T12:00:00.000Z';
  return {
    provider: 'clerk',
    providerInstanceId: INSTANCE,
    eventId: o.eventId ?? 'evt_del',
    occurredAt: ts,
    payloadSha256: o.hash ?? hex('d'),
    type: 'user.deleted',
    providerUserId: 'user_1',
    orderingTimestamp: ts,
  };
}

describe.skipIf(!hasTestDatabase)('read-through reconciliation (real PostgreSQL)', () => {
  let client: DatabaseClient;
  const getUser = (userId = 'user_1', instance = INSTANCE): Promise<UserRow | undefined> =>
    client.kysely.selectFrom('users').selectAll().where('provider', '=', 'clerk').where('provider_instance_id', '=', instance).where('provider_user_id', '=', userId).executeTakeFirst();
  const countUsers = async (): Promise<number> => {
    const r = await client.kysely.selectFrom('users').select(client.kysely.fn.countAll<string>().as('n')).where('provider_user_id', '=', 'user_1').execute();
    return Number(r[0]?.n ?? 0);
  };
  const countReceipts = async (): Promise<number> => {
    const r = await client.kysely.selectFrom('identity_webhook_receipts').select(client.kysely.fn.countAll<string>().as('n')).execute();
    return Number(r[0]?.n ?? 0);
  };

  beforeAll(async () => {
    client = createTestDatabase();
    // Full drop incl. _acbp_migration_probe so a re-migrate cannot conflict when another integration
    // suite (shared CI database) created it first and this suite dropped kysely_migration.
    for (const t of ['interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) await client.kysely.schema.dropTable(t).ifExists().cascade().execute();
    const r = await migrateToLatest(client);
    expect(r.error).toBeUndefined();
  });
  afterAll(async () => {
    if (client) {
      for (const t of ['interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await client.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(client);
    }
  });
  beforeEach(async () => {
    await client.kysely.deleteFrom('identity_webhook_receipts').execute();
    await client.kysely.deleteFrom('users').execute();
  });

  test('read-through creates one active mapping and NO receipt', async () => {
    const result = await resolveOrReconcileInternalUser(client, found(), KEY);
    expect(result.status).toBe('active');
    const u = await getUser();
    expect(u?.status).toBe('active');
    expect(u?.primary_email).toBe('rt@example.com');
    expect(u?.last_event_id).toBeNull();
    expect(await countUsers()).toBe(1);
    expect(await countReceipts()).toBe(0); // read-through is authoritative sync, not a synthetic webhook
  });

  test('an existing active mapping resolves without calling the provider', async () => {
    await resolveOrReconcileInternalUser(client, found(), KEY);
    const reader = found();
    const result = await resolveOrReconcileInternalUser(client, reader, KEY);
    expect(result.status).toBe('active');
    expect(reader.calls).toBe(0); // fast path
  });

  test('provider not_found creates nothing', async () => {
    const result = await resolveOrReconcileInternalUser(client, new FixedReader({ status: 'not_found' }), KEY);
    expect(result).toEqual({ status: 'not_found' });
    expect(await countUsers()).toBe(0);
  });

  test('provider unavailable creates nothing', async () => {
    const error = { category: 'provider_unavailable', code: 'DEPENDENCY_UNAVAILABLE', message: 'x', retryable: true } as const;
    const result = await resolveOrReconcileInternalUser(client, new FixedReader({ status: 'unavailable', error }), KEY);
    expect(result.status).toBe('unavailable');
    expect(await countUsers()).toBe(0);
  });

  test('two concurrent read-throughs create exactly one row and resolve to the same internal id', async () => {
    const [a, b] = await Promise.all([resolveOrReconcileInternalUser(client, found(), KEY), resolveOrReconcileInternalUser(client, found(), KEY)]);
    expect(a.status).toBe('active');
    expect(b.status).toBe('active');
    expect(a.status === 'active' && b.status === 'active' && a.userId === b.userId).toBe(true);
    expect(await countUsers()).toBe(1);
    expect(await countReceipts()).toBe(0);
  });

  test('webhook-first then read-through: read-through converges onto the webhook row (one row, same id)', async () => {
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_wh', email: 'wh@example.com' }));
    const whId = (await getUser())?.id;
    const result = await resolveOrReconcileInternalUser(client, found(), KEY);
    expect(result).toEqual({ status: 'active', userId: whId });
    expect(await countUsers()).toBe(1);
  });

  test('read-through-first then webhook updates the SAME internal user', async () => {
    const rt = await resolveOrReconcileInternalUser(client, found({ primaryEmail: 'rt@example.com' }), KEY);
    const rtId = rt.status === 'active' ? rt.userId : undefined;
    await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_wh', ts: '2026-02-01T00:00:00.000Z', email: 'updated@example.com' }));
    const u = await getUser();
    expect(u?.id).toBe(rtId); // internal immutable id unchanged
    expect(u?.primary_email).toBe('updated@example.com');
    expect(u?.last_event_id).toBe('evt_wh');
    expect(await countUsers()).toBe(1);
  });

  test('equal provider_updated_at with last_event_id=null lets a webhook event apply (id sorts after null)', async () => {
    await resolveOrReconcileInternalUser(client, found({ primaryEmail: 'rt@example.com', providerUpdatedAt: new Date('2026-01-01T12:00:00.000Z') }), KEY);
    const before = await getUser();
    expect(before?.last_event_id).toBeNull();
    const out = await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_tie', ts: '2026-01-01T12:00:00.000Z', hash: hex('b'), email: 'tie@example.com' }));
    expect(out.outcome).toBe('applied');
    const u = await getUser();
    expect(u?.id).toBe(before?.id);
    expect(u?.primary_email).toBe('tie@example.com');
    expect(u?.last_event_id).toBe('evt_tie');
  });

  test('a deleted tombstone blocks read-through resurrection', async () => {
    await processVerifiedIdentityEvent(client, del({ eventId: 'evt_del', ts: '2026-02-01T12:00:00.000Z' }));
    const result = await resolveOrReconcileInternalUser(client, found({ providerUpdatedAt: new Date('2026-03-01T12:00:00.000Z') }), KEY);
    expect(result).toEqual({ status: 'deleted' });
    const u = await getUser();
    expect(u?.status).toBe('deleted');
    expect(u?.primary_email).toBeNull();
    expect(await countUsers()).toBe(1);
  });

  test('an unrelated check-constraint violation is a sanitized failure, not a partial mapping', async () => {
    // A malformed snapshot (empty provider_user_id) violates users_provider_user_id_not_empty (23514)
    // AND the fast-path find never matches it, so convergence attempts the insert and fails.
    const badKey: ProviderIdentityKey = { provider: 'clerk', providerInstanceId: INSTANCE, providerUserId: 'user_bad' };
    const reader = new FixedReader({ status: 'found', snapshot: snapshot({ providerUserId: '' }) });
    let caught: unknown;
    try {
      await resolveOrReconcileInternalUser(client, reader, badKey);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlatformError);
    if (caught instanceof PlatformError) {
      expect(JSON.stringify(caught.toPublic())).not.toMatch(/constraint|23514|users_/i);
    }
    expect(await countUsers()).toBe(0); // no partial mapping
  });

  test('concurrent read-through and webhook create exactly one row (no duplicate, no misclassification)', async () => {
    const settled = await Promise.allSettled([
      resolveOrReconcileInternalUser(client, found({ primaryEmail: 'rt@example.com' }), KEY),
      processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_race', email: 'wh@example.com' })),
    ]);
    for (const s of settled) {
      if (s.status === 'rejected') expect(s.reason).toBeInstanceOf(PlatformError); // sanitized; never a raw 23505
    }
    // Whatever the interleaving, exactly one identity row exists.
    const rows = await client.kysely.selectFrom('users').selectAll().where('provider_user_id', '=', 'user_1').execute();
    expect(rows).toHaveLength(1);
  });
});
