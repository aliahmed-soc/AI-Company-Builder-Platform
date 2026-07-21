// ACBP-P1-008 — append-only audit event store (ADR-015; CDR-014 Option A; invariant 11).
//
// One account-scoped `audit_events` table. IMMUTABILITY is enforced by PERSISTENCE CONSTRAINT, not a runtime
// guard: the restricted `acbp_app` role is granted INSERT + SELECT only (no UPDATE/DELETE/TRUNCATE grant, and
// there is no UPDATE/DELETE policy), and FORCE ROW LEVEL SECURITY confines every row to the caller's
// `app.current_account`. The migration/owner role owns the table; the migration grants BYPASSRLS to no one and
// adds NO SECURITY DEFINER function (the allowlist stays exactly three). `account_id` has NO foreign key so a
// redacted audit trace can survive account deletion (SECURITY-ARCHITECTURE deletion controls). PostgreSQL
// transactional DDL rolls the whole batch back on failure (no partial apply).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** Restricted application role name (an object identifier, not a secret) — created in migration 0005. */
const APP_ROLE = sql.ref('acbp_app');

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1) The append-only table. event_id is the server-generated ULID primary key; occurred_at is DB-set.
  await db.schema
    .createTable('audit_events')
    .addColumn('event_id', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('schema_version', 'integer', (col) => col.notNull())
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('actor_type', 'text', (col) => col.notNull())
    .addColumn('actor_id', 'uuid')
    .addColumn('subject_type', 'text', (col) => col.notNull())
    .addColumn('subject_id', 'text', (col) => col.notNull())
    .addColumn('outcome', 'text', (col) => col.notNull())
    .addColumn('correlation_id', 'text')
    .addColumn('causation_id', 'text')
    .addColumn('idempotency_key', 'text')
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('occurred_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('audit_events_actor_type_valid', sql`actor_type in ('user', 'worker', 'system', 'admin')`)
    .addCheckConstraint('audit_events_outcome_valid', sql`outcome in ('success', 'denied', 'blocked')`)
    .addCheckConstraint('audit_events_schema_version_positive', sql`schema_version >= 1`)
    .execute();

  // Account-scoped lookups (future read surface); ULID PK already gives time-ordering.
  await sql`create index audit_events_account_idx on audit_events (account_id, occurred_at)`.execute(db);
  // A producer's idempotency key identifies at most one audit row (dedupe for retried in-tx writers).
  await sql`create unique index audit_events_idempotency_key_unique on audit_events (idempotency_key) where idempotency_key is not null`.execute(db);

  // 2) Least-privilege grants: INSERT + SELECT ONLY. No UPDATE/DELETE/TRUNCATE → append-only for the app role.
  await sql`grant select, insert on public.audit_events to ${APP_ROLE}`.execute(db);

  // 3) Enable + FORCE RLS so policies apply even to the table owner (only BYPASSRLS/superusers bypass).
  await sql`alter table public.audit_events enable row level security`.execute(db);
  await sql`alter table public.audit_events force row level security`.execute(db);

  // 4) Policies — fail-closed TEXT comparison against the per-transaction account GUC (a missing/empty/
  //    malformed value yields NULL → no row visible / WITH CHECK fails, with no uuid-cast exception).
  //    INSERT binds the new row's account_id to the caller's scope (cannot write another account's audit).
  //    SELECT confines reads to the caller's own account. NO update/delete policy → those commands are denied.
  await sql`
    create policy audit_events_insert on public.audit_events for insert
      with check (account_id::text = nullif(current_setting('app.current_account', true), ''))
  `.execute(db);
  await sql`
    create policy audit_events_select on public.audit_events for select
      using (account_id::text = nullif(current_setting('app.current_account', true), ''))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists audit_events_insert on public.audit_events`.execute(db);
  await sql`drop policy if exists audit_events_select on public.audit_events`.execute(db);
  // Revoke before drop so no dependent privilege blocks it; the role itself is owned by migration 0005.
  await sql`revoke all on public.audit_events from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('audit_events').ifExists().execute();
}
