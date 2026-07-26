// ACBP-P4-006 — planning transparency (CDR-041 §4; PLAN-004; ADR-015).
// ADDITIVE migration — migrations 0001–0027 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no policy change on any existing table, and NO NEW GRANT on `tasks`.
//
// Two company-owned, dual-keyed FORCE-RLS tables, both SELECT + INSERT only (immutable — a run is a historical record;
// rewriting what a run considered would defeat the entire point of PLAN-004):
//   - `planning_runs`        — one row per planning run, autonomous or steered. Recorded even when generation FAILED
//                              (CDR-041 §3-G3): "every planning run links its input snapshot" is unqualified, and a
//                              failed run is exactly the one an owner wants to inspect.
//   - `planning_run_inputs`  — the resolvable LINKS to what the run considered. The snapshot links, it never copies
//                              (§3-G2): copying would duplicate content the secret blocklist already redacted once.
//
// Plus one additive column on `tasks`: `rationale` (PLAN-004 "why the top tasks were chosen"). INSERT-ONLY — the
// column-level UPDATE grant stays exactly `(state, updated_at)` from 0021, which the adversarial catalog pins.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

const TABLES = ['planning_runs', 'planning_run_inputs'] as const;

/** Mirrors the contract's PLANNING_INPUT_KINDS — both closed on purpose, and wider than what P4-006 records today. */
const INPUT_KINDS = ['roadmap', 'decision', 'milestone', 'memory_item', 'memory_item_withheld', 'metric', 'prior_result'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── ADDITIVE constraints on EXISTING tables, so the tenant-pinned FKs below have something to reference ──
  // A composite FK requires a UNIQUE on the referenced pair. `id` is already the PK on both, so `(id, company_id)` is
  // trivially unique and these add no new restriction — the same additive trick as 0025 (strategy_selections) and
  // 0026 (goals/milestones). Both are dropped by `down()`.
  await sql`alter table public.roadmaps add constraint roadmaps_id_company_uq unique (id, company_id)`.execute(db);
  await sql`alter table public.decisions add constraint decisions_id_company_uq unique (id, company_id)`.execute(db);

  // ── planning_runs (immutable; one per run, whatever its outcome) ─────────────────────────────────────────
  await db.schema
    .createTable('planning_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('mode', 'text', (col) => col.notNull())
    .addColumn('outcome', 'text', (col) => col.notNull())
    .addColumn('roadmap_id', 'uuid', (col) => col.notNull())
    // Denormalized deliberately: the roadmap row is versioned append-only, so this is a snapshot of WHICH version the
    // run planned against, readable without a join and stable even if the head moves on.
    .addColumn('roadmap_version', 'integer', (col) => col.notNull())
    .addColumn('decision_id', 'uuid', (col) => col.notNull())
    .addColumn('phase_scope', 'text')
    .addColumn('task_count', 'integer', (col) => col.notNull())
    .addColumn('tasks_missing_rationale', 'integer', (col) => col.notNull())
    .addColumn('milestones_in_scope', 'integer', (col) => col.notNull())
    // In-scope milestones the prompt budget could not fit. Without it, a reader of a `partial` run cannot tell
    // whether partiality came from the model or from truncation, and `milestones_in_scope` under-reports the phase.
    .addColumn('milestones_omitted', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('memory_items_considered', 'integer', (col) => col.notNull())
    // Memory items assembly resolved but the prompt budget could not fit — considered, then dropped for size. A run
    // that silently shipped fewer items than it linked would be claiming inputs the model never read.
    .addColumn('memory_items_omitted', 'integer', (col) => col.notNull().defaultTo(0))
    // WHY the run produced nothing. `outcome` alone collapses a model failure, an out-of-scope plan and the owner's
    // own concurrent decision change into one word.
    .addColumn('failure_reason', 'text')
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('planning_runs_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('planning_runs_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED composite FKs. Referential-integrity checks ALWAYS bypass row security, so a single-column
    // `roadmap_id → roadmaps(id)` would let a member of company B record a run naming company A's roadmap — an
    // existence oracle for foreign ids. Carrying `company_id` into the FK makes that impossible at the DB.
    .addForeignKeyConstraint('planning_runs_roadmap_fk', ['roadmap_id', 'company_id'], 'roadmaps', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('planning_runs_decision_fk', ['decision_id', 'company_id'], 'decisions', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('planning_runs_actor_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    // Additive, so `planning_run_inputs` can carry a same-tenant composite FK back to its run.
    .addUniqueConstraint('planning_runs_id_company_uq', ['id', 'company_id'])
    .addCheckConstraint('planning_runs_mode_valid', sql`mode in ('autonomous', 'steered')`)
    // `clarification` and `refusal` are steering's honest SUCCESSFUL answers (PLAN-002), kept distinct from `failed`
    // so the record can never misrepresent an honest model answer as a system fault.
    .addCheckConstraint('planning_runs_outcome_valid', sql`outcome in ('ok', 'partial', 'clarification', 'refusal', 'failed')`)
    .addCheckConstraint('planning_runs_phase_scope_valid', sql`phase_scope is null or phase_scope in ('first_phase', 'whole_plan')`)
    .addCheckConstraint('planning_runs_version_positive', sql`roadmap_version >= 1`)
    .addCheckConstraint('planning_runs_counts_nonneg', sql`task_count >= 0 and tasks_missing_rationale >= 0 and milestones_in_scope >= 0 and memory_items_considered >= 0 and milestones_omitted >= 0 and memory_items_omitted >= 0`)
    .addCheckConstraint('planning_runs_failure_reason_valid', sql`failure_reason is null or failure_reason in ('generation', 'out_of_scope', 'stale_decision', 'stale_roadmap')`)
    // A reason without a failure, or a failure without a reason, would each be their own kind of dishonest record.
    .addCheckConstraint('planning_runs_failure_reason_shape', sql`(outcome = 'failed' and failure_reason is not null) or (outcome <> 'failed' and failure_reason is null)`)
    // A run cannot be missing more rationales than it produced tasks — the pair is the "fully explained" summary an
    // owner reads, and an impossible pair would make it meaningless.
    .addCheckConstraint('planning_runs_missing_within_count', sql`tasks_missing_rationale <= task_count`)
    // An outcome that produced no tasks must report none, and vice versa: `ok`/`partial` mean tasks were drafted,
    // while `clarification`/`refusal`/`failed` drafted nothing. Without this a run could claim an outcome its counts
    // contradict, which is precisely the dishonest record PLAN-004 exists to prevent.
    .addCheckConstraint('planning_runs_outcome_count_shape', sql`(outcome in ('ok', 'partial') and task_count > 0) or (outcome in ('clarification', 'refusal', 'failed') and task_count = 0)`)
    .execute();
  await sql`create index planning_runs_company_created_idx on public.planning_runs (company_id, created_at desc)`.execute(db);

  // ── planning_run_inputs (immutable; the resolvable "what it considered") ─────────────────────────────────
  await db.schema
    .createTable('planning_run_inputs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('run_id', 'uuid', (col) => col.notNull())
    .addColumn('kind', 'text', (col) => col.notNull())
    // A bare id, NOT a typed FK: `kind` spans several tables (and two that do not exist yet), so a per-kind FK set
    // would have to change every time a kind is added — exactly what the discriminator exists to avoid. Same-tenant
    // resolvability is guaranteed by RLS on the referenced tables, which no cross-company reader can see through.
    .addColumn('ref_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('planning_run_inputs_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('planning_run_inputs_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('planning_run_inputs_run_fk', ['run_id', 'company_id'], 'planning_runs', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // The same input recorded twice for one run is the same fact, not two.
    .addUniqueConstraint('planning_run_inputs_run_kind_ref_uq', ['run_id', 'kind', 'ref_id'])
    .addCheckConstraint('planning_run_inputs_kind_valid', sql`kind in (${sql.join(INPUT_KINDS.map((k) => sql.lit(k)))})`)
    .execute();
  await sql`create index planning_run_inputs_run_idx on public.planning_run_inputs (run_id, kind)`.execute(db);

  // ── ADDITIVE column on an EXISTING table ────────────────────────────────────────────────────────────────
  // PLAN-004's per-task "why". NULLABLE: a missing rationale renders as "not recorded" and is counted, never invented
  // (ADR-019) — the same treatment `task_type` gets from 0027. NO GRANT statement: `tasks` keeps exactly
  // UPDATE(state, updated_at), so this column is INSERT-ONLY like the two 0027 added.
  await db.schema.alterTable('tasks').addColumn('rationale', 'text').execute();
  await sql`alter table public.tasks add constraint tasks_rationale_len check (rationale is null or char_length(rationale) between 1 and 2000)`.execute(db);

  // Least-privilege grants: SELECT + INSERT only (immutable — no UPDATE, no DELETE).
  for (const t of TABLES) {
    await sql`grant select, insert on ${sql.ref(`public.${t}`)} to ${APP_ROLE}`.execute(db);
    await sql`alter table ${sql.ref(`public.${t}`)} enable row level security`.execute(db);
    await sql`alter table ${sql.ref(`public.${t}`)} force row level security`.execute(db);
    await sql`create policy ${sql.ref(`${t}_select`)} on ${sql.ref(`public.${t}`)} for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
    await sql`create policy ${sql.ref(`${t}_insert`)} on ${sql.ref(`public.${t}`)} for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table public.tasks drop constraint if exists tasks_rationale_len`.execute(db);
  await db.schema.alterTable('tasks').dropColumn('rationale').execute();
  for (const t of TABLES) {
    for (const suffix of ['select', 'insert'] as const) {
      await sql`drop policy if exists ${sql.ref(`${t}_${suffix}`)} on ${sql.ref(`public.${t}`)}`.execute(db);
    }
    await sql`revoke all on ${sql.ref(`public.${t}`)} from ${APP_ROLE}`.execute(db);
  }
  // Schema-qualified drops, matching `up` (an unqualified drop resolves through search_path).
  await sql`drop index if exists public.planning_run_inputs_run_idx`.execute(db);
  await sql`drop index if exists public.planning_runs_company_created_idx`.execute(db);
  // FK-safe drop order: inputs → runs, and only THEN the unique constraints those FKs referenced.
  await db.schema.dropTable('planning_run_inputs').ifExists().execute();
  await db.schema.dropTable('planning_runs').ifExists().execute();
  await sql`alter table public.decisions drop constraint if exists decisions_id_company_uq`.execute(db);
  await sql`alter table public.roadmaps drop constraint if exists roadmaps_id_company_uq`.execute(db);
}
