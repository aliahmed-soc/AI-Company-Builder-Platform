// @acbp/database — public API (ACBP-P0-018). PostgreSQL access + migration foundation.
// No product-domain schema or repositories: those arrive with their owning tickets.
export { createDatabase, closeDatabase, checkDatabaseHealth } from './client.js';
export type { DatabaseClient, DatabaseHealth, CreateDatabaseDeps, DbCallOptions } from './client.js';

export { withTransaction, withTenantTransaction, withAccountTransaction, nestedTransactionError } from './transaction.js';
export type { TxExecutor } from './transaction.js';

export { TenantRepository, AccountScopedRepository } from './repository.js';
export type { TenantContext, TenantScope } from './tenant.js';
// Account-level tenancy primitive (ACBP-P1-005; CDR-012). AccountContext is re-exported from @acbp/contracts
// (the neutral currency). createAccountScope is intentionally NOT exported — an AccountScope must originate
// from withAccountTransaction so account context cannot be forged (CDR-012 #2).
export type { AccountScope, AccountContext } from './account-tenant.js';

// Global identity-root repositories (ACBP-P1-002; NOT tenant-scoped — CDR-008).
export { UserMappingRepository, WebhookReceiptRepository } from './identity-repositories.js';
export type { IdentityExecutor, ProviderIdentityKey } from './identity-repositories.js';

// Account-root repositories (ACBP-P1-003; CDR-010). Not tenant-scoped yet (RLS is P1-006).
export { AccountRepository, AccountProfileRepository } from './account-repositories.js';
export type { AccountExecutor } from './account-repositories.js';

// Membership repository (ACBP-P1-004; CDR-011). Authorization role source; not tenant-scoped yet.
export { MembershipRepository } from './membership-repositories.js';
export type { MembershipExecutor } from './membership-repositories.js';

// Append-only audit writer (ACBP-P1-008; ADR-015; CDR-014). Writes under the caller's AccountScope in-tx.
export { writeAuditEvent } from './audit-repository.js';
export type { AuditWriteContext } from './audit-repository.js';

// SECURITY DEFINER bootstrap function callers (ACBP-P1-006; CDR-013). The only RLS-boundary crossings.
export { provisionAccountBootstrap, resolveOwnMembershipBootstrap, acceptInviteBootstrap } from './bootstrap-functions.js';
export type { BootstrapExecutor } from './bootstrap-functions.js';

export { applyTenantSession, buildTenantSettings, applyAccountSession, buildAccountSettings, TENANT_SETTINGS } from './session.js';
export type { TenantSettingStatement } from './session.js';

export { toDatabaseError } from './errors.js';
export { toPoolConfig } from './pool.js';

export { createMigrator, createFileMigrationProvider, migrateToLatest, migrateDown, migrationStatus, MIGRATIONS_DIR } from './migrator.js';

export type {
  DatabaseSchema,
  UsersTable,
  IdentityWebhookReceiptsTable,
  UserRow,
  NewUser,
  UserUpdate,
  IdentityWebhookReceiptRow,
  NewIdentityWebhookReceipt,
  AccountsTable,
  AccountProfilesTable,
  AccountRow,
  NewAccount,
  AccountUpdate,
  AccountProfileRow,
  NewAccountProfile,
  AccountProfileUpdate,
  MembershipsTable,
  MembershipRow,
  NewMembership,
  MembershipUpdate,
  AuditEventsTable,
  AuditEventRow,
  NewAuditEvent,
} from './schema.js';

// NOTE: createTenantScope is intentionally NOT exported — a TenantScope must originate from
// withTenantTransaction so tenant context cannot be forged (ADR-007 invariant 2).
