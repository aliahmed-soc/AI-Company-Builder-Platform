// ACBP-P1-002 — convergence + idempotency unit tests for the identity webhook processor and the
// internal-user resolver. Uses in-memory fake stores (no database) to prove the ordering, replay,
// conflict, soft-delete, and no-resurrection rules deterministically. Fake identities only.
import { describe, test, expect } from 'vitest';
import type {
  ProviderIdentityKey,
  UserRow,
  NewUser,
  UserUpdate,
  IdentityWebhookReceiptRow,
  NewIdentityWebhookReceipt,
} from '@acbp/database';
import type { VerifiedIdentityWebhookEvent } from '@acbp/contracts';
import { applyIdentityEvent, resolveWithStore, type UserMappingStore, type WebhookReceiptStore } from './index.js';

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const asDateOrNull = (v: Date | string | null): Date | null => (v === null ? null : asDate(v));
const idKey = (k: ProviderIdentityKey): string => `${k.provider}|${k.providerInstanceId}|${k.providerUserId}`;

class FakeUserStore implements UserMappingStore {
  readonly rows = new Map<string, UserRow>();
  #seq = 0;
  insertCount = 0;
  updateCount = 0;
  failInsert = false;
  /** When set, insert rejects with this exact error (used to simulate raw PostgreSQL failures). */
  insertThrow: Error | undefined = undefined;

  findByProviderIdentity(key: ProviderIdentityKey): Promise<UserRow | undefined> {
    return Promise.resolve(this.rows.get(idKey(key)));
  }
  insert(values: NewUser): Promise<UserRow> {
    this.insertCount += 1;
    if (this.insertThrow) return Promise.reject(this.insertThrow);
    if (this.failInsert) return Promise.reject(new Error('forced insert failure'));
    const now = new Date('2026-01-01T00:00:00.000Z');
    const row: UserRow = {
      id: `user-row-${(this.#seq += 1)}`,
      provider: values.provider,
      provider_instance_id: values.provider_instance_id,
      provider_user_id: values.provider_user_id,
      primary_email: values.primary_email ?? null,
      email_verified: values.email_verified ?? false,
      status: values.status ?? 'active',
      provider_created_at: asDateOrNull(values.provider_created_at ?? null),
      provider_updated_at: asDate(values.provider_updated_at),
      last_event_id: values.last_event_id ?? null,
      created_at: now,
      updated_at: now,
      deleted_at: asDateOrNull(values.deleted_at ?? null),
    };
    this.rows.set(idKey({ provider: row.provider, providerInstanceId: row.provider_instance_id, providerUserId: row.provider_user_id }), row);
    return Promise.resolve(row);
  }
  updateByProviderIdentity(key: ProviderIdentityKey, patch: UserUpdate): Promise<void> {
    this.updateCount += 1;
    const row = this.rows.get(idKey(key));
    if (row === undefined) return Promise.reject(new Error('update of missing row'));
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.primary_email !== undefined) row.primary_email = patch.primary_email;
    if (patch.email_verified !== undefined) row.email_verified = patch.email_verified;
    if (patch.provider_updated_at !== undefined) row.provider_updated_at = asDate(patch.provider_updated_at);
    if (patch.last_event_id !== undefined) row.last_event_id = patch.last_event_id;
    if (patch.updated_at !== undefined) row.updated_at = asDate(patch.updated_at);
    if (patch.deleted_at !== undefined) row.deleted_at = asDateOrNull(patch.deleted_at);
    return Promise.resolve();
  }
}

