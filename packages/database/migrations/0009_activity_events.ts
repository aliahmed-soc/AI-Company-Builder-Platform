// ACBP-P1-009 — company activity feed projection (CDR-016; ADR-015; diagram 11; DATA-ARCHITECTURE Activity event).
//
// A separate, append-only, company-scoped `activity_events` table: the tenant-facing PROJECTION of the durable
// `audit_events` store. It is written SYNCHRONOUSLY in the SAME transaction as the company lifecycle mutation +
// audit write (under the caller's CompanyScope on the restricted `acbp_app` role) — no outbox, no async projector,
// no worker, no owner connection, and NO SECURITY DEFINER function (the allowlist stays exactly three).
//
// `event_id` is the PRIMARY KEY and equals the SOURCE audit event id (ULID), so the projection is idempotent
// (a retried projection of the same audit event conflicts, never duplicates), traceable to its authoritative audit
// row, and rebuildable from `audit_events`. `audit_events` remains the source of record; this table carries only
// REDACTED display fields (no correlation/causation/idempotency ids, no account-level events). `account_id`/
// `company_id` have NO foreign key so a redacted trace can survive account/company deletion (like audit).
//
// Immutability by PERSISTENCE CONSTRAINT: `acbp_app` is granted INSERT + SELECT only (no UPDATE/DELETE/TRUNCATE
// grant, no UPDATE/DELETE policy). FORCE ROW LEVEL SECURITY dual-keys every row to BOTH `app.current_account` and
// `app.current_company` (fail-closed text comparison). PostgreSQL transactional DDL rolls the whole batch back on
// failure (no partial apply).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** Restricted application role name (an object identifier, not a secret) — created in migration 0005. */
const APP_ROLE = sql.ref('acbp_app');

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1) The append-only projection table. event_id = the source audit event id (idempotency + traceability).
  await db.schema
    .createTable('activity_events')
    .addColumn('event_id', 'text', (col) => col.primaryKey())
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('activity_type', 'text', (col) => col.notNull())
    .addColumn('schema_version', 'integer', (col) => col.notNull())
    .addColumn('occurred_at', 'timestamptz', (col) => col.notNull())
    .addColumn('actor_type', 'text', (col) => col.notNull())
    .addColumn('actor_id', 'uuid')
    .addColumn('subject_type', 'text', (col) => col.notNull())
    .addColumn('subject_id', 'text', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('projected_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // Only the four durable company events are ever projected (CDR-016 taxonomy — company events only).
    .addCheckConstraint('activity_events_type_valid', sql`activity_type in ('company.created', 'company.updated', 'company.paused', 'company.resumed')`)
    .addCheckConstraint('activity_events_actor_type_valid', sql`actor_type in ('user', 'worker', 'system', 'admin')`)
    .addCheckConstraint('activity_events_schema_version_positive', sql`schema_version >= 1`)
    .execute();

  // 2) Keyset index for the feed's `occurred_at DESC, event_id DESC` pagination, scoped by company.
  await sql`create index activity_events_feed_idx on public.activity_events (company_id, occurred_at desc, event_id desc)`.execute(db);

  // 3) HISTORICAL BACKFILL (CDR-016): deterministically project the EXISTING durable company audit events into
  //    the feed, exactly as the runtime projector would (audit stays authoritative; this is the rebuild mapping
  //    expressed in SQL). Runs BEFORE RLS is enabled, on the migration/owner connection.
  //     - eligible rows ONLY: company_id IS NOT NULL and name in the four-company-event taxonomy — account
  //       events (membership.*, company_id NULL), Logger-only names, and unknown/future company events are
  //       excluded structurally by this predicate;
  //     - event_id preserved (projection identity = the source audit id);
  //     - occurred_at preserved on the projection's documented MILLISECOND grid (date_trunc — the runtime
  //       projector round-trips through a JS Date with the same effect, so live == backfill == rebuild and the
  //       cursor's millisecond timestamps compare exactly);
  //     - actor_type/actor_id/account_id/company_id/subject copied as server evidence;
  //     - payload REDACTED to the per-type allowlist (creation_mode / changed_fields; paused/resumed → {});
  //       correlation/causation/idempotency ids and any other metadata are NEVER copied;
  //     - schema_version copied; state is implicitly 'executed' (the whole taxonomy);
  //     - ON CONFLICT (event_id) DO NOTHING → a rerun of this backfill is idempotent (no duplicates).
  await sql`
    insert into public.activity_events
      (event_id, account_id, company_id, activity_type, schema_version, occurred_at, actor_type, actor_id, subject_type, subject_id, payload)
    select
      ae.event_id,
      ae.account_id,
      ae.company_id,
      ae.name,
      ae.schema_version,
      date_trunc('milliseconds', ae.occurred_at),
      ae.actor_type,
      ae.actor_id,
      ae.subject_type,
      ae.subject_id,
      case ae.name
        when 'company.created' then jsonb_strip_nulls(jsonb_build_object('creation_mode', ae.payload->'creation_mode'))
        when 'company.updated' then jsonb_strip_nulls(jsonb_build_object('changed_fields', ae.payload->'changed_fields'))
        else '{}'::jsonb
      end
    from public.audit_events ae
    where ae.company_id is not null
      and ae.name in ('company.created', 'company.updated', 'company.paused', 'company.resumed')
    on conflict (event_id) do nothing
  `.execute(db);

  // 4) Least-privilege grants: INSERT + SELECT ONLY (append-only projection — no UPDATE/DELETE/TRUNCATE).
  await sql`grant select, insert on public.activity_events to ${APP_ROLE}`.execute(db);

  // 5) Enable + FORCE RLS (applies to the owner too; only BYPASSRLS/superusers bypass).
  await sql`alter table public.activity_events enable row level security`.execute(db);
  await sql`alter table public.activity_events force row level security`.execute(db);

  // 6) Dual-keyed policies (fail-closed text comparison against BOTH transaction-local GUCs). INSERT binds the row
  //    to the caller's account+company (cannot project into another tenant); SELECT confines reads the same way.
  //    NO update/delete policy → those commands are denied for the restricted role.
  await sql`
    create policy activity_events_insert on public.activity_events for insert
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy activity_events_select on public.activity_events for select
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists activity_events_insert on public.activity_events`.execute(db);
  await sql`drop policy if exists activity_events_select on public.activity_events`.execute(db);
  await sql`revoke all on public.activity_events from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('activity_events').ifExists().execute();
}
