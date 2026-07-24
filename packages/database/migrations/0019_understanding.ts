// ACBP-P2-008 — understanding generation persistence (CDR-029 §5/§6; UNDER-001/005; DATA-ARCHITECTURE §3 —
// Understanding = versioned `V`, company-scoped `C`). ADDITIVE migration — migrations 0001–0018 are untouched, NO
// SECURITY DEFINER is added (the closed allowlist stays exactly three), no new role, no existing table/policy
// change.
//
// Two company-owned, dual-keyed tables (the `memory_items` 0014 pattern):
//   - `understanding_documents` — one row per generated version. `version` is monotonic per company (unique
//     `(company_id, version)`); `status` is the CLOSED 2-value set (`complete` | `partial` — honest partial
//     labeling, CDR-029 §3); `overall_confidence` in [0,1] (the weakest-section rule, UNDER-005). SELECT+INSERT
//     only — a version is IMMUTABLE; a re-generation is a NEW version, never an in-place edit.
//   - `understanding_items` — the classified items of a version. `item_class` is the CLOSED 6-value set
//     (diagram 04); `confidence` in [0,1]; `source_ref` (nullable, bounded) is the provenance link to the memory
//     item(s) it derives from (MEM-003). SELECT+INSERT only (append-only).
//
// FORCE RLS, dual-keyed fail-closed policies (cross-company reads/writes impossible — UNDER trust-critical). No
// backfill. Review/approve/correct lifecycle is P2-009 (no UPDATE/DELETE grant here).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── understanding_documents (versioned header) ──────────────────────────────────────────────────────
  await db.schema
    .createTable('understanding_documents')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('overall_confidence', 'double precision', (col) => col.notNull())
    .addColumn('created_by_user_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('understanding_documents_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_documents_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_documents_author_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addUniqueConstraint('understanding_documents_company_version_uq', ['company_id', 'version'])
    .addCheckConstraint('understanding_documents_status_valid', sql`status in ('complete', 'partial')`)
    .addCheckConstraint('understanding_documents_version_positive', sql`version >= 1`)
    .addCheckConstraint('understanding_documents_confidence_range', sql`overall_confidence >= 0 and overall_confidence <= 1`)
    .execute();
  await sql`create index understanding_documents_company_version_idx on public.understanding_documents (company_id, version desc)`.execute(db);

  // ── understanding_items (classified items of a version) ─────────────────────────────────────────────
  await db.schema
    .createTable('understanding_items')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('document_id', 'uuid', (col) => col.notNull())
    .addColumn('item_class', 'text', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('confidence', 'double precision', (col) => col.notNull())
    .addColumn('source_ref', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('understanding_items_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_items_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('understanding_items_document_fk', ['document_id'], 'understanding_documents', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addCheckConstraint('understanding_items_class_valid', sql`item_class in ('fact', 'preference', 'constraint', 'assumption', 'research_finding', 'open_question')`)
    .addCheckConstraint('understanding_items_content_len', sql`char_length(content) between 1 and 10000`)
    .addCheckConstraint('understanding_items_confidence_range', sql`confidence >= 0 and confidence <= 1`)
    .addCheckConstraint('understanding_items_source_ref_len', sql`source_ref is null or char_length(source_ref) between 1 and 256`)
    .execute();
  await sql`create index understanding_items_document_idx on public.understanding_items (document_id, id)`.execute(db);

  // Least-privilege: SELECT + INSERT only (append-only versioned — review/correct is P2-009).
  await sql`grant select, insert on public.understanding_documents to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert on public.understanding_items to ${APP_ROLE}`.execute(db);

  for (const table of ['understanding_documents', 'understanding_items']) {
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
  // Symmetric teardown (mirrors 0014). Drop items before documents (FK), each migration's OWN policies + grants.
  for (const table of ['understanding_items', 'understanding_documents']) {
    await sql`drop policy if exists ${sql.ref(table + '_select')} on public.${sql.ref(table)}`.execute(db);
    await sql`drop policy if exists ${sql.ref(table + '_insert')} on public.${sql.ref(table)}`.execute(db);
    await sql`revoke all on public.${sql.ref(table)} from ${APP_ROLE}`.execute(db);
  }
  await db.schema.dropTable('understanding_items').ifExists().execute();
  await db.schema.dropTable('understanding_documents').ifExists().execute();
}
