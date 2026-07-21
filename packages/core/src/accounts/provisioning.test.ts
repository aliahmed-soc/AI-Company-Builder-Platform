// ACBP-P1-003 — unit tests for personal-account provisioning (fakes; no database).
import { describe, test, expect } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import { provisionPersonalAccountWithStore, type AccountProvisioningStore } from './provisioning.js';

function fakeStore(existing?: { id: string; plan_state: string }) {
  let account = existing;
  const calls = { accountInserts: [] as unknown[], profileInserts: [] as { account_id: string }[] };
  const store: AccountProvisioningStore = {
    insertAccountIfAbsent: (v) => {
      calls.accountInserts.push(v);
      if (account !== undefined) return Promise.resolve({ row: account, inserted: false });
      account = { id: 'acc_new', plan_state: 'free' };
      return Promise.resolve({ row: account, inserted: true });
    },
    insertProfileIfAbsent: (v) => {
      calls.profileInserts.push(v);
      return Promise.resolve({ row: { account_id: v.account_id }, inserted: true });
    },
  };
  return { store, calls };
}

describe('provisionPersonalAccountWithStore', () => {
  test('creates the account + profile and reports created=true on first provision', async () => {
    const { store, calls } = fakeStore();
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const result = await provisionPersonalAccountWithStore(store, 'usr_1', { logger });

    expect(result).toEqual({ accountId: 'acc_new', created: true });
    expect(calls.accountInserts).toEqual([{ created_by_user_id: 'usr_1' }]);
    expect(calls.profileInserts).toEqual([{ account_id: 'acc_new' }]); // profile keyed to the new account
    // account.created emitted with ONLY non-PII fields.
    const created = records.filter((r) => r.event === 'account.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata).toEqual({ accountId: 'acc_new', planState: 'free' });
  });

  test('is idempotent: an existing account yields created=false and emits no account.created', async () => {
    const { store, calls } = fakeStore({ id: 'acc_existing', plan_state: 'free' });
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const result = await provisionPersonalAccountWithStore(store, 'usr_1', { logger });

    expect(result).toEqual({ accountId: 'acc_existing', created: false });
    // Still ensures the profile exists (idempotent), but emits no creation event.
    expect(calls.profileInserts).toEqual([{ account_id: 'acc_existing' }]);
    expect(records.filter((r) => r.event === 'account.created')).toHaveLength(0);
  });

  test('works without a logger (silent, still idempotent)', async () => {
    const { store } = fakeStore();
    const result = await provisionPersonalAccountWithStore(store, 'usr_2');
    expect(result.created).toBe(true);
  });
});