class FakeReceiptStore implements WebhookReceiptStore {
  readonly rows = new Map<string, IdentityWebhookReceiptRow>();
  #key(provider: string, instance: string, eventId: string): string {
    return `${provider}|${instance}|${eventId}`;
  }
  insertIfNew(values: NewIdentityWebhookReceipt): Promise<boolean> {
    const k = this.#key(values.provider, values.provider_instance_id, values.event_id);
    if (this.rows.has(k)) return Promise.resolve(false);
    this.rows.set(k, {
      provider: values.provider,
      provider_instance_id: values.provider_instance_id,
      event_id: values.event_id,
      event_type: values.event_type,
      occurred_at: asDate(values.occurred_at),
      ordering_timestamp: asDate(values.ordering_timestamp),
      payload_sha256: values.payload_sha256,
      processed_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    return Promise.resolve(true);
  }
  find(provider: string, instance: string, eventId: string): Promise<IdentityWebhookReceiptRow | undefined> {
    return Promise.resolve(this.rows.get(this.#key(provider, instance, eventId)));
  }
}

const KEY = { provider: 'clerk', providerInstanceId: 'ins_1', providerUserId: 'user_1' } as const;

function upsert(over: Partial<{ type: 'user.created' | 'user.updated'; eventId: string; ts: string; hash: string; email: string | null; verified: boolean }> = {}): VerifiedIdentityWebhookEvent {
  const ts = over.ts ?? '2026-01-01T12:00:00.000Z';
  return {
    provider: 'clerk',
    providerInstanceId: 'ins_1',
    eventId: over.eventId ?? 'evt_1',
    occurredAt: ts,
    payloadSha256: over.hash ?? 'hash-a',
    type: over.type ?? 'user.created',
    providerUserId: 'user_1',
    orderingTimestamp: ts,
    user: {
      providerUserId: 'user_1',
      primaryEmail: over.email === undefined ? 'a@example.com' : over.email,
      emailVerified: over.verified ?? true,
      providerUpdatedAt: ts,
      providerCreatedAt: '2025-12-01T00:00:00.000Z',
    },
  };
}
function del(over: Partial<{ eventId: string; ts: string; hash: string }> = {}): VerifiedIdentityWebhookEvent {
  const ts = over.ts ?? '2026-01-02T12:00:00.000Z';
  return {
    provider: 'clerk',
    providerInstanceId: 'ins_1',
    eventId: over.eventId ?? 'evt_del',
    occurredAt: ts,
    payloadSha256: over.hash ?? 'hash-del',
    type: 'user.deleted',
    providerUserId: 'user_1',
    orderingTimestamp: ts,
  };
}

function stores(): { users: FakeUserStore; receipts: FakeReceiptStore } {
  return { users: new FakeUserStore(), receipts: new FakeReceiptStore() };
}

describe('applyIdentityEvent — upsert convergence', () => {
  test('user.created inserts an active user', async () => {
    const { users, receipts } = stores();
    expect(await applyIdentityEvent(users, receipts, upsert())).toBe('applied');
    const row = users.rows.get('clerk|ins_1|user_1');
    expect(row?.status).toBe('active');
    expect(row?.primary_email).toBe('a@example.com');
    expect(receipts.rows.size).toBe(1);
  });

  test('user.updated on an existing row applies the newer state', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, upsert({ eventId: 'evt_1', ts: '2026-01-01T12:00:00.000Z' }));
    const out = await applyIdentityEvent(users, receipts, upsert({ type: 'user.updated', eventId: 'evt_2', ts: '2026-01-01T13:00:00.000Z', hash: 'hash-b', email: 'new@example.com' }));
    expect(out).toBe('applied');
    expect(users.rows.get('clerk|ins_1|user_1')?.primary_email).toBe('new@example.com');
  });

  test('update-before-create inserts (no lost update)', async () => {
    const { users, receipts } = stores();
    expect(await applyIdentityEvent(users, receipts, upsert({ type: 'user.updated', eventId: 'evt_u' }))).toBe('applied');
    expect(users.rows.get('clerk|ins_1|user_1')?.status).toBe('active');
  });

  test('an older event is stale and does not overwrite', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, upsert({ eventId: 'evt_new', ts: '2026-01-01T13:00:00.000Z', email: 'keep@example.com' }));
    const out = await applyIdentityEvent(users, receipts, upsert({ type: 'user.updated', eventId: 'evt_old', ts: '2026-01-01T12:00:00.000Z', hash: 'hash-old', email: 'stale@example.com' }));
    expect(out).toBe('stale');
    expect(users.rows.get('clerk|ins_1|user_1')?.primary_email).toBe('keep@example.com');
  });

  test('equal-timestamp tie-break is deterministic by event id', async () => {
    const higher = stores();
    await applyIdentityEvent(higher.users, higher.receipts, upsert({ eventId: 'evt_500', email: 'first@example.com' }));
    expect(await applyIdentityEvent(higher.users, higher.receipts, upsert({ type: 'user.updated', eventId: 'evt_900', hash: 'h2', email: 'win@example.com' }))).toBe('applied');
    expect(higher.users.rows.get('clerk|ins_1|user_1')?.primary_email).toBe('win@example.com');

    const lower = stores();
    await applyIdentityEvent(lower.users, lower.receipts, upsert({ eventId: 'evt_500', email: 'first@example.com' }));
    expect(await applyIdentityEvent(lower.users, lower.receipts, upsert({ type: 'user.updated', eventId: 'evt_100', hash: 'h3', email: 'lose@example.com' }))).toBe('stale');
    expect(lower.users.rows.get('clerk|ins_1|user_1')?.primary_email).toBe('first@example.com');
  });
});

describe('applyIdentityEvent — idempotency + conflict', () => {
  test('redelivery of the same event id + same hash is a duplicate no-op', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, upsert({ eventId: 'evt_1', hash: 'hash-a' }));
    const before = users.updateCount + users.insertCount;
    expect(await applyIdentityEvent(users, receipts, upsert({ eventId: 'evt_1', hash: 'hash-a' }))).toBe('duplicate');
    expect(users.updateCount + users.insertCount).toBe(before); // no further user mutation
    expect(receipts.rows.size).toBe(1);
  });

  test('same event id with a DIFFERENT hash is a security conflict (no mutation)', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, upsert({ eventId: 'evt_1', hash: 'hash-a', email: 'orig@example.com' }));
    const out = await applyIdentityEvent(users, receipts, upsert({ eventId: 'evt_1', hash: 'hash-TAMPERED', email: 'evil@example.com' }));
    expect(out).toBe('security_conflict');
    expect(users.rows.get('clerk|ins_1|user_1')?.primary_email).toBe('orig@example.com');
    expect(receipts.rows.get('clerk|ins_1|evt_1')?.payload_sha256).toBe('hash-a'); // original receipt untouched
  });
});

