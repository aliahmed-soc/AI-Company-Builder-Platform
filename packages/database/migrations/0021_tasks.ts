// ACBP-P4-002 — task model + dependencies (CDR-033 §3; TASK-001; ADR-008; WORKFLOW §4; DATA-ARCHITECTURE §Task).
// ADDITIVE migration — migrations 0001–0020 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no existing table/policy change.
//
// Two company-owned, dual-keyed FORCE-RLS tables:
//   - `tasks` — the task entity. `state` is the CLOSED 11-value set (WORKFLOW §4); MUTABLE-with-audit (`M`): SELECT +
//     INSERT + COLUMN-LEVEL UPDATE on exactly `(state, updated_at)` — identity/provenance columns are immutable to the
//     app role (the interview_sessions 0012 pattern). No DELETE.
//   - `task_dependencies` — a Task↔Task edge. IMMUTABLE (`I`): SELECT + INSERT only. UNIQUE `(task_id, depends_on_task_id)`;
//     CHECK no self-dependency. Both FKs + the dual key make a cross-company edge impossible.
//
// FORCE RLS, dual-keyed fail-closed policies (cross-company reads/writes impossible). No backfill.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── tasks (the task entity; mutable state) ────────────────────────────────────────────────────────────
  await db.schema
    .createTable('tasks')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('state', 'text', (col) => col.notNull().defaultTo('draft'))
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('milestone_id', 'uuid')
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('tasks_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('tasks_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('tasks_actor_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('tasks_state_valid', sql`state in ('draft', 'planned', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused', 'completed', 'failed', 'cancelled')`)
    .addCheckConstraint('tasks_title_len', sql`char_length(title) between 1 and 200`)
    .addCheckConstraint('tasks_description_len', sql`description is null or char_length(description) between 1 and 4000`)
    .execute();
  await sql`create index tasks_company_state_idx on public.tasks (company_id, state)`.execute(db);

  // ── task_dependencies (Task↔Task edge; immutable) ─────────────────────────────────────────────────────
  await db.schema
    .createTable('task_dependencies')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('task_id', 'uuid', (col) => col.notNull())
    .addColumn('depends_on_task_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('task_dependencies_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_dependencies_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_dependencies_task_fk', ['task_id'], 'tasks', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_dependencies_depends_fk', ['depends_on_task_id'], 'tasks', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addUniqueConstraint('task_dependencies_edge_uq', ['task_id', 'depends_on_task_id'])
    .addCheckConstraint('task_dependencies_no_self', sql`task_id <> depends_on_task_id`)
    .execute();
  await sql`create index task_dependencies_task_idx on public.task_dependencies (task_id, id)`.execute(db);

  // Least-privilege grants: tasks = SELECT + INSERT + COLUMN-LEVEL UPDATE on the mutable columns only; task_dependencies
  // = SELECT + INSERT only (immutable edge). Identity/provenance columns are immutable to the app role. No DELETE.
  await sql`grant select, insert on public.tasks to ${APP_ROLE}`.execute(db);
  await sql`grant update (state, updated_at) on public.tasks to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert on public.task_dependencies to ${APP_ROLE}`.execute(db);

  await sql`alter table public.tasks enable row level security`.execute(db);
  await sql`alter table public.tasks force row level security`.execute(db);
  await sql`create policy tasks_select on public.tasks for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy tasks_insert on public.tasks for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy tasks_update on public.tasks for update using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY}) with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);

  await sql`alter table public.task_dependencies enable row level security`.execute(db);
  await sql`alter table public.task_dependencies force row level security`.execute(db);
  await sql`create policy task_dependencies_select on public.task_dependencies for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy task_dependencies_insert on public.task_dependencies for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop dependencies before tasks (FK), each migration's OWN policies + grants.
  for (const p of ['task_dependencies_select', 'task_dependencies_insert'] as const) {
    await sql`drop policy if exists ${sql.ref(p)} on public.task_dependencies`.execute(db);
  }
  await sql`revoke all on public.task_dependencies from ${APP_ROLE}`.execute(db);
  for (const p of ['tasks_select', 'tasks_insert', 'tasks_update'] as const) {
    await sql`drop policy if exists ${sql.ref(p)} on public.tasks`.execute(db);
  }
  await sql`revoke all on public.tasks from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('task_dependencies').ifExists().execute();
  await db.schema.dropTable('tasks').ifExists().execute();
}
