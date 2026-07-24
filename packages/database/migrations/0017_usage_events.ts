// ACBP-P2-003 — model-gateway usage ledger (CDR-026 §6; ADR-011, ADR-013; USAGE-001, invariant 9;
// DATA-ARCHITECTURE Usage event). ADDITIVE migration — migrations 0001–0016 are untouched, NO SECURITY
// DEFINER function is added (the closed allowlist stays exactly three), no existing table/policy changes.
//
// One company-owned, dual-keyed table `usage_events` — the APPEND-ONLY usage source record every model
// call emits (`model.call_completed`). It is the durable, immutable metering record; fail-closed metering
// (CDR-026 §5) writes it in the SAME transaction as the gateway work.
//   - Least privilege: SELECT + INSERT ONLY — NEVER an update/delete grant (invariant 9, append-only). A
//     row, once written, is immutable; there is no correction-in-place (a correction is a new row).
//   - Bounded, non-secret metadata only: NO prompt/response content, NO secrets (CDR-026 §6).
//   - Money is integer micro-units (1e-6 of the cost unit); never a float. `estimated_cost_micros` is the
//     PROVIDER-cost ESTIMATE lane (ADR-013) — not billable credits (P5-014/P6-009).
//   - `error_category` is present iff `outcome = 'error'` (the pairing check), drawn from the normalized
//     seven-value taxonomy (ADR-011 §5); `outcome = 'ok'` rows carry no error.
//   - `kind` is the extension point (v1: only `model_call`; tool/worker usage arrive later).
//
// FORCE RLS, dual-keyed fail-closed policies (cross-company reads are impossible — USAGE-001 trust-critical).
// No backfill.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('usage_events')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('kind', 'text', (col) => col.notNull().defaultTo('model_call'))
    .addColumn('provider', 'text', (col) => col.notNull())
    .addColumn('model', 'text', (col) => col.notNull())
    .addColumn('task_class', 'text', (col) => col.notNull())
    .addColumn('outcome', 'text', (col) => col.notNull())
    .addColumn('error_category', 'text')
    .addColumn('input_tokens', 'integer', (col) => col.notNull())
    .addColumn('output_tokens', 'integer', (col) => col.notNull())
    .addColumn('estimated_cost_micros', 'integer', (col) => col.notNull())
    .addColumn('fallback_used', 'boolean', (col) => col.notNull())
    .addColumn('latency_ms', 'integer', (col) => col.notNull())
    .addColumn('correlation_id', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('usage_events_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('usage_events_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addCheckConstraint('usage_events_kind_valid', sql`kind in ('model_call')`)
    .addCheckConstraint('usage_events_task_class_valid', sql`task_class in ('interactive', 'extraction', 'classification', 'generation')`)
    .addCheckConstraint('usage_events_outcome_valid', sql`outcome in ('ok', 'error')`)
    // The normalized seven-value error taxonomy (ADR-011 §5) — null on success.
    .addCheckConstraint('usage_events_error_category_valid', sql`error_category is null or error_category in ('timeout', 'rate_limited', 'provider_unavailable', 'invalid_output', 'content_refused', 'budget_exceeded', 'internal')`)
    // Pairing: an error row carries a category; an ok row does not.
    .addCheckConstraint('usage_events_outcome_error_pair', sql`(outcome = 'error') = (error_category is not null)`)
    // Non-negative counters + money (integer micro-units, never a float).
    .addCheckConstraint('usage_events_input_tokens_nonneg', sql`input_tokens >= 0`)
    .addCheckConstraint('usage_events_output_tokens_nonneg', sql`output_tokens >= 0`)
    .addCheckConstraint('usage_events_cost_nonneg', sql`estimated_cost_micros >= 0`)
    .addCheckConstraint('usage_events_latency_nonneg', sql`latency_ms >= 0`)
    // Bounded, non-secret identifiers.
    .addCheckConstraint('usage_events_provider_len', sql`char_length(provider) between 1 and 64`)
    .addCheckConstraint('usage_events_model_len', sql`char_length(model) between 1 and 128`)
    .addCheckConstraint('usage_events_correlation_len', sql`correlation_id is null or char_length(correlation_id) between 1 and 128`)
    .execute();
  // Listing/rollup access path: newest-first within a company, with a deterministic total order.
  await sql`create index usage_events_company_created_idx on public.usage_events (company_id, created_at desc, id desc)`.execute(db);

  // Least-privilege: SELECT + INSERT ONLY. There is deliberately NO update/delete grant — the ledger is
  // append-only (invariant 9); a row is immutable once written.
  await sql`grant select, insert on public.usage_events to ${APP_ROLE}`.execute(db);

  await sql`alter table public.usage_events enable row level security`.execute(db);
  await sql`alter table public.usage_events force row level security`.execute(db);

  await sql`
    create policy usage_events_select on public.usage_events for select
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy usage_events_insert on public.usage_events for insert
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Symmetric teardown (mirrors 0014): drop this migration's OWN policies + app-role grants, then the table.
  await sql`drop policy if exists usage_events_select on public.usage_events`.execute(db);
  await sql`drop policy if exists usage_events_insert on public.usage_events`.execute(db);
  await sql`revoke all on public.usage_events from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('usage_events').ifExists().execute();
}
