// ACBP-P1-002 — real-PostgreSQL convergence + idempotency tests for the transactional identity
// webhook processor (processVerifiedIdentityEvent) and the internal-user resolver. Proves the CDR-007/
// CDR-008 trust-critical invariants against actual Postgres semantics (ON CONFLICT, transactional
// rollback, concurrent delivery), NOT fakes. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked.
// Self-cleaning. Fake identities only. Lives in @acbp/core because it exercises core → database (the
// reverse edge would be a package cycle); the database package proves the raw schema/constraints.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, type DatabaseClient, type UserRow } from '@acbp/database';
import { PlatformError } from '@acbp/contracts';
import type { VerifiedIdentityWebhookEvent } from '@acbp/contracts';
import { processVerifiedIdentityEvent } from './webhook-processor.js';
import { resolveInternalUser } from './user-resolver.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
function createTestDatabase(): DatabaseClient {
  return createDatabase(
    parseDatabaseConfig({
      APP_ENV: 'test',
      DATABASE_URL: url,
      DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable',
      DATABASE_APP_NAME: 'acbp-integration',
    }),
  );
}

const hex = (c: string): string => c.repeat(64); // valid lowercase 64-hex sha256 for the receipt check
const INSTANCE = 'ins_1';

function upsert(o: Partial<{ type: 'user.created' | 'user.updated'; instance: string; userId: string; eventId: string; ts: string; hash: string; email: string | null; verified: boolean }> = {}): VerifiedIdentityWebhookEvent {
  const ts = o.ts ?? '2026-01-01T12:00:00.000Z';
  const userId = o.userId ?? 'user_1';
  return {
    provider: 'clerk',
    providerInstanceId: o.instance ?? INSTANCE,
    eventId: o.eventId ?? 'evt_1',
    occurredAt: ts,
    payloadSha256: o.hash ?? hex('a'),
    type: o.type ?? 'user.created',
    providerUserId: userId,
    orderingTimestamp: ts,
    user: {
      providerUserId: userId,
      primaryEmail: o.email === undefined ? 'a@example.com' : o.email,
      emailVerified: o.verified ?? true,
      providerUpdatedAt: ts,
      providerCreatedAt: '2025-12-01T00:00:00.000Z',
    },
  };
}
function del(o: Partial<{ instance: string; userId: string; eventId: string; ts: string; hash: string }> = {}): VerifiedIdentityWebhookEvent {
  const ts = o.ts ?? '2026-02-01T12:00:00.000Z';
  const userId = o.userId ?? 'user_1';
  return {
    provider: 'clerk',
    providerInstanceId: o.instance ?? INSTANCE,
    eventId: o.eventId ?? 'evt_del',
    occurredAt: ts,
    payloadSha256: o.hash ?? hex('d'),
    type: 'user.deleted',
    providerUserId: userId,
    orderingTimestamp: ts,
  };
}

// All permutations of a 3-element sequence (deterministic; Math.random is not used).
const PERMS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

