// ACBP-P1-013 — platform-administrator allowlist (CDR-019; SECURITY-ARCHITECTURE §3). ADDITIVE migration —
// 0001–0010 untouched, NO SECURITY DEFINER function added (the closed allowlist stays exactly three), no
// existing table/policy changes, NO backfill, NO default admin, NO environment-derived admin.
//
// `platform_admins` is the SEPARATE platform-operator authority (tenant roles never grant it):
//   - rows are created/revoked EXCLUSIVELY through explicit owner-connection operational setup (the canonical
//     "migrations + explicit admin setup ONLY" use of the owner role — see docs/operations/admin-access-runbook);
//     there is deliberately NO application wrapper, endpoint, or runtime mutation path of any kind;
//   - the restricted `acbp_app` role gets SELECT ONLY, and FORCE RLS confines that SELECT to a SELF-CHECK:
//     a request can verify only the CURRENT ACTOR'S OWN row (`user_id = app.current_actor`) — no enumeration
//     of administrators is possible at the restricted role, and an absent/forged actor GUC fails closed.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** Restricted application role name (an object identifier, not a secret) — created in migration 0005. */
const APP_ROLE = sql.ref('acbp_app');

const CURRENT_ACTOR = sql`nullif(current_setting('app.current_actor', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('platform_admins')
    .addColumn('user_id', 'uuid', (col) => col.primaryKey())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('revoked_at', 'timestamptz')
    .addForeignKeyConstraint('platform_admins_user_fk', ['user_id'], 'users', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addCheckConstraint('platform_admins_status_valid', sql`status in ('active', 'revoked')`)
    // Status/timestamp consistency: active has no revocation instant; revoked always carries one.
    .addCheckConstraint('platform_admins_active_shape', sql`status <> 'active' or revoked_at is null`)
    .addCheckConstraint('platform_admins_revoked_shape', sql`status <> 'revoked' or revoked_at is not null`)
    .execute();

  // Least privilege: SELECT ONLY for the restricted role. No INSERT/UPDATE/DELETE/TRUNCATE — every mutation is
  // an explicit owner-connection operational action; `user_id`/`created_at` are immutable to the app role by
  // the total absence of any write privilege.
  await sql`grant select on public.platform_admins to ${APP_ROLE}`.execute(db);

  await sql`alter table public.platform_admins enable row level security`.execute(db);
  await sql`alter table public.platform_admins force row level security`.execute(db);

  // SELF-CHECK-ONLY visibility: the one policy. No other command has any policy → denied under FORCE RLS
  // regardless of grants (and the grants deny writes anyway). Fail-closed when app.current_actor is unset.
  await sql`
    create policy platform_admins_self_select on public.platform_admins for select
      using (user_id::text = ${CURRENT_ACTOR})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists platform_admins_self_select on public.platform_admins`.execute(db);
  await sql`revoke all on public.platform_admins from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('platform_admins').ifExists().execute();
}
