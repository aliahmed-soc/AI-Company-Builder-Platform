// ACBP-P1-002 — internal user mapping + webhook idempotency foundation (ADR-022 §13; CDR-007; CDR-008).
//
// Creates the global identity-root `users` table and the `identity_webhook_receipts` idempotency
// ledger. NO tenant/account/company/membership/role/permission columns (CDR-008 #1, #7). `down()`
// drops the receipt table before `users`. PostgreSQL has transactional DDL, so a failure rolls the
// whole batch back (no partial apply).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Global identity-root mapping. gen_random_uuid() is built-in on PostgreSQL 13+ (no extension).
  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('provider', 'text', (col) => col.notNull())
    .addColumn('provider_instance_id', 'text', (col) => col.notNull())
    .addColumn('provider_user_id', 'text', (col) => col.notNull())
    .addColumn('primary_email', 'text')
    .addColumn('email_verified', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('provider_created_at', 'timestamptz')
    .addColumn('provider_updated_at', 'timestamptz', (col) => col.notNull())
    .addColumn('last_event_id', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('deleted_at', 'timestamptz')
    // Mapping uniqueness = provider + instance + subject (CDR-008 #5). Also serves the identity lookup.
    .addUniqueConstraint('users_provider_identity_unique', ['provider', 'provider_instance_id', 'provider_user_id'])
    .addCheckConstraint('users_provider_not_empty', sql`char_length(provider) > 0`)
    .addCheckConstraint('users_provider_instance_not_empty', sql`char_length(provider_instance_id) > 0`)
    .addCheckConstraint('users_provider_user_id_not_empty', sql`char_length(provider_user_id) > 0`)
    .addCheckConstraint('users_status_valid', sql`status in ('active', 'deleted')`)
    // Active rows have no deleted_at; deleted rows must have one (and must redact PII per CDR-008 #3).
    .addCheckConstraint('users_active_has_no_deleted_at', sql`status <> 'active' or deleted_at is null`)
    .addCheckConstraint('users_deleted_has_deleted_at', sql`status <> 'deleted' or deleted_at is not null`)
    .addCheckConstraint('users_deleted_email_redacted', sql`status <> 'deleted' or primary_email is null`)
    .addCheckConstraint('users_deleted_not_verified', sql`status <> 'deleted' or email_verified = false`)
    .execute();

  // Idempotency ledger of SUCCESSFULLY processed webhooks (CDR-008 #13). No raw payload / PII.
  await db.schema
    .createTable('identity_webhook_receipts')
    .addColumn('provider', 'text', (col) => col.notNull())
    .addColumn('provider_instance_id', 'text', (col) => col.notNull())
    .addColumn('event_id', 'text', (col) => col.notNull())
    .addColumn('event_type', 'text', (col) => col.notNull())
    .addColumn('occurred_at', 'timestamptz', (col) => col.notNull())
    .addColumn('ordering_timestamp', 'timestamptz', (col) => col.notNull())
    .addColumn('payload_sha256', 'text', (col) => col.notNull())
    .addColumn('processed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('identity_webhook_receipts_pkey', ['provider', 'provider_instance_id', 'event_id'])
    .addCheckConstraint('receipts_provider_not_empty', sql`char_length(provider) > 0`)
    .addCheckConstraint('receipts_provider_instance_not_empty', sql`char_length(provider_instance_id) > 0`)
    .addCheckConstraint('receipts_event_id_not_empty', sql`char_length(event_id) > 0`)
    .addCheckConstraint('receipts_event_type_not_empty', sql`char_length(event_type) > 0`)
    // Exactly a lowercase 64-hex SHA-256 digest — never the raw payload.
    .addCheckConstraint('receipts_payload_sha256_format', sql`payload_sha256 ~ '^[0-9a-f]{64}$'`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the receipt ledger before the users table (CDR-008 / task ordering).
  await db.schema.dropTable('identity_webhook_receipts').execute();
  await db.schema.dropTable('users').execute();
}
