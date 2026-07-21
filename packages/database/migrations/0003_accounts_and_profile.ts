// ACBP-P1-003 — internal account creation + profile foundation (CDR-010; ADR-022; ADR-006/007).
//
// Creates the account-root `accounts` table and the 1:1 `account_profiles` table. An account is an
// A-root entity (account-owned): it carries NO `company_id` and is NOT under company row-level
// security (company RLS is ACBP-P1-006). The founding owner is recorded as an immutable, UNIQUE
// `created_by_user_id` FK → users.id (CDR-010 #2/#3): a bootstrap 1:1 personal-account link that is
// provenance only — ACBP-P1-004 backfills the owner membership and authorization derives from
// memberships thereafter. `down()` drops the profile table before `accounts` (FK order); PostgreSQL
// has transactional DDL, so a failure rolls the whole batch back (no partial apply).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Account root (A-tenant). One personal account per founding user for MVP (unique owner).
  await db.schema
    .createTable('accounts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // Immutable founding-owner link. Users are soft-deleted (never hard-deleted) in P1-002, so the FK
    // target is never physically removed; on delete is a no-op guard rather than a cascade.
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    // Plan/entitlement state (matches the account.created event payload); concrete billing is Phase 7.
    .addColumn('plan_state', 'text', (col) => col.notNull().defaultTo('free'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // 1:1 personal-account invariant + serves the "my account" owner lookup (unique index).
    .addUniqueConstraint('accounts_owner_unique', ['created_by_user_id'])
    .addForeignKeyConstraint('accounts_owner_fk', ['created_by_user_id'], 'users', ['id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    .addCheckConstraint('accounts_status_valid', sql`status in ('active', 'suspended', 'closed')`)
    .addCheckConstraint('accounts_plan_state_not_empty', sql`char_length(plan_state) > 0`)
    .execute();

  // Mutable, user-facing profile. 1:1 with the account (PK = account_id); dies with the account.
  await db.schema
    .createTable('account_profiles')
    .addColumn('account_id', 'uuid', (col) => col.primaryKey())
    .addColumn('display_name', 'text')
    .addColumn('locale', 'text', (col) => col.notNull().defaultTo('en'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('account_profiles_account_fk', ['account_id'], 'accounts', ['id'], (cb) =>
      cb.onDelete('cascade').onUpdate('no action'),
    )
    // Display name, when set, is a bounded non-empty string (app also trims); NULL = not yet set.
    .addCheckConstraint('account_profiles_display_name_len', sql`display_name is null or char_length(display_name) between 1 and 200`)
    // Lightweight BCP-47-ish guard: primary subtag (2-3 letters) + optional subtags. e.g. en, en-US, pt-BR.
    .addCheckConstraint('account_profiles_locale_format', sql`locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the profile (child) before the account (parent) — FK ordering.
  await db.schema.dropTable('account_profiles').execute();
  await db.schema.dropTable('accounts').execute();
}
