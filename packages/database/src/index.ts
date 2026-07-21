// @acbp/database — public API (ACBP-P0-018). PostgreSQL access + migration foundation.
// No product-domain schema or repositories: those arrive with their owning tickets.
export { createDatabase, closeDatabase, checkDatabaseHealth } from './client.js';
export type { DatabaseClient, DatabaseHealth, CreateDatabaseDeps, DbCallOptions } from './client.js';

export { withTransaction, withTenantTransaction, nestedTransactionError } from './transaction.js';
export type { TxExecutor } from './transaction.js';

export { TenantRepository } from './repository.js';
export type { TenantContext, TenantScope } from './tenant.js';

// Global identity-root repositories (ACBP-P1-002; NOT tenant-scoped — CDR-008).
export { UserMappingRepository, WebhookReceiptRepository } from './identity-repositories.js';
export type { IdentityExecutor, ProviderIdentityKey } from './identity-repositories.js';

// Account-root repositories (ACBP-P1-003; CDR-010). Not tenant-scoped yet (RLS is P1-006).
export { AccountRepository, AccountProfileRepository } from './account-repositories.js';
export type { AccountExecutor } from './account-repositories.js';

// Membership repository (ACBP-P1-004; CDR-011). Authorization role source; not tenant-scoped yet.
export { MembershipRepository } from './membership-repositories.js';
export type { MembershipExecutor } from './membership-repositories.js';

export { applyTenantSession, buildTenantSettings, TENANT_SETTINGS } from './session.js';
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
} from './schema.js';

// NOTE: createTenantScope is intentionally NOT exported — a TenantScope must originate from
// withTenantTransaction so tenant context cannot be forged (ADR-007 invariant 2).
