// ACBP-P1-002 Slice 3 — resolve-or-reconcile unit tests with in-memory fakes (no database, no Clerk).
// Proves the fast-path (no provider call), the miss → read → converge path, race convergence, and the
// no-resurrection rule deterministically. Fake identities only.
import { describe, test, expect } from 'vitest';
import type { ProviderIdentityKey, UserRow, NewUser } from '@acbp/database';
import type { AuthoritativeIdentityReader, AuthoritativeIdentityResult, AuthoritativeIdentitySnapshot } from '@acbp/contracts';
import { reconcileWithStore, type ReadThroughUserStore } from './read-through.js';

const k = (key: ProviderIdentityKey): string => `${key.provider}|${key.providerInstanceId}|${key.providerUserId}`;
const KEY: ProviderIdentityKey = { provider: 'clerk', providerInstanceId: 'ins_1', providerUserId: 'user_1' };
const NOW = new Date('2026-01-01T00:00:00.000Z');

function rowFrom(values: NewUser, id: string): UserRow {
  return {
    id,
    provider: values.provider,
    provider_instance_id: values.provider_instance_id,
    provider_user_id: values.provider_user_id,
    primary_email: values.primary_email ?? null,
    email_verified: values.email_verified ?? false,
    status: values.status ?? 'active',
    provider_created_at: (values.provider_created_at as Date | null) ?? null,
    provider_updated_at: values.provider_updated_at as Date,
    last_event_id: values.last_event_id ?? null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: (values.deleted_at as Date | null) ?? null,
  };
}

class FakeStore implements ReadThroughUserStore {
  readonly rows = new Map<string, UserRow>();
  #seq = 0;
  insertCalls = 0;
  /** When set, insertIfAbsent returns this row with inserted=false (simulates a concurrent writer). */
  raceRow: UserRow | undefined = undefined;
  insertThrow: Error | undefined = undefined;

  seed(row: UserRow): void {
    this.rows.set(k({ provider: row.provider, providerInstanceId: row.provider_instance_id, providerUserId: row.provider_user_id }), row);
  }
  findByProviderIdentity(key: ProviderIdentityKey): Promise<UserRow | undefined> {
    return Promise.resolve(this.rows.get(k(key)));
  }
  insertIfAbsent(values: NewUser): Promise<{ row: UserRow; inserted: boolean }> {
    this.insertCalls += 1;
    if (this.insertThrow) return Promise.reject(this.insertThrow);
    if (this.raceRow !== undefined) return Promise.resolve({ row: this.raceRow, inserted: false });
    const key: ProviderIdentityKey = { provider: values.provider, providerInstanceId: values.provider_instance_id, providerUserId: values.provider_user_id };
    const existing = this.rows.get(k(key));
    if (existing !== undefined) return Promise.resolve({ row: existing, inserted: false });
    const row = rowFrom(values, `user-row-${(this.#seq += 1)}`);
    this.rows.set(k(key), row);
    return Promise.resolve({ row, inserted: true });
  }
}

class FakeReader implements AuthoritativeIdentityReader {
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
    providerInstanceId: 'ins_1',
    providerUserId: 'user_1',
    primaryEmail: 'user@example.com',
    emailVerified: true,
    providerCreatedAt: new Date('2025-12-01T00:00:00.000Z'),
    providerUpdatedAt: new Date('2026-01-01T12:00:00.000Z'),
    ...over,
  };
}
const activeRow = (over: Partial<UserRow> = {}): UserRow =>
  rowFrom({ provider: 'clerk', provider_instance_id: 'ins_1', provider_user_id: 'user_1', provider_updated_at: NOW, last_event_id: null, ...over }, over.id ?? 'existing-1');

describe('reconcileWithStore — fast path (no provider call)', () => {
  test('an existing active mapping resolves without reading the provider', async () => {
    const store = new FakeStore();
    store.seed(activeRow({ id: 'internal-42' }));
    const reader = new FakeReader({ status: 'not_found' });
    await expect(reconcileWithStore(store, reader, KEY)).resolves.toEqual({ status: 'active', userId: 'internal-42' });
    expect(reader.calls).toBe(0);
    expect(store.insertCalls).toBe(0);
  });

  test('an existing deleted mapping resolves as deleted without reading the provider', async () => {
    const store = new FakeStore();
    store.seed(activeRow({ id: 'internal-42', status: 'deleted', deleted_at: NOW, primary_email: null }));
    const reader = new FakeReader({ status: 'found', snapshot: snapshot() });
    await expect(reconcileWithStore(store, reader, KEY)).resolves.toEqual({ status: 'deleted' });
    expect(reader.calls).toBe(0);
  });
});

describe('reconcileWithStore — miss → authoritative read', () => {
  test('provider found → inserts one active mapping and returns it; snapshot stored verbatim', async () => {
    const store = new FakeStore();
    const reader = new FakeReader({ status: 'found', snapshot: snapshot({ primaryEmail: 'stored@example.com', emailVerified: true }) });
    const result = await reconcileWithStore(store, reader, KEY);
    expect(result.status).toBe('active');
    expect(reader.calls).toBe(1);
    const row = store.rows.get(k(KEY));
    expect(row?.status).toBe('active');
    expect(row?.primary_email).toBe('stored@example.com'); // core does NOT normalize; stores neutral value
    expect(row?.last_event_id).toBeNull(); // read-through never sets a webhook tie-break value
  });

  test('provider not_found → creates nothing', async () => {
    const store = new FakeStore();
    const reader = new FakeReader({ status: 'not_found' });
    await expect(reconcileWithStore(store, reader, KEY)).resolves.toEqual({ status: 'not_found' });
    expect(store.insertCalls).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  test('provider unavailable → bounded unavailable result, creates nothing', async () => {
    const store = new FakeStore();
    const error = { category: 'provider_unavailable', code: 'DEPENDENCY_UNAVAILABLE', message: 'x', retryable: true } as const;
    const reader = new FakeReader({ status: 'unavailable', error });
    const result = await reconcileWithStore(store, reader, KEY);
    expect(result).toEqual({ status: 'unavailable', error });
    expect(store.insertCalls).toBe(0);
  });
});

describe('reconcileWithStore — races + no resurrection', () => {
  test('two concurrent reconciliations converge to one row and the same internal id', async () => {
    const store = new FakeStore();
    const reader = new FakeReader({ status: 'found', snapshot: snapshot() });
    const [a, b] = await Promise.all([reconcileWithStore(store, reader, KEY), reconcileWithStore(store, reader, KEY)]);
    expect(store.rows.size).toBe(1);
    expect(a.status).toBe('active');
    expect(b.status).toBe('active');
    expect(a.status === 'active' && b.status === 'active' && a.userId === b.userId).toBe(true);
  });

  test('a webhook tombstone that races in (conflict returns a deleted row) is NOT resurrected', async () => {
    const store = new FakeStore();
    // find() misses, but the convergent insert loses the race to a concurrent delete → tombstone returned.
    store.raceRow = activeRow({ id: 'internal-tomb', status: 'deleted', deleted_at: NOW, primary_email: null });
    const reader = new FakeReader({ status: 'found', snapshot: snapshot() });
    await expect(reconcileWithStore(store, reader, KEY)).resolves.toEqual({ status: 'deleted' });
  });
});
