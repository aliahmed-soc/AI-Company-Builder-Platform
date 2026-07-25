// ACBP-P3-004 — owner strategy decision (CDR-037 §2; STRAT-003/005; DATA-ARCHITECTURE §strategy).
// ADDITIVE migration — migrations 0001–0023 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no existing table/policy change.
//
// One company-owned, dual-keyed FORCE-RLS, IMMUTABLE (`I`) table `strategy_selections` (the strategy_recommendations
// 0023 pattern — SELECT + INSERT only; append-only — a re-decision is a NEW row, latest-wins on read; "no decision" =
// ABSENCE of a row). The selection records the owner's decision over a generation's options in one of four modes:
//   - select   — an existing option is chosen (selected_option_id set; no chosen_fields).
//   - edit      — an option is chosen AND revised (chosen_fields set; selected_option_id is the OPTIONAL base).
//   - combine   — a new option is authored from several (chosen_fields set; no base option).
//   - reject    — none fit (reasons set; no option, no fields, no phase scope).
// phase_scope {first_phase, whole_plan} is FLAGGING only (STRAT-005) — enforcement is the P4 planning boundary; reject
// carries none. This table records a SELECTION; it is NOT a decision record (decision.recorded is P3-005) and unlocks
// no planning. A cross-generation/company selection is impossible (all FKs + the dual key + the composite option FK).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('strategy_selections')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('generation_id', 'uuid', (col) => col.notNull())
    .addColumn('mode', 'text', (col) => col.notNull())
    .addColumn('selected_option_id', 'uuid')
    .addColumn('chosen_fields', 'jsonb')
    .addColumn('phase_scope', 'text')
    .addColumn('reasons', 'text')
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('strategy_selections_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_selections_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_selections_generation_fk', ['generation_id'], 'strategy_generations', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // COMPOSITE FK: when an option is named, it must belong to THIS generation (selected_option_id + generation_id must
    // match a strategy_options (id, generation_id) pair) — a cross-generation base is impossible at the DB. A NULL
    // selected_option_id (combine / reject / an edit with no base) skips the check (MATCH SIMPLE).
    .addForeignKeyConstraint('strategy_selections_option_fk', ['selected_option_id', 'generation_id'], 'strategy_options', ['id', 'generation_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_selections_actor_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('strategy_selections_mode_valid', sql`mode in ('select', 'edit', 'combine', 'reject')`)
    .addCheckConstraint('strategy_selections_phase_scope_valid', sql`phase_scope is null or phase_scope in ('first_phase', 'whole_plan')`)
    .addCheckConstraint('strategy_selections_chosen_fields_object', sql`chosen_fields is null or jsonb_typeof(chosen_fields) = 'object'`)
    .addCheckConstraint('strategy_selections_reasons_len', sql`reasons is null or char_length(reasons) between 1 and 4000`)
    // reject carries no phase scope (STRAT-005 — phase scope qualifies an approval, not a rejection).
    .addCheckConstraint('strategy_selections_reject_no_phase', sql`mode <> 'reject' or phase_scope is null`)
    // Per-mode shape (immutable-table integrity — defends against any future writer):
    //   select  → an option, no authored fields, no reasons.
    //   edit    → authored fields (optional base option), no reasons.
    //   combine → authored fields, no base option, no reasons.
    //   reject  → reasons, no option, no fields.
    .addCheckConstraint(
      'strategy_selections_mode_shape',
      sql`(mode = 'select' and selected_option_id is not null and chosen_fields is null and reasons is null)
       or (mode = 'edit' and chosen_fields is not null and reasons is null)
       or (mode = 'combine' and chosen_fields is not null and selected_option_id is null and reasons is null)
       or (mode = 'reject' and reasons is not null and selected_option_id is null and chosen_fields is null)`,
    )
    .execute();
  await sql`create index strategy_selections_generation_idx on public.strategy_selections (generation_id, created_at desc)`.execute(db);

  // Least-privilege grants: SELECT + INSERT only (immutable — no UPDATE, no DELETE).
  await sql`grant select, insert on public.strategy_selections to ${APP_ROLE}`.execute(db);

  await sql`alter table public.strategy_selections enable row level security`.execute(db);
  await sql`alter table public.strategy_selections force row level security`.execute(db);
  await sql`create policy strategy_selections_select on public.strategy_selections for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy strategy_selections_insert on public.strategy_selections for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of ['strategy_selections_select', 'strategy_selections_insert'] as const) {
    await sql`drop policy if exists ${sql.ref(p)} on public.strategy_selections`.execute(db);
  }
  await sql`revoke all on public.strategy_selections from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('strategy_selections').ifExists().execute();
}
