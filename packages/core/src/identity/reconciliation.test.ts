// ACBP-P1-002 — nightly reconciliation unit tests with in-memory fakes (no database, no Clerk). Proves
// forward-drift repair, idempotency, non-destructive provider_missing/unavailable handling, keyset
// pagination, and that tombstones are never scanned/resurrected. Fake identities only.
import { describe, test, expect } from 'vitest';
import type { ProviderIdentityKey, UserRow } from '@acbp/database';
import type { AuthoritativeIdentityReader, AuthoritativeIdentityResult, AuthoritativeIdentitySnapshot } from '@acbp/contracts';
import { reconcileUsersWithStore, type ReconcileUserStore } from './reconciliation.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const idKey = (k: ProviderIdentityKey): string => `${k.provider}|${k.providerInstanceId}|${k.providerUserId}`;

function activeRow(over: Partial<UserRow> & { id: string; provider_user_id: string }): UserRow {
  return {
    provider: 'clerk',
    provider_instance_id: 'ins_1',
    primary_email: 'old@example.com',
    email_verified: false,
    status: 'active',
    provider_created_at: null,
    provider_updated_at: new Date('2026-01-01T10:00:00.000Z'),
    last_event_id: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    ...over,
  };
}

class FakeStore implements ReconcileUserStore {
  readonly rows: UserRow[];
  listCalls = 0;
  constructor(rows: UserRow[]) {
    this.rows = rows;
  }
  listActive(afterId: string | null, limit: number): Promise<UserRow[]> {
    this.listCalls += 1;
    const active = this.rows.filter((r) => r.status === 'active').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const start = afterId === null ? active : active.filter((r) => r.id > afterId);
    return Promise.resolve(start.slice(0, limit));
  }
  repairFromAuthoritativeSnapshot(s: AuthoritativeIdentitySnapshot): Promise<boolean> {
    const row = this.rows.find((r) => idKey({ provider: r.provider, providerInstanceId: r.provider_instance_id, providerUserId: r.provider_user_id }) === idKey(s));
    if (row === undefined || row.status !== 'active') return Promise.resolve(false); // no resurrection
    if (row.provider_updated_at.getTime() >= s.providerUpdatedAt.getTime()) return Promise.resolve(false); // not strictly newer
    row.primary_email = s.primaryEmail;
    row.email_verified = s.emailVerified;
    row.provider_updated_at = s.providerUpdatedAt;
    return Promise.resolve(true);
  }
}

class MapReader implements AuthoritativeIdentityReader {
  calls = 0;
  constructor(private readonly byUser: Record<string, AuthoritativeIdentityResult>) {}
  read(query: ProviderIdentityKey): Promise<AuthoritativeIdentityResult> {
    this.calls += 1;
    return Promise.resolve(this.byUser[query.providerUserId] ?? { status: 'not_found' });
  }
}
function snap(userId: string, over: Partial<AuthoritativeIdentitySnapshot> = {}): AuthoritativeIdentityResult {
  return {
    status: 'found',
    snapshot: {
      provider: 'clerk',
      providerInstanceId: 'ins_1',
      providerUserId: userId,
      primaryEmail: 'new@example.com',
      emailVerified: true,
      providerCreatedAt: null,
      providerUpdatedAt: new Date('2026-01-01T12:00:00.000Z'),
      ...over,
    },
  };
}

describe('reconcileUsersWithStore', () => {
  test('repairs forward drift and reports counts; is idempotent on a second run', async () => {
    const store = new FakeStore([activeRow({ id: 'a', provider_user_id: 'user_a' })]);
    const reader = new MapReader({ user_a: snap('user_a') });
    const first = await reconcileUsersWithStore(store, reader, { batchSize: 50 });
    expect(first).toEqual({ scanned: 1, inSync: 0, repaired: 1, providerMissing: 0, providerUnavailable: 0 });
    expect(store.rows[0]?.primary_email).toBe('new@example.com');
    expect(store.rows[0]?.email_verified).toBe(true);
    const second = await reconcileUsersWithStore(store, reader, { batchSize: 50 });
    expect(second).toEqual({ scanned: 1, inSync: 1, repaired: 0, providerMissing: 0, providerUnavailable: 0 }); // idempotent
  });

  test('an authoritative snapshot NOT newer than stored is in_sync (no overwrite)', async () => {
    const store = new FakeStore([activeRow({ id: 'a', provider_user_id: 'user_a', primary_email: 'keep@example.com', provider_updated_at: new Date('2026-02-01T00:00:00.000Z') })]);
    const reader = new MapReader({ user_a: snap('user_a', { providerUpdatedAt: new Date('2026-01-01T00:00:00.000Z'), primaryEmail: 'stale@example.com' }) });
    const s = await reconcileUsersWithStore(store, reader);
    expect(s.repaired).toBe(0);
    expect(s.inSync).toBe(1);
    expect(store.rows[0]?.primary_email).toBe('keep@example.com'); // newer stored state preserved
  });

  test('provider not_found is counted but NEVER deletes (non-destructive)', async () => {
    const store = new FakeStore([activeRow({ id: 'a', provider_user_id: 'gone' })]);
    const reader = new MapReader({ gone: { status: 'not_found' } });
    const s = await reconcileUsersWithStore(store, reader);
    expect(s).toEqual({ scanned: 1, inSync: 0, repaired: 0, providerMissing: 1, providerUnavailable: 0 });
    expect(store.rows[0]?.status).toBe('active'); // still active — deletion stays webhook-first
  });

  test('provider unavailable is counted and skipped (no change)', async () => {
    const store = new FakeStore([activeRow({ id: 'a', provider_user_id: 'user_a', primary_email: 'keep@example.com' })]);
    const err = { category: 'provider_unavailable', code: 'DEPENDENCY_UNAVAILABLE', message: 'x', retryable: true } as const;
    const reader = new MapReader({ user_a: { status: 'unavailable', error: err } });
    const s = await reconcileUsersWithStore(store, reader);
    expect(s.providerUnavailable).toBe(1);
    expect(store.rows[0]?.primary_email).toBe('keep@example.com');
  });

  test('keyset pagination scans every active row across batches', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => activeRow({ id: `id-${i}`, provider_user_id: `u${i}` }));
    const store = new FakeStore(rows);
    const reader = new MapReader(Object.fromEntries(rows.map((_, i) => [`u${i}`, snap(`u${i}`)])));
    const s = await reconcileUsersWithStore(store, reader, { batchSize: 2 });
    expect(s.scanned).toBe(7);
    expect(s.repaired).toBe(7);
    expect(store.listCalls).toBeGreaterThanOrEqual(4); // multiple pages
  });

  test('tombstones are never scanned (no resurrection)', async () => {
    const store = new FakeStore([activeRow({ id: 'a', provider_user_id: 'user_a', status: 'deleted', deleted_at: NOW, primary_email: null })]);
    const reader = new MapReader({ user_a: snap('user_a') });
    const s = await reconcileUsersWithStore(store, reader);
    expect(s.scanned).toBe(0);
    expect(reader.calls).toBe(0);
    expect(store.rows[0]?.status).toBe('deleted');
    expect(store.rows[0]?.primary_email).toBeNull();
  });
});
