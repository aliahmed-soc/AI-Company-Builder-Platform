// ACBP-P5-005 — worker runs (CDR-057; WORK-001..006; NFR-015; ADR-012; trust-critical #3).
//
// THE STAMP. `CDR-056 §6` recorded WORK-006's failure clause — "disable during execution triggers safe-stop" — as
// unmet, because nothing linked a run to the worker executing it. This table is that link, and canon's own shape for
// it: `DATA-ARCHITECTURE` says a Task run *has* a Worker run, and `EVENT-CATALOG` gives the events a `worker_run_id`.
// A pair of columns on `task_runs` would have been cheaper and would not have been what canon describes.
//
// Company-owned and dual-keyed exactly like every other tenant table; that argument is inherited, not repeated.
// No new SECURITY DEFINER (the closed allowlist stays three), no new role.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('worker_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    // ONE worker executes ONE attempt. A retry is a NEW task run, so this never blocks one — and it is the constraint
    // that would have to relax first if a run ever needed two workers.
    .addColumn('task_run_id', 'uuid', (col) => col.notNull())
    // THE STAMP ITSELF. Version included: "which worker ran this" is not answerable without it once a worker is
    // re-registered, and diagram 07 hands the runtime `worker_id@version` precisely as a pair.
    .addColumn('worker_id', 'text', (col) => col.notNull())
    .addColumn('worker_version', 'integer', (col) => col.notNull())
    // SNAPSHOT of the definition's bounds (CDR-057 §1-G2). Re-reading the definition mid-flight would let an edit
    // change the budget a run is judged against, and the record would stop saying what was actually enforced.
    .addColumn('max_spend_micros', 'integer', (col) => col.notNull())
    .addColumn('max_duration_ms', 'integer', (col) => col.notNull())
    // The ENFORCEMENT counters the runtime advances. Not a reconciliation source — that needs the ledger link, which
    // is P5-014's (CDR-057 §4).
    .addColumn('spend_micros', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('steps_completed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('outcome', 'text', (col) => col.notNull().defaultTo('running'))
    // CLOSED category, never provider or worker exception text.
    .addColumn('failure_category', 'text')
    // WHY it halted early, when it did. A reason, not a message.
    .addColumn('halt_reason', 'text')
    .addColumn('started_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('ended_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('worker_runs_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('worker_runs_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED composite: a worker run can only reference a task run in its OWN company. RI checks always bypass
    // RLS, so a single-column FK would let it point at another company's run and never be policy-checked.
    .addForeignKeyConstraint('worker_runs_task_run_fk', ['task_run_id', 'company_id'], 'task_runs', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addUniqueConstraint('worker_runs_task_run_uq', ['task_run_id'])
    .addCheckConstraint('worker_runs_outcome_valid', sql`outcome in ('running', 'succeeded', 'failed', 'stopped')`)
    .addCheckConstraint('worker_runs_version_positive', sql`worker_version >= 1`)
    .addCheckConstraint('worker_runs_bounds_positive', sql`max_spend_micros > 0 and max_duration_ms > 0`)
    // Counters only ever move forward from zero. A negative spend would make the budget check nonsense.
    .addCheckConstraint('worker_runs_counters_non_negative', sql`spend_micros >= 0 and steps_completed >= 0`)
    // ONE-DIRECTIONAL, the P5-009/P5-001c lesson: a category implies a failed run, but a failed run need not carry one.
    .addCheckConstraint(
      'worker_runs_failure_category_valid',
      sql`failure_category is null or (failure_category in ('worker_lost', 'timeout', 'provider_error', 'policy_blocked', 'internal_error') and outcome = 'failed')`,
    )
    // A halt reason belongs only to a run that actually stopped early — never to one still running or one that finished
    // its work.
    .addCheckConstraint(
      'worker_runs_halt_reason_valid',
      sql`halt_reason is null or (halt_reason in ('budget_exhausted', 'duration_exceeded', 'bounds_unreadable') and outcome in ('failed', 'stopped'))`,
    )
    .execute();

  // The two reads: this company's live runs (the WORK-006 safe-stop sweep), and a task run's worker.
  await sql`create index worker_runs_company_outcome_idx on public.worker_runs (company_id, outcome, worker_id)`.execute(db);
  await sql`create index worker_runs_worker_idx on public.worker_runs (worker_id, outcome)`.execute(db);

  // LEAST PRIVILEGE. SELECT + INSERT + a COLUMN-SCOPED update of the counters and lifecycle only. The STAMP is
  // immutable: tenancy, the task run, the worker id and version, and the snapshot bounds cannot be rewritten, so a
  // run cannot be re-attributed to a different worker or judged against a budget it was not given.
  // NO DELETE: a worker run is the record that a worker executed.
  await sql`grant select, insert on public.worker_runs to ${APP_ROLE}`.execute(db);
  await sql`grant update (spend_micros, steps_completed, outcome, failure_category, halt_reason, ended_at, updated_at) on public.worker_runs to ${APP_ROLE}`.execute(db);

  await sql`alter table public.worker_runs enable row level security`.execute(db);
  await sql`alter table public.worker_runs force row level security`.execute(db);
  await sql`create policy worker_runs_select on public.worker_runs for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy worker_runs_insert on public.worker_runs for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy worker_runs_update on public.worker_runs for update using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY}) with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists worker_runs_update on public.worker_runs`.execute(db);
  await sql`drop policy if exists worker_runs_insert on public.worker_runs`.execute(db);
  await sql`drop policy if exists worker_runs_select on public.worker_runs`.execute(db);
  await sql`revoke all on public.worker_runs from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.worker_runs_worker_idx`.execute(db);
  await sql`drop index if exists public.worker_runs_company_outcome_idx`.execute(db);
  await db.schema.dropTable('worker_runs').ifExists().execute();
}
