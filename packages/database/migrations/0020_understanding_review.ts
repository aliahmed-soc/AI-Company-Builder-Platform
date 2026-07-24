// ACBP-P2-009 — understanding review + confirmation persistence (CDR-030 §5; UNDER-003/004, DISC-008; WORKFLOW §2).
// ADDITIVE migration — migrations 0001–0019 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no existing table/policy change.
//
// Two company-owned, dual-keyed, APPEND-ONLY tables (the `understanding_documents` 0019 pattern). Because 0019's
// `understanding_documents`/`understanding_items` are IMMUTABLE, review + confirmation are modeled as separate
// append-only event logs (never an UPDATE of the reviewed content — CDR-030 §1):
//   - `understanding_item_reviews` — one row per owner review decision on an item. `decision` is the CLOSED 5-value
//     control set (approve/edit/reject/request-evidence/request-research); `note` (nullable, bounded) carries the
//     edited text / reject reason / request note. The item's effective review state is its LATEST row. SELECT+INSERT.
//   - `understanding_confirmation_events` — the per-version confirm/correct lifecycle. `kind` is the CLOSED 2-value
//     set (`confirmed` | `corrected`); UNIQUE `(document_id, kind)` makes confirm idempotent and allows one
//     correction per version. A version is CONFIRMED-and-active IFF it has a `confirmed` and no `corrected` event
//     (the strategy-unlock gate). `correction_ref` + `dependents_flagged` are set ONLY for `corrected` (DISC-008).
//     SELECT+INSERT.
//
// FORCE RLS, dual-keyed fail-closed policies (cross-company reads/writes impossible — UNDER trust-critical). No
// backfill. No UPDATE/DELETE grant (append-only; supersession is a new event row, never destructive overwrite).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── understanding_item_reviews (append-only per-item review decisions) ────────────────────────────────
  await db.schema
    .createTable('understanding_item_reviews')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('document_id', 'uuid', (col) => col.notNull())
    .addColumn('item_id', 'uuid', (col) => col.notNull())
    .addColumn('decision', 'text', (col) => col.notNull())
    .addColumn('note', 'text')
    .addColumn('decided_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('understanding_item_reviews_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_item_reviews_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_item_reviews_document_fk', ['document_id'], 'understanding_documents', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_item_reviews_item_fk', ['item_id'], 'understanding_items', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_item_reviews_actor_fk', ['decided_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('understanding_item_reviews_decision_valid', sql`decision in ('approved', 'edited', 'rejected', 'evidence_requested', 'research_requested')`)
    .addCheckConstraint('understanding_item_reviews_note_len', sql`note is null or char_length(note) between 1 and 10000`)
    .execute();
  await sql`create index understanding_item_reviews_item_idx on public.understanding_item_reviews (item_id, id)`.execute(db);
  await sql`create index understanding_item_reviews_document_idx on public.understanding_item_reviews (document_id, id)`.execute(db);

  // ── understanding_confirmation_events (per-version confirm/correct lifecycle) ─────────────────────────
  await db.schema
    .createTable('understanding_confirmation_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('document_id', 'uuid', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('actor_user_id', 'uuid', (col) => col.notNull())
    .addColumn('correction_ref', 'text')
    .addColumn('dependents_flagged', 'integer')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('understanding_confirmation_events_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_confirmation_events_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_confirmation_events_document_fk', ['document_id'], 'understanding_documents', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_confirmation_events_actor_fk', ['actor_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addUniqueConstraint('understanding_confirmation_events_document_kind_uq', ['document_id', 'kind'])
    .addCheckConstraint('understanding_confirmation_events_kind_valid', sql`kind in ('confirmed', 'corrected')`)
    .addCheckConstraint('understanding_confirmation_events_version_positive', sql`version >= 1`)
    .addCheckConstraint('understanding_confirmation_events_correction_ref_len', sql`correction_ref is null or char_length(correction_ref) between 1 and 256`)
    // Correction fields are set for `corrected` ONLY; `confirmed` carries neither (honest shape — CDR-030 §4).
    .addCheckConstraint(
      'understanding_confirmation_events_shape',
      sql`(kind = 'confirmed' and correction_ref is null and dependents_flagged is null) or (kind = 'corrected' and correction_ref is not null and dependents_flagged is not null and dependents_flagged >= 0)`,
    )
    .execute();
  await sql`create index understanding_confirmation_events_company_version_idx on public.understanding_confirmation_events (company_id, version)`.execute(db);

  // Least-privilege: SELECT + INSERT only (append-only; supersession is a new event row, never a destructive edit).
  await sql`grant select, insert on public.understanding_item_reviews to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert on public.understanding_confirmation_events to ${APP_ROLE}`.execute(db);

  for (const table of ['understanding_item_reviews', 'understanding_confirmation_events']) {
    await sql`alter table public.${sql.ref(table)} enable row level security`.execute(db);
    await sql`alter table public.${sql.ref(table)} force row level security`.execute(db);
    await sql`
      create policy ${sql.ref(table + '_select')} on public.${sql.ref(table)} for select
        using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
    `.execute(db);
    await sql`
      create policy ${sql.ref(table + '_insert')} on public.${sql.ref(table)} for insert
        with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Symmetric teardown (mirrors 0019). Neither table references the other; drop each migration's OWN policies + grants.
  for (const table of ['understanding_confirmation_events', 'understanding_item_reviews']) {
    await sql`drop policy if exists ${sql.ref(table + '_select')} on public.${sql.ref(table)}`.execute(db);
    await sql`drop policy if exists ${sql.ref(table + '_insert')} on public.${sql.ref(table)}`.execute(db);
    await sql`revoke all on public.${sql.ref(table)} from ${APP_ROLE}`.execute(db);
  }
  await db.schema.dropTable('understanding_confirmation_events').ifExists().execute();
  await db.schema.dropTable('understanding_item_reviews').ifExists().execute();
}
