// ACBP-P0-018 — tenant session-setting plumbing (unit). The live SET LOCAL behavior (current_setting
// reflects the values inside a transaction) is verified in the PostgreSQL integration suite.
import { describe, test, expect } from 'vitest';
import { buildTenantSettings, TENANT_SETTINGS, type TenantContext } from './index.js';

describe('buildTenantSettings', () => {
  test('produces transaction-local settings for account, company, and actor', () => {
    const tenant: TenantContext = { accountId: 'acc_1', companyId: 'co_1', actorId: 'usr_1' };
    const settings = buildTenantSettings(tenant);
    expect(settings).toEqual([
      { name: TENANT_SETTINGS.account, value: 'acc_1', local: true },
      { name: TENANT_SETTINGS.company, value: 'co_1', local: true },
      { name: TENANT_SETTINGS.actor, value: 'usr_1', local: true },
    ]);
  });

  test('actor defaults to empty string when absent; all settings are transaction-local', () => {
    const settings = buildTenantSettings({ accountId: 'a', companyId: 'c' });
    expect(settings.every((s) => s.local === true)).toBe(true);
    expect(settings.find((s) => s.name === TENANT_SETTINGS.actor)?.value).toBe('');
  });

  test('setting names are namespaced under app.* (standard Postgres GUC)', () => {
    expect(TENANT_SETTINGS.account).toBe('app.current_account');
    expect(TENANT_SETTINGS.company).toBe('app.current_company');
    expect(TENANT_SETTINGS.actor).toBe('app.current_actor');
  });
});
