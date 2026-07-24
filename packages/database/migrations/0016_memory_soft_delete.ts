// ACBP-P2-010 — memory SOFT DELETE (CDR-025 §0, owner-ratified decision). ADDITIVE migration — migrations
// 0001–0015 are untouched (0015 stays hosted-green evidence for versioned edit), NO SECURITY DEFINER is added,
// no new role, no hard-delete grant, no backfill, no default deleted state.
//
// Adds two nullable columns to `memory_items` — `deleted_at` + `deleted_by_user_id` (FK to users) — plus:
//   - a PAIR check: both null (live) or both non-null (deleted) — no half-deleted state;
//   - a MUTUAL-EXCLUSION check: a row is never both superseded AND deleted (the derived lifecycle is exactly one
//     of active / superseded / deleted);
//   - a NARROW additive column-level UPDATE grant for `acbp_app` on exactly `(deleted_at, deleted_by_user_id)`
//     (adding to the 0015 `superseded_by` grant). content/type/source/confidence/confirmation/identity/creation
//     columns stay IMMUTABLE to the app role.
//
// The existing dual-keyed FORCE-RLS UPDATE policy (migration 0015) governs this UPDATE too — no new policy.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('memory_items')
    .addColumn('deleted_at', 'timestamptz')
    .addColumn('deleted_by_user_id', 'uuid')
    .execute();
  // Both null (live) or both non-null (deleted) — never a half-deleted row.
  await sql`alter table public.memory_items add constraint memory_items_delete_pair check ((deleted_at is null) = (deleted_by_user_id is null))`.execute(db);
  // A row is never both superseded and deleted (lifecycle is exactly one of active/superseded/deleted).
  await sql`alter table public.memory_items add constraint memory_items_not_super_and_deleted check (not (superseded_by is not null and deleted_at is not null))`.execute(db);
  await sql`alter table public.memory_items add constraint memory_items_deleted_author_fk foreign key (deleted_by_user_id) references public.users (id) on delete no action on update no action`.execute(db);
  // The narrow additive column-level UPDATE grant (only the two delete columns; identity/content stay immutable).
  await sql`grant update (deleted_at, deleted_by_user_id) on public.memory_items to ${APP_ROLE}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`revoke update (deleted_at, deleted_by_user_id) on public.memory_items from ${APP_ROLE}`.execute(db);
  await sql`alter table public.memory_items drop constraint if exists memory_items_deleted_author_fk`.execute(db);
  await sql`alter table public.memory_items drop constraint if exists memory_items_not_super_and_deleted`.execute(db);
  await sql`alter table public.memory_items drop constraint if exists memory_items_delete_pair`.execute(db);
  await db.schema.alterTable('memory_items').dropColumn('deleted_by_user_id').dropColumn('deleted_at').execute();
}
