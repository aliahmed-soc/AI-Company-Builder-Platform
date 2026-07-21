// @acbp/database — per-connection tenant session settings (ACBP-P0-018; ADR-007 §2.3, §2.6).
//
// These are the "RLS-ready session settings": the second isolation layer (row-level security
// policies, added with the first tenant-owned table) keys off these per-connection GUCs. Applied
// with is_local = true, they follow SET LOCAL semantics — scoped to the current transaction and
// reverting on commit/rollback — so a pooled connection never leaks tenant scope to the next user.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { AccountContext } from '@acbp/contracts';
import type { DatabaseSchema } from './schema.js';
import type { TenantContext } from './tenant.js';

/** Custom GUC names checked by future RLS policies. Namespaced under `app.` (standard Postgres). */
export const TENANT_SETTINGS = {
  account: 'app.current_account',
  company: 'app.current_company',
  actor: 'app.current_actor',
} as const;

export interface TenantSettingStatement {
  readonly name: string;
  readonly value: string;
  /** Always true: transaction-scoped (SET LOCAL), never session-wide on a pooled connection. */
  readonly local: true;
}

/** Pure builder (unit-testable without a database) of the settings applied for a tenant. */
export function buildTenantSettings(tenant: TenantContext): readonly TenantSettingStatement[] {
  return [
    { name: TENANT_SETTINGS.account, value: tenant.accountId, local: true },
    { name: TENANT_SETTINGS.company, value: tenant.companyId, local: true },
    { name: TENANT_SETTINGS.actor, value: tenant.actorId ?? '', local: true },
  ];
}

/**
 * Apply the tenant session settings on the given transaction connection. MUST run inside a
 * transaction (is_local = true). All values are bound parameters (no SQL injection surface).
 */
export async function applyTenantSession(db: Kysely<DatabaseSchema>, tenant: TenantContext): Promise<void> {
  for (const s of buildTenantSettings(tenant)) {
    await sql`select set_config(${s.name}, ${s.value}, ${s.local})`.execute(db);
  }
}

/**
 * Pure builder (unit-testable) of the ACCOUNT-level settings (ACBP-P1-005; CDR-012 #4/#5). Emits ONLY
 * `app.current_account` and `app.current_actor` — deliberately NEVER `app.current_company`, so an
 * account-scoped transaction leaves the company GUC unset and future company-owned RLS fails closed.
 */
export function buildAccountSettings(account: AccountContext): readonly TenantSettingStatement[] {
  return [
    { name: TENANT_SETTINGS.account, value: account.accountId, local: true },
    { name: TENANT_SETTINGS.actor, value: account.actorId ?? '', local: true },
  ];
}

/**
 * Apply the ACCOUNT session settings on the given transaction connection. MUST run inside a transaction
 * (is_local = true). Sets account + actor only; never touches `app.current_company` (CDR-012 #5). All
 * values are bound parameters (no SQL injection surface).
 */
export async function applyAccountSession(db: Kysely<DatabaseSchema>, account: AccountContext): Promise<void> {
  for (const s of buildAccountSettings(account)) {
    await sql`select set_config(${s.name}, ${s.value}, ${s.local})`.execute(db);
  }
}
