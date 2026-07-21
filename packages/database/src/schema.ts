// @acbp/database — Kysely database schema types.
//
// Foundation (ACBP-P0-018) started this empty; ACBP-P1-002 introduces the first product-domain
// tables: the global identity-root `users` mapping and the `identity_webhook_receipts` idempotency
// ledger (see docs/decisions/ADR-022 §13, CDR-007, CDR-008). Kysely is generic over this interface,
// so a query can only reference a table once its type is registered here.
//
// SCOPE (CDR-008): users only. NO tenant_id/account_id/company/membership/role/permission/display-name
// columns — account membership and authorization are ACBP-P1-004.
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** timestamptz, required (no DB default) — must be supplied on insert/update. */
type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>;
/** timestamptz, nullable, no default. */
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;

/**
 * Global identity-root mapping: external provider identity → internal immutable user id.
 * Not tenant-scoped (CDR-008 #1). Uniqueness is (provider, provider_instance_id, provider_user_id).
 * `provider_updated_at` is the ordering guard for last-provider-write-wins convergence (CDR-007 (d)).
 */
export interface UsersTable {
  /** Internal immutable user id (uuid, default gen_random_uuid()). Never derived from the provider. */
  id: Generated<string>;
  /** Identity provider discriminator (e.g. 'clerk'). Non-empty. */
  provider: string;
  /** Provider instance/tenant id (Clerk envelope `instance_id`). Non-empty — isolates instances. */
  provider_instance_id: string;
  /** Opaque provider subject/user id. Non-empty. Not a product identity or authorization grant. */
  provider_user_id: string;
  /** Normalized primary email (PII). Null when unknown or after soft-deletion redaction. Not unique. */
  primary_email: string | null;
  /** Authoritative primary-email verification state. Default false. */
  email_verified: Generated<boolean>;
  /** Lifecycle: 'active' | 'deleted'. Default 'active'. */
  status: Generated<string>;
  /** Provider-reported creation time (informational). */
  provider_created_at: NullableTimestamp;
  /** Provider-reported last-update time — the convergence ordering guard. Required. */
  provider_updated_at: RequiredTimestamp;
  /** Last applied provider webhook event id (diagnostics only). */
  last_event_id: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  /** Set when soft-deleted; null while active. */
  deleted_at: NullableTimestamp;
}

/**
 * Durable idempotency ledger of SUCCESSFULLY processed identity webhooks (CDR-008 #13). Written in
 * the SAME transaction as the user mutation; a failed mutation rolls this back. No raw payload, no
 * PII, no failure/attempt bookkeeping. PK = (provider, provider_instance_id, event_id).
 */
export interface IdentityWebhookReceiptsTable {
  provider: string;
  provider_instance_id: string;
  /** Provider event/message id (dedupe key). Non-empty. */
  event_id: string;
  event_type: string;
  /** Provider event envelope timestamp. */
  occurred_at: RequiredTimestamp;
  /** Ordering timestamp used for last-write-wins (provider updated_at, or envelope time for deletes). */
  ordering_timestamp: RequiredTimestamp;
  /** Lowercase 64-char hex SHA-256 of the raw verified payload (the payload itself is never stored). */
  payload_sha256: string;
  processed_at: Generated<Date>;
}

/**
 * Account root (ACBP-P1-003; CDR-010). An A-tenant entity: NO `company_id`, no company RLS (that is
 * ACBP-P1-006). `created_by_user_id` is the immutable, UNIQUE founding-owner link (bootstrap 1:1
 * personal account) — provenance only, never an authorization source; ACBP-P1-004 layers the
 * membership/role model on top. Lifecycle status: 'active' | 'suspended' | 'closed'.
 */
export interface AccountsTable {
  /** Internal immutable account id (uuid, default gen_random_uuid()). */
  id: Generated<string>;
  /** Immutable founding-owner user id (FK → users.id), unique (one personal account per user). */
  created_by_user_id: string;
  /** Lifecycle: 'active' | 'suspended' | 'closed'. Default 'active'. */
  status: Generated<string>;
  /** Plan/entitlement state (matches the account.created event payload). Non-empty. Default 'free'. */
  plan_state: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

/**
 * Mutable, user-facing account profile (ACBP-P1-003; CDR-010 #5). 1:1 with an account (PK =
 * account_id, ON DELETE CASCADE). Email is NOT here — it stays Clerk-authoritative on `users`
 * (read-only in the platform profile). Fields grow here without churning the account root.
 */
export interface AccountProfilesTable {
  /** Owning account id (PK + FK → accounts.id, cascade). */
  account_id: string;
  /** Optional display name; when set, a bounded non-empty string. NULL = not yet set. */
  display_name: string | null;
  /** UI locale (BCP-47-ish, e.g. 'en', 'en-US'). Default 'en'. */
  locale: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DatabaseSchema {
  users: UsersTable;
  identity_webhook_receipts: IdentityWebhookReceiptsTable;
  accounts: AccountsTable;
  account_profiles: AccountProfilesTable;
}

// Repository-facing row shapes.
export type UserRow = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type IdentityWebhookReceiptRow = Selectable<IdentityWebhookReceiptsTable>;
export type NewIdentityWebhookReceipt = Insertable<IdentityWebhookReceiptsTable>;
export type AccountRow = Selectable<AccountsTable>;
export type NewAccount = Insertable<AccountsTable>;
export type AccountUpdate = Updateable<AccountsTable>;
export type AccountProfileRow = Selectable<AccountProfilesTable>;
export type NewAccountProfile = Insertable<AccountProfilesTable>;
export type AccountProfileUpdate = Updateable<AccountProfilesTable>;
