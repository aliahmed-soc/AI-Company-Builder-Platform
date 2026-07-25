// ACBP-P3-003 — optional AI recommendation (CDR-036 §3; STRAT-004; DATA-ARCHITECTURE §strategy).
// ADDITIVE migration — migrations 0001–0022 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no existing table/policy change.
//
// One company-owned, dual-keyed FORCE-RLS, IMMUTABLE (`I`) table `strategy_recommendations` (the strategy_options 0022
// pattern — SELECT + INSERT only; append-only — a re-recommendation is a NEW row, latest-wins on read; "no
// recommendation" = ABSENCE of a row). The recommendation is ADVISORY: it references one option + carries a rationale +
// sensitivities; it selects nothing (selection is P3-004) and changes no state. A cross-company recommendation is
// impossible (both FKs + the dual key confine to one company).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('strategy_recommendations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('generation_id', 'uuid', (col) => col.notNull())
    .addColumn('recommended_option_id', 'uuid', (col) => col.notNull())
    .addColumn('rationale', 'text', (col) => col.notNull())
    .addColumn('sensitivities', 'text', (col) => col.notNull())
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('strategy_recommendations_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_recommendations_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_recommendations_generation_fk', ['generation_id'], 'strategy_generations', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_recommendations_option_fk', ['recommended_option_id'], 'strategy_options', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('strategy_recommendations_actor_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('strategy_recommendations_rationale_len', sql`char_length(rationale) between 1 and 4000`)
    .addCheckConstraint('strategy_recommendations_sensitivities_len', sql`char_length(sensitivities) between 1 and 4000`)
    .execute();
  await sql`create index strategy_recommendations_generation_idx on public.strategy_recommendations (generation_id, created_at desc)`.execute(db);

  // Least-privilege grants: SELECT + INSERT only (immutable — no UPDATE, no DELETE).
  await sql`grant select, insert on public.strategy_recommendations to ${APP_ROLE}`.execute(db);

  await sql`alter table public.strategy_recommendations enable row level security`.execute(db);
  await sql`alter table public.strategy_recommendations force row level security`.execute(db);
  await sql`create policy strategy_recommendations_select on public.strategy_recommendations for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy strategy_recommendations_insert on public.strategy_recommendations for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of ['strategy_recommendations_select', 'strategy_recommendations_insert'] as const) {
    await sql`drop policy if exists ${sql.ref(p)} on public.strategy_recommendations`.execute(db);
  }
  await sql`revoke all on public.strategy_recommendations from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('strategy_recommendations').ifExists().execute();
}
