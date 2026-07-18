// @acbp/database — per-connection tenant session settings (ACBP-P0-018; ADR-007 §2.3, §2.6).
//
// These are the "RLS-ready session settings": the second isolation layer (row-level security
// policies, added with the first tenant-owned table) keys off these per-connection GUCs. Applied
// with is_local = true, they follow SET LOCAL semantics — scoped to the current transaction and
// reverting on commit/rollback — so a pooled connection never leaks tenant scope to the next user.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
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
