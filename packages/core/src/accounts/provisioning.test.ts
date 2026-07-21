// ACBP-P1-003 / ACBP-P1-006 — unit tests for the personal-account provisioning audit orchestration
// (fakes; no database). The account/profile/owner-membership creation itself now lives in the
// `acbp_provision_account` SECURITY DEFINER function (CDR-013) and is covered by the real-PG bootstrap
// suite; here we prove the `account.created` event is emitted (with only non-PII fields) exactly when a
// new account was created.
import { describe, test, expect } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import { provisionPersonalAccountWithStore, type AccountProvisioningStore } from './provisioning.js';

function fakeStore(result: { accountId: string; created: boolean }) {
  const calls: string[] = [];
  const store: AccountProvisioningStore = {
    provision: (userId) => {
      calls.push(userId);
      return Promise.resolve(result);
    },
  };
  return { store, calls };
}

describe('provisionPersonalAccountWithStore', () => {
  test('reports created=true and emits account.created (non-PII only) on first provision', async () => {
    const { store, calls } = fakeStore({ accountId: 'acc_new', created: true });
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const result = await provisionPersonalAccountWithStore(store, 'usr_1', { logger });

    expect(result).toEqual({ accountId: 'acc_new', created: true });
    expect(calls).toEqual(['usr_1']);
    const created = records.filter((r) => r.event === 'account.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata).toEqual({ accountId: 'acc_new', planState: 'free' });
  });

  test('is idempotent: an existing account yields created=false and emits no account.created', async () => {
    const { store } = fakeStore({ accountId: 'acc_existing', created: false });
    const { logger, records } = createTestLogger({ component: 'accounts' });
    const result = await provisionPersonalAccountWithStore(store, 'usr_1', { logger });

    expect(result).toEqual({ accountId: 'acc_existing', created: false });
    expect(records.filter((r) => r.event === 'account.created')).toHaveLength(0);
  });

  test('works without a logger (silent, still returns the result)', async () => {
    const { store } = fakeStore({ accountId: 'acc_new', created: true });
    const result = await provisionPersonalAccountWithStore(store, 'usr_2');
    expect(result.created).toBe(true);
  });
});
