// ACBP-P2-006 — typed memory items (CDR-024; MEM-001/MEM-003; DATA-ARCHITECTURE §3). ADDITIVE expand migration
// — migrations 0001–0013 are untouched, NO SECURITY DEFINER function is added (the closed allowlist stays
// exactly three), and no existing table/policy changes.
//
// One company-owned, dual-keyed table `memory_items` — the typed memory substrate (the 0013 pattern):
//   - `type` is the CLOSED 8-value enum (MEM-001); set by the SOURCE PATH, never by content (enforced in
//     @acbp/core). A generated claim can never be stored as `user_fact` (contract-level, see @acbp/contracts).
//   - Provenance: `source_type` (closed 6-value enum) + `source_ref` NOT NULL (a resolvable link — MEM-003;
//     100% of items carry one). For an interview answer, `source_ref` encodes the pinned `(question_id,
//     revision)` (0013 has no single-column answer id).
//   - `confidence` (nullable numeric in [0,1]; scored by P2-008), `confirmation_state` (default 'proposed';
//     advanced in M3), `superseded_by` (nullable forward pointer; the supersede OPERATION + its UPDATE grant
//     are P2-010), `created_by_user_id` (nullable — worker/system-authored items exist).
//
// P2-006 scope: SELECT + INSERT only (create + list). A memory item creation is AUDITED in the same transaction
// (memory.item_created) — the audit write is by the caller, not this migration. FORCE RLS, dual-keyed
// fail-closed policies (cross-company reads are impossible — MEM-003 trust-critical). No backfill.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('memory_items')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('content', 'text', (col) => col.notNull())
    .addColumn('source_type', 'text', (col) => col.notNull())
    .addColumn('source_ref', 'text', (col) => col.notNull())
    .addColumn('confidence', 'double precision')
    .addColumn('confirmation_state', 'text', (col) => col.notNull().defaultTo('proposed'))
    .addColumn('superseded_by', 'uuid')
    .addColumn('created_by_user_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('memory_items_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('memory_items_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('memory_items_author_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    // NOTE: `superseded_by` is a plain uuid column here (no self-FK). The supersede OPERATION — which sets this
    // forward pointer — is P2-010 (CDR-024 §7); P2-010 adds the self-FK + the column-level UPDATE grant when it
    // implements the operation. Keeping the column FK-free in P2-006 avoids a self-referential constraint on a
    // table that is append-only in this ticket.
    // The CLOSED 8-value type enum (MEM-001) and 6-value source_type enum (MEM-003).
    .addCheckConstraint('memory_items_type_valid', sql`type in ('user_fact', 'user_preference', 'constraint', 'ai_assumption', 'research_finding', 'approved_decision', 'measured_outcome', 'correction')`)
    .addCheckConstraint('memory_items_source_type_valid', sql`source_type in ('interview_answer', 'user_edit', 'task_result', 'model_generation', 'imported_document', 'system_measurement')`)
    // A generated source can NEVER carry a user-stated type (the contract enforces this too — defense in depth).
    .addCheckConstraint('memory_items_type_by_source', sql`type not in ('user_fact', 'user_preference') or source_type in ('interview_answer', 'user_edit')`)
    .addCheckConstraint('memory_items_content_len', sql`char_length(content) between 1 and 10000`)
    .addCheckConstraint('memory_items_source_ref_len', sql`char_length(source_ref) between 1 and 256`)
    .addCheckConstraint('memory_items_confidence_range', sql`confidence is null or (confidence >= 0 and confidence <= 1)`)
    .addCheckConstraint('memory_items_confirmation_valid', sql`confirmation_state in ('proposed', 'accepted', 'validated', 'invalidated')`)
    .execute();
  await sql`create index memory_items_company_type_idx on public.memory_items (company_id, type)`.execute(db);
  await sql`create index memory_items_company_created_idx on public.memory_items (company_id, created_at desc, id desc)`.execute(db);

  // Least-privilege: SELECT + INSERT only (append-only for P2-006; supersede/confirm UPDATE grants are P2-010).
  await sql`grant select, insert on public.memory_items to ${APP_ROLE}`.execute(db);

  await sql`alter table public.memory_items enable row level security`.execute(db);
  await sql`alter table public.memory_items force row level security`.execute(db);

  await sql`
    create policy memory_items_select on public.memory_items for select
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy memory_items_insert on public.memory_items for insert
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Dropping the table with CASCADE removes its RLS policies and the app-role grants atomically, and never
  // errors on a missing relation — unlike a separate `drop policy if exists … on public.memory_items`, whose
  // IF EXISTS guards only the POLICY, not the table, so it raises "relation does not exist" when a down-to-an-
  // earlier-migration path runs this after the table is already gone.
  await db.schema.dropTable('memory_items').ifExists().cascade().execute();
}