describe.skipIf(!hasTestDatabase)('identity webhook processor (real PostgreSQL)', () => {
  let client: DatabaseClient;
  const getUser = (userId = 'user_1', instance = INSTANCE): Promise<UserRow | undefined> =>
    client.kysely.selectFrom('users').selectAll().where('provider', '=', 'clerk').where('provider_instance_id', '=', instance).where('provider_user_id', '=', userId).executeTakeFirst();
  const countReceipts = async (): Promise<number> => {
    const rows = await client.kysely.selectFrom('identity_webhook_receipts').select(client.kysely.fn.countAll<string>().as('n')).execute();
    return Number(rows[0]?.n ?? 0);
  };

  beforeAll(async () => {
    client = createTestDatabase();
    // Full drop incl. _acbp_migration_probe so a re-migrate cannot conflict when another integration
    // suite (shared CI database) created it first and this suite dropped kysely_migration.
    for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users', '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await client.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(client);
    expect(r.error).toBeUndefined();
  });
  afterAll(async () => {
    if (client) {
      for (const t of ['usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users']) await client.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(client);
    }
  });
  beforeEach(async () => {
    await client.kysely.deleteFrom('identity_webhook_receipts').execute();
    await client.kysely.deleteFrom('users').execute();
  });

  test('create commits the user row and the receipt atomically', async () => {
    const out = await processVerifiedIdentityEvent(client, upsert());
    expect(out.outcome).toBe('applied');
    const u = await getUser();
    expect(u?.status).toBe('active');
    expect(u?.primary_email).toBe('a@example.com');
    expect(await countReceipts()).toBe(1);
  });

  test('update-before-create inserts an active user (no lost update)', async () => {
    expect((await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_u', email: 'u@example.com' }))).outcome).toBe('applied');
    expect((await getUser())?.primary_email).toBe('u@example.com');
  });

  test('redelivery (same event id + same hash) is a duplicate no-op — one receipt, user unchanged', async () => {
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_1', hash: hex('a'), email: 'orig@example.com' }));
    const out = await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_1', hash: hex('a'), email: 'orig@example.com' }));
    expect(out.outcome).toBe('duplicate');
    expect(await countReceipts()).toBe(1);
    expect((await getUser())?.primary_email).toBe('orig@example.com');
  });

  test('same event id + DIFFERENT hash is a security conflict — user + receipt untouched', async () => {
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_1', hash: hex('a'), email: 'orig@example.com' }));
    const out = await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_1', hash: hex('b'), email: 'evil@example.com' }));
    expect(out.outcome).toBe('security_conflict');
    expect((await getUser())?.primary_email).toBe('orig@example.com');
    expect(await countReceipts()).toBe(1); // no second receipt inserted
    const receipt = await client.kysely.selectFrom('identity_webhook_receipts').selectAll().where('event_id', '=', 'evt_1').executeTakeFirst();
    expect(receipt?.payload_sha256).toBe(hex('a')); // original digest preserved
  });

  test('concurrent identical delivery yields exactly one user and one receipt', async () => {
    const ev = upsert({ eventId: 'evt_conc', hash: hex('c') });
    const [a, b] = await Promise.all([processVerifiedIdentityEvent(client, ev), processVerifiedIdentityEvent(client, ev)]);
    expect([a.outcome, b.outcome].sort()).toEqual(['applied', 'duplicate']);
    expect(await countReceipts()).toBe(1);
    const n = await client.kysely.selectFrom('users').select(client.kysely.fn.countAll<string>().as('n')).execute();
    expect(Number(n[0]?.n)).toBe(1);
  });

  test('a user-mutation failure rolls back the receipt too (no orphan receipt)', async () => {
    // provider_user_id='' passes the receipt check but violates users_provider_user_id_not_empty,
    // so the user insert throws INSIDE the transaction → receipt must roll back with it.
    await expect(processVerifiedIdentityEvent(client, upsert({ userId: '', eventId: 'evt_fail', hash: hex('e') }))).rejects.toBeTruthy();
    expect(await countReceipts()).toBe(0);
    const n = await client.kysely.selectFrom('users').select(client.kysely.fn.countAll<string>().as('n')).execute();
    expect(Number(n[0]?.n)).toBe(0);
  });

  // §3 #19 — an unrelated CHECK-constraint violation surfaces as a sanitized failure, never as a
  // receipt-conflict classification, and never leaking the raw SQL/constraint text.
  test('an unrelated check-constraint violation is a sanitized internal failure, not duplicate/conflict', async () => {
    let caught: unknown;
    try {
      await processVerifiedIdentityEvent(client, upsert({ userId: '', eventId: 'evt_check', hash: hex('f') }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PlatformError);
    if (caught instanceof PlatformError) {
      const publicJson = JSON.stringify(caught.toPublic());
      expect(publicJson).not.toMatch(/constraint|check|users_provider_user_id_not_empty|23514/i);
    }
    expect(await countReceipts()).toBe(0);
  });

  // §3 #18 — two DIFFERENT event ids for the SAME new identity delivered concurrently. However the DB
  // interleaves, the outcome must NEVER be a receipt duplicate/security_conflict (those belong to the
  // receipt key), exactly one user row must exist, and any rejection is a sanitized PlatformError
  // (a raw users-uniqueness 23505 must not leak).
  test('an unrelated user-identity uniqueness race is never misclassified as a receipt duplicate', async () => {
    const settled = await Promise.allSettled([
      processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_u1', hash: hex('a') })),
      processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_u2', hash: hex('b') })),
    ]);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        expect(['applied', 'stale']).toContain(s.value.outcome); // never duplicate / security_conflict
      } else {
        expect(s.reason).toBeInstanceOf(PlatformError); // sanitized, not a raw 23505
        expect(JSON.stringify((s.reason as PlatformError).toPublic())).not.toMatch(/23505|unique constraint/i);
      }
    }
    const n = await client.kysely.selectFrom('users').select(client.kysely.fn.countAll<string>().as('n')).where('provider_user_id', '=', 'user_1').execute();
    expect(Number(n[0]?.n)).toBe(1); // exactly one identity row regardless of interleaving
  });

  test('a stale (older) update cannot overwrite newer state, but its receipt still commits', async () => {
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_new', ts: '2026-01-01T13:00:00.000Z', hash: hex('a'), email: 'keep@example.com' }));
    const out = await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_old', ts: '2026-01-01T12:00:00.000Z', hash: hex('b'), email: 'stale@example.com' }));
    expect(out.outcome).toBe('stale');
    expect((await getUser())?.primary_email).toBe('keep@example.com');
    expect(await countReceipts()).toBe(2); // a stale event is still a SUCCESSFULLY processed delivery
  });

  test('equal-timestamp events break the tie deterministically by event id', async () => {
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_500', hash: hex('a'), email: 'first@example.com' }));
    expect((await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_900', hash: hex('b'), email: 'win@example.com' }))).outcome).toBe('applied');
    expect((await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_100', hash: hex('c'), email: 'lose@example.com' }))).outcome).toBe('stale');
    expect((await getUser())?.primary_email).toBe('win@example.com');
  });

  test('an email change updates the single existing row', async () => {
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_1', email: 'old@example.com' }));
    await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_2', ts: '2026-01-01T13:00:00.000Z', hash: hex('b'), email: 'changed@example.com', verified: true }));
    const u = await getUser();
    expect(u?.primary_email).toBe('changed@example.com');
    expect(u?.email_verified).toBe(true);
  });

  test('an unverified email is persisted as email_verified=false', async () => {
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_1', verified: true }));
    await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_2', ts: '2026-01-01T13:00:00.000Z', hash: hex('b'), email: 'x@example.com', verified: false }));
    expect((await getUser())?.email_verified).toBe(false);
  });

  test('delete soft-deletes and redacts PII', async () => {
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_1' }));
    expect((await processVerifiedIdentityEvent(client, del({ eventId: 'evt_del' }))).outcome).toBe('applied');
    const u = await getUser();
    expect(u?.status).toBe('deleted');
    expect(u?.primary_email).toBeNull();
    expect(u?.email_verified).toBe(false);
    expect(u?.deleted_at).not.toBeNull();
  });

  test('delete-before-create writes a tombstone', async () => {
    expect((await processVerifiedIdentityEvent(client, del({ eventId: 'evt_del' }))).outcome).toBe('applied');
    expect((await getUser())?.status).toBe('deleted');
  });

  test('a create/update delivered after a delete never resurrects the identity', async () => {
    await processVerifiedIdentityEvent(client, del({ eventId: 'evt_del', ts: '2026-02-01T12:00:00.000Z' }));
    const out = await processVerifiedIdentityEvent(client, upsert({ type: 'user.updated', eventId: 'evt_late', ts: '2026-03-01T12:00:00.000Z', hash: hex('b'), email: 'ghost@example.com' }));
    expect(out.outcome).toBe('deleted_identity_noop');
    const u = await getUser();
    expect(u?.status).toBe('deleted');
    expect(u?.primary_email).toBeNull();
  });

  test('repeated delete keeps one tombstone and preserves the original deletion time', async () => {
    await processVerifiedIdentityEvent(client, del({ eventId: 'evt_del1', ts: '2026-02-01T12:00:00.000Z' }));
    const first = (await getUser())?.deleted_at;
    expect((await processVerifiedIdentityEvent(client, del({ eventId: 'evt_del2', ts: '2026-03-01T12:00:00.000Z' }))).outcome).toBe('applied');
    const rows = await client.kysely.selectFrom('users').selectAll().where('provider_user_id', '=', 'user_1').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deleted_at?.getTime()).toBe(first?.getTime());
  });

  test('provider instances are isolated (same provider_user_id, different instance)', async () => {
    await processVerifiedIdentityEvent(client, upsert({ instance: 'ins_a', eventId: 'evt_a', email: 'a@example.com' }));
    await processVerifiedIdentityEvent(client, upsert({ instance: 'ins_b', eventId: 'evt_b', hash: hex('b'), email: 'b@example.com' }));
    const ra = await resolveInternalUser(client, { provider: 'clerk', providerInstanceId: 'ins_a', providerUserId: 'user_1' });
    const rb = await resolveInternalUser(client, { provider: 'clerk', providerInstanceId: 'ins_b', providerUserId: 'user_1' });
    expect(ra.status).toBe('active');
    expect(rb.status).toBe('active');
    expect(ra.status === 'active' && rb.status === 'active' && ra.userId !== rb.userId).toBe(true);
  });

  test('resolveInternalUser reflects active / deleted / not_found', async () => {
    const key = { provider: 'clerk', providerInstanceId: INSTANCE, providerUserId: 'user_1' } as const;
    await expect(resolveInternalUser(client, key)).resolves.toEqual({ status: 'not_found' });
    await processVerifiedIdentityEvent(client, upsert({ eventId: 'evt_1' }));
    const active = await resolveInternalUser(client, key);
    expect(active.status).toBe('active');
    await processVerifiedIdentityEvent(client, del({ eventId: 'evt_del' }));
    await expect(resolveInternalUser(client, key)).resolves.toEqual({ status: 'deleted' });
  });

  // TRUST-CRITICAL: whatever the delivery ORDER, the converged state must equal the state implied by
  // the highest-ordering-timestamp event. Every permutation runs against a freshly cleaned table.
  test('full-replay convergence is independent of delivery order (upserts)', async () => {
    // These are provider-neutral events AFTER Clerk-adapter normalization (already trimmed/lowercased):
    // the processor persists the neutral value verbatim and is NOT responsible for provider-specific
    // email normalization, so the fixtures must carry the normalized (lowercase) form.
    const seq = [
      upsert({ eventId: 'evt_t1', ts: '2026-01-01T10:00:00.000Z', hash: hex('a'), email: 'a@example.com', verified: false }),
      upsert({ type: 'user.updated', eventId: 'evt_t2', ts: '2026-01-01T11:00:00.000Z', hash: hex('b'), email: 'b@example.com', verified: true }),
      upsert({ type: 'user.updated', eventId: 'evt_t3', ts: '2026-01-01T12:00:00.000Z', hash: hex('c'), email: 'c@example.com', verified: false }),
    ];
    for (const perm of PERMS) {
      await client.kysely.deleteFrom('identity_webhook_receipts').execute();
      await client.kysely.deleteFrom('users').execute();
      for (const i of perm) await processVerifiedIdentityEvent(client, seq[i]!);
      const u = await getUser();
      expect(u?.status, `perm ${perm.join('')}`).toBe('active');
      expect(u?.primary_email, `perm ${perm.join('')}`).toBe('c@example.com'); // t3 wins regardless of order
      expect(u?.email_verified, `perm ${perm.join('')}`).toBe(false);
    }
  });

  test('full-replay convergence is independent of delivery order (terminal delete)', async () => {
    // Provider-neutral (already adapter-normalized) events; final state is a redacted tombstone.
    const seq = [
      upsert({ eventId: 'evt_t1', ts: '2026-01-01T10:00:00.000Z', hash: hex('a'), email: 'a@example.com' }),
      upsert({ type: 'user.updated', eventId: 'evt_t2', ts: '2026-01-01T11:00:00.000Z', hash: hex('b'), email: 'b@example.com' }),
      del({ eventId: 'evt_t3', ts: '2026-01-01T12:00:00.000Z', hash: hex('c') }),
    ];
    for (const perm of PERMS) {
      await client.kysely.deleteFrom('identity_webhook_receipts').execute();
      await client.kysely.deleteFrom('users').execute();
      for (const i of perm) await processVerifiedIdentityEvent(client, seq[i]!);
      const u = await getUser();
      expect(u?.status, `perm ${perm.join('')}`).toBe('deleted'); // terminal delete wins regardless of order
      expect(u?.primary_email, `perm ${perm.join('')}`).toBeNull();
    }
  });
});
