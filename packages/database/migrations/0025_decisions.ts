// ACBP-P3-005 — immutable decision records (CDR-038 §2; STRAT-006; ADR-015; DATA-ARCHITECTURE §Decision).
// ADDITIVE migration — migrations 0001–0024 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no existing table/policy change.
//
// One company-owned, dual-keyed FORCE-RLS, IMMUTABLE (`I`) table `decisions` (the strategy_selections 0024 pattern —
// SELECT + INSERT only; append-only, latest-wins on read; "no decision" = ABSENCE of a row). The decision record is the
// durable, audit-grade "institutional memory of why" (STRAT-006): it links the CONFIRMED understanding version, the
// options CONSIDERED (via `generation_id` — the generation's option set is itself immutable, so the link fixes exactly
// what was considered), the SELECTION it hardens, and an optional owner-supplied rationale. Immutability is the
// STRAT-006 acceptance criterion ("mutation attempts fail"); the in-transaction `decision.recorded` audit is the
// "failed record writes block the transition" guarantee. Recording a decision unlocks NO planning (that gate is P4-001).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // Enable a COMPOSITE FK so a decision's selection must belong to the SAME generation (defense-in-depth beyond the
  // single-writer guarantee): strategy_selections needs a UNIQUE(id, generation_id) for the (selection_id,
  // generation_id) FK below to reference. `id` is already the PK (so the pair is trivially unique); this is additive.
  await sql`alter table public.strategy_selections add constraint strategy_selections_id_generation_uq unique (id, generation_id)`.execute(db);

  await db.schema
    .createTable('decisions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('generation_id', 'uuid', (col) => col.notNull())
    .addColumn('selection_id', 'uuid', (col) => col.notNull())
    .addColumn('understanding_version', 'integer', (col) => col.notNull())
    .addColumn('rationale', 'text')
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('decisions_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('decisions_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('decisions_generation_fk', ['generation_id'], 'strategy_generations', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // COMPOSITE FK: the hardened selection must belong to THIS generation (selection_id + generation_id must match a
    // strategy_selections (id, generation_id) pair) — a cross-generation decision is impossible at the DB.
    .addForeignKeyConstraint('decisions_selection_fk', ['selection_id', 'generation_id'], 'strategy_selections', ['id', 'generation_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('decisions_actor_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('decisions_version_positive', sql`understanding_version >= 1`)
    // The rationale is OPTIONAL (CDR-038 §6-G2 — a missing rationale must never make a decision silently unrecorded),
    // but when present it is non-blank and bounded.
    .addCheckConstraint('decisions_rationale_len', sql`rationale is null or char_length(rationale) between 1 and 4000`)
    .execute();
  await sql`create index decisions_generation_idx on public.decisions (generation_id, created_at desc)`.execute(db);

  // Least-privilege grants: SELECT + INSERT only (immutable — no UPDATE, no DELETE; STRAT-006 "mutation attempts fail").
  await sql`grant select, insert on public.decisions to ${APP_ROLE}`.execute(db);

  await sql`alter table public.decisions enable row level security`.execute(db);
  await sql`alter table public.decisions force row level security`.execute(db);
  await sql`create policy decisions_select on public.decisions for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy decisions_insert on public.decisions for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of ['decisions_select', 'decisions_insert'] as const) {
    await sql`drop policy if exists ${sql.ref(p)} on public.decisions`.execute(db);
  }
  await sql`revoke all on public.decisions from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('decisions').ifExists().execute();
  await sql`alter table public.strategy_selections drop constraint if exists strategy_selections_id_generation_uq`.execute(db);
}
