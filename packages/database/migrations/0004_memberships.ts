// ACBP-P1-004 — membership + roles foundation (CDR-011; ADR-022/007/006; ADMIN-003).
//
// Creates the account-owned `memberships` table (owner/viewer roles; invited→active→revoked) and
// backfills a role='owner', status='active' membership for every existing account's founding user
// (accounts.created_by_user_id, CDR-010 → CDR-011 #3). `company_id` is a NULLABLE structural hook with
// NO foreign key yet — the companies FK + company-scoped invites land in ACBP-P1-010 (companies come
// after membership in the dependency graph). Authorization derives from the membership row, never from a
// Clerk claim or from created_by_user_id itself. `down()` drops the table. PostgreSQL transactional DDL
// rolls the whole batch back on failure (no partial apply).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('memberships')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    // Null while an invite is pending; bound to the accepting internal user on accept.
    .addColumn('member_user_id', 'uuid')
    .addColumn('role', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('invited'))
    // Invite target email (PII) + single-use token HASH (never the raw token). Null for the backfilled owner.
    .addColumn('invited_email', 'text')
    .addColumn('invite_token_hash', 'text')
    .addColumn('invited_by_user_id', 'uuid')
    // Structural company-scope hook: NULLABLE, NO FK yet (there is no companies table until P1-010).
    .addColumn('company_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('accepted_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addForeignKeyConstraint('memberships_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // Users are soft-deleted (never hard-deleted), so no cascade is needed on the user FKs.
    .addForeignKeyConstraint('memberships_member_user_fk', ['member_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addForeignKeyConstraint('memberships_invited_by_fk', ['invited_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('memberships_role_valid', sql`role in ('owner', 'viewer')`)
    .addCheckConstraint('memberships_status_valid', sql`status in ('invited', 'active', 'revoked')`)
    // An active membership must be bound to a user.
    .addCheckConstraint('memberships_active_has_user', sql`status <> 'active' or member_user_id is not null`)
    // A pending invite must carry an email + token hash and NOT yet be bound to a user.
    .addCheckConstraint('memberships_invited_shape', sql`status <> 'invited' or (invited_email is not null and invite_token_hash is not null and member_user_id is null)`)
    // A token hash may exist ONLY on a pending invite (consumed/cleared on accept or revoke).
    .addCheckConstraint('memberships_token_only_when_invited', sql`status = 'invited' or invite_token_hash is null`)
    // A revoked membership records when it was revoked.
    .addCheckConstraint('memberships_revoked_has_ts', sql`status <> 'revoked' or revoked_at is not null`)
    .execute();

  // At most one ACTIVE membership per (account, user). Company scoping (P1-010) will extend this key.
  await sql`create unique index memberships_active_user_unique on memberships (account_id, member_user_id) where status = 'active'`.execute(db);
  // At most one OUTSTANDING invite per (account, invited_email).
  await sql`create unique index memberships_pending_invite_unique on memberships (account_id, invited_email) where status = 'invited'`.execute(db);
  // A token hash identifies exactly one invite.
  await sql`create unique index memberships_token_hash_unique on memberships (invite_token_hash) where invite_token_hash is not null`.execute(db);
  // Lookup helpers.
  await sql`create index memberships_account_idx on memberships (account_id)`.execute(db);
  await sql`create index memberships_member_user_idx on memberships (member_user_id) where member_user_id is not null`.execute(db);

  // Owner backfill: one active owner membership per existing account (idempotent; new accounts get theirs
  // from application provisioning). Guarded by the active-user partial unique index.
  await sql`
    insert into memberships (account_id, member_user_id, role, status, accepted_at)
    select a.id, a.created_by_user_id, 'owner', 'active', now()
    from accounts a
    on conflict (account_id, member_user_id) where status = 'active' do nothing
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('memberships').execute();
}
