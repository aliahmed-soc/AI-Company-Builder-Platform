// ACBP-P5-002 — task runs (CDR-053; TASK-007; NFR-005; ADR-008; WORKFLOW-STATE-MACHINES §4).
//
// A RUN IS ONE EXECUTION ATTEMPT of a task, which is why `attempt` is part of its identity and why `UNIQUE(task_id,
// attempt)` matters: an attempt number is claimed exactly once, so two workers racing to start the same attempt
// resolve at the database rather than by both believing they own it.
//
// The state set is the RUN's five (CDR-053 §2) — the richer set in §4 belongs to `tasks.state` and is P4-002's.
// Company-owned and dual-keyed exactly like every other tenant table; that argument is inherited, not repeated.
//
// No new SECURITY DEFINER (the closed allowlist stays three), no new role, no policy change to any existing table.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // `tasks` needs an additive (id, company_id) UNIQUE so the run FK can be TENANT-PINNED. RI checks ALWAYS bypass
  // RLS, so a single-column FK would let a run reference ANOTHER company's task and the reference itself would never
  // be policy-checked. (P4-005 added the same shape for `task_deletions`; this is idempotent-by-name, so it is added
  // only if absent.)
  await sql`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'tasks_id_company_uq') then
        alter table public.tasks add constraint tasks_id_company_uq unique (id, company_id);
      end if;
    end $$;
  `.execute(db);

  await db.schema
    .createTable('task_runs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('task_id', 'uuid', (col) => col.notNull())
    // Which attempt this is. 1-based, and claimed exactly once per task via the unique below.
    .addColumn('attempt', 'integer', (col) => col.notNull())
    .addColumn('state', 'text', (col) => col.notNull().defaultTo('queued'))
    // CLOSED category, never worker/provider exception text — this is rendered to a human (TASK-006 "no blank
    // failures" means a CATEGORY, not a stack trace).
    .addColumn('failure_category', 'text')
    .addColumn('started_at', 'timestamptz')
    // Liveness (CDR-053 §3-G4): a timestamp the worker advances. Lostness is then a comparison any reader can make,
    // which is correct even when the process that would have run a timer is the one that died.
    .addColumn('last_heartbeat_at', 'timestamptz')
    // A DURABLE safe-stop request (§3-G6), so a briefly-unreachable worker still sees it on return and an owner who
    // asks twice gets one answer.
    .addColumn('stop_requested_at', 'timestamptz')
    .addColumn('ended_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('task_runs_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_runs_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED composite: a run can only reference a task in its OWN company.
    .addForeignKeyConstraint('task_runs_task_fk', ['task_id', 'company_id'], 'tasks', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // An attempt number is claimed ONCE. Two workers racing to start attempt 2 resolve here, not by both proceeding.
    .addUniqueConstraint('task_runs_attempt_uq', ['task_id', 'attempt'])
    .addCheckConstraint('task_runs_state_valid', sql`state in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`)
    .addCheckConstraint('task_runs_attempt_positive', sql`attempt >= 1`)
    // ONE-DIRECTIONAL, the P5-009/P5-001c lesson: a category implies a failed run, but a failed run need not carry
    // one, so any history predating this constraint stays legal.
    .addCheckConstraint('task_runs_failure_category_valid', sql`failure_category is null or (failure_category in ('worker_lost', 'timeout', 'provider_error', 'policy_blocked', 'internal_error') and state = 'failed')`)
    .execute();

  // The coordinator's two reads: this company's live runs, and a task's attempt history.
  await sql`create index task_runs_company_state_idx on public.task_runs (company_id, state, updated_at desc)`.execute(db);
  await sql`create index task_runs_task_attempt_idx on public.task_runs (task_id, attempt desc)`.execute(db);

  // LEAST PRIVILEGE. SELECT + INSERT + a COLUMN-SCOPED update of exactly the lifecycle columns. Identity, tenancy,
  // task linkage and attempt number are immutable to the app role, so a run cannot be re-pointed at another task or
  // renumbered after the fact. NO DELETE: a run is the record that an attempt happened.
  await sql`grant select, insert on public.task_runs to ${APP_ROLE}`.execute(db);
  await sql`grant update (state, failure_category, started_at, last_heartbeat_at, stop_requested_at, ended_at, updated_at) on public.task_runs to ${APP_ROLE}`.execute(db);

  await sql`alter table public.task_runs enable row level security`.execute(db);
  await sql`alter table public.task_runs force row level security`.execute(db);
  await sql`create policy task_runs_select on public.task_runs for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy task_runs_insert on public.task_runs for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy task_runs_update on public.task_runs for update using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY}) with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists task_runs_update on public.task_runs`.execute(db);
  await sql`drop policy if exists task_runs_insert on public.task_runs`.execute(db);
  await sql`drop policy if exists task_runs_select on public.task_runs`.execute(db);
  await sql`revoke all on public.task_runs from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.task_runs_task_attempt_idx`.execute(db);
  await sql`drop index if exists public.task_runs_company_state_idx`.execute(db);
  await db.schema.dropTable('task_runs').ifExists().execute();
  // The additive UNIQUE is left in place: ACBP-P4-005's `task_deletions` FK also depends on a (id, company_id)
  // reference, so dropping it here would break a table this migration never created.
}