describe('applyIdentityEvent — delete + no resurrection', () => {
  test('deleting an active user redacts PII and marks it deleted', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, upsert({ eventId: 'evt_1' }));
    expect(await applyIdentityEvent(users, receipts, del({ eventId: 'evt_del' }))).toBe('applied');
    const row = users.rows.get('clerk|ins_1|user_1');
    expect(row?.status).toBe('deleted');
    expect(row?.primary_email).toBeNull();
    expect(row?.email_verified).toBe(false);
    expect(row?.deleted_at).not.toBeNull();
  });

  test('delete-before-create writes a tombstone', async () => {
    const { users, receipts } = stores();
    expect(await applyIdentityEvent(users, receipts, del({ eventId: 'evt_del' }))).toBe('applied');
    expect(users.rows.get('clerk|ins_1|user_1')?.status).toBe('deleted');
  });

  test('a create/update after deletion never resurrects the identity', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, del({ eventId: 'evt_del', ts: '2026-01-02T12:00:00.000Z' }));
    const out = await applyIdentityEvent(users, receipts, upsert({ type: 'user.updated', eventId: 'evt_late', ts: '2026-01-03T12:00:00.000Z', hash: 'h-late', email: 'ghost@example.com' }));
    expect(out).toBe('deleted_identity_noop');
    const row = users.rows.get('clerk|ins_1|user_1');
    expect(row?.status).toBe('deleted');
    expect(row?.primary_email).toBeNull();
  });

  test('repeated delete keeps one tombstone and preserves the original deletion time', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, del({ eventId: 'evt_del1', ts: '2026-01-02T12:00:00.000Z' }));
    const first = users.rows.get('clerk|ins_1|user_1')?.deleted_at;
    expect(await applyIdentityEvent(users, receipts, del({ eventId: 'evt_del2', ts: '2026-01-03T12:00:00.000Z' }))).toBe('applied');
    expect(users.rows.size).toBe(1);
    expect(users.rows.get('clerk|ins_1|user_1')?.deleted_at).toEqual(first); // deletion time not moved
  });
});

describe('applyIdentityEvent — failure propagation (not receipt-conflict misclassification)', () => {
  test('a user mutation failure propagates (so the transaction can roll back the receipt)', async () => {
    const { users, receipts } = stores();
    users.failInsert = true;
    await expect(applyIdentityEvent(users, receipts, upsert())).rejects.toThrow(/forced insert failure/);
  });

  // §3 #18 — a users-uniqueness (23505) violation is NOT the receipt PK conflict, so it must throw
  // and NEVER be reported as duplicate/security_conflict (those are reserved for the receipt key).
  test('an unrelated user-identity uniqueness violation is not classified as a receipt duplicate', async () => {
    const { users, receipts } = stores();
    const pgUnique = Object.assign(new Error('duplicate key value violates unique constraint "users_provider_identity_unique"'), { code: '23505' });
    users.insertThrow = pgUnique;
    let outcome: string | undefined;
    let threw: unknown;
    try {
      outcome = await applyIdentityEvent(users, receipts, upsert());
    } catch (e) {
      threw = e;
    }
    expect(threw).toBe(pgUnique); // propagated verbatim to the transaction wrapper
    expect(outcome).not.toBe('duplicate');
    expect(outcome).not.toBe('security_conflict');
  });

  // §3 #19 — an unrelated check-constraint (23514) violation likewise propagates as a failure.
  test('an unrelated check-constraint violation is not classified as duplicate or security_conflict', async () => {
    const { users, receipts } = stores();
    const pgCheck = Object.assign(new Error('new row violates check constraint "users_deleted_email_redacted"'), { code: '23514' });
    users.insertThrow = pgCheck;
    await expect(applyIdentityEvent(users, receipts, upsert())).rejects.toBe(pgCheck);
  });
});

describe('resolveWithStore', () => {
  test('active identity resolves to its internal user id', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, upsert());
    const row = users.rows.get('clerk|ins_1|user_1');
    await expect(resolveWithStore(users, KEY)).resolves.toEqual({ status: 'active', userId: row?.id });
  });

  test('deleted identity resolves as deleted (never active, no PII)', async () => {
    const { users, receipts } = stores();
    await applyIdentityEvent(users, receipts, del());
    await expect(resolveWithStore(users, KEY)).resolves.toEqual({ status: 'deleted' });
  });

  test('unknown identity resolves as not_found', async () => {
    const { users } = stores();
    await expect(resolveWithStore(users, KEY)).resolves.toEqual({ status: 'not_found' });
  });
});
