// ACBP-P3-001 — strategy option generation (CDR-034 §3; STRAT-001/002; ADR-011/019; DATA-ARCHITECTURE §strategy options).
// ADDITIVE migration — migrations 0001–0021 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no existing table/policy change.
//
// Two company-owned, dual-keyed FORCE-RLS, IMMUTABLE (`I`) tables (the understanding_documents 0019 pattern —
// SELECT + INSERT only; a re-generation is a NEW generation row, never an in-place edit):
//   - `strategy_generations` — one generation from a CONFIRMED understanding version. `status` is the closed
//     {complete, fewer_than_three} set; `similarity_check_result` is the closed {pending, distinct,
//     insufficient_distinct} set (P3-001 writes `pending`; the P3-002 distinctness engine sets the verdict).
//   - `strategy_options` — the generated options; each carries the validated 16-field `fields` jsonb object.
//     UNIQUE `(generation_id, ordinal)`. Both FKs + the dual key make a cross-company option impossible.
//
// FORCE RLS, dual-keyed fail-closed policies (cross-company reads/writes impossible). No backfill.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── strategy_generations (one generation from a confirmed understanding version; immutable) ──────────────
  await db.schema
    .createTable('strategy_generations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('understanding_document_id', 'uuid', (col) => col.notNull())
    .addColumn('understanding_version', 'integer', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('option_count', 'integer', (col) => col.notNull())
    .addColumn('fewer_reason', 'text')
    .addColumn('similarity_check_result', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('model_flagged_partial', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('strategy_generations_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_generations_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_generations_document_fk', ['understanding_document_id'], 'understanding_documents', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_generations_actor_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('strategy_generations_status_valid', sql`status in ('complete', 'fewer_than_three')`)
    .addCheckConstraint('strategy_generations_similarity_valid', sql`similarity_check_result in ('pending', 'distinct', 'insufficient_distinct')`)
    .addCheckConstraint('strategy_generations_option_count_nonneg', sql`option_count >= 0`)
    .addCheckConstraint('strategy_generations_version_positive', sql`understanding_version >= 1`)
    .addCheckConstraint('strategy_generations_fewer_reason_len', sql`fewer_reason is null or char_length(fewer_reason) between 1 and 1000`)
    // Immutable-table integrity: the honest status is consistent with the option count (complete ⇔ ≥3), and a
    // fewer-than-three reason is meaningful ONLY on the fewer-than-three outcome (defends against any future writer).
    .addCheckConstraint('strategy_generations_status_count_consistent', sql`(status = 'complete' and option_count >= 3) or (status = 'fewer_than_three' and option_count < 3)`)
    .addCheckConstraint('strategy_generations_reason_only_when_fewer', sql`fewer_reason is null or status = 'fewer_than_three'`)
    .execute();
  await sql`create index strategy_generations_company_created_idx on public.strategy_generations (company_id, created_at desc)`.execute(db);

  // ── strategy_options (the generated options; the validated 16-field object; immutable) ──────────────────
  await db.schema
    .createTable('strategy_options')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('generation_id', 'uuid', (col) => col.notNull())
    .addColumn('ordinal', 'integer', (col) => col.notNull())
    .addColumn('fields', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('strategy_options_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_options_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_options_generation_fk', ['generation_id'], 'strategy_generations', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addUniqueConstraint('strategy_options_ordinal_uq', ['generation_id', 'ordinal'])
    .addCheckConstraint('strategy_options_ordinal_nonneg', sql`ordinal >= 0`)
    .addCheckConstraint('strategy_options_fields_object', sql`jsonb_typeof(fields) = 'object'`)
    .execute();
  await sql`create index strategy_options_generation_idx on public.strategy_options (generation_id, ordinal)`.execute(db);

  // Least-privilege grants: SELECT + INSERT only on both (immutable — no UPDATE, no DELETE).
  await sql`grant select, insert on public.strategy_generations to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert on public.strategy_options to ${APP_ROLE}`.execute(db);

  await sql`alter table public.strategy_generations enable row level security`.execute(db);
  await sql`alter table public.strategy_generations force row level security`.execute(db);
  await sql`create policy strategy_generations_select on public.strategy_generations for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy strategy_generations_insert on public.strategy_generations for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);

  await sql`alter table public.strategy_options enable row level security`.execute(db);
  await sql`alter table public.strategy_options force row level security`.execute(db);
  await sql`create policy strategy_options_select on public.strategy_options for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy strategy_options_insert on public.strategy_options for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop options before generations (FK), each migration's OWN policies + grants.
  for (const p of ['strategy_options_select', 'strategy_options_insert'] as const) {
    await sql`drop policy if exists ${sql.ref(p)} on public.strategy_options`.execute(db);
  }
  await sql`revoke all on public.strategy_options from ${APP_ROLE}`.execute(db);
  for (const p of ['strategy_generations_select', 'strategy_generations_insert'] as const) {
    await sql`drop policy if exists ${sql.ref(p)} on public.strategy_generations`.execute(db);
  }
  await sql`revoke all on public.strategy_generations from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('strategy_options').ifExists().execute();
  await db.schema.dropTable('strategy_generations').ifExists().execute();
}
