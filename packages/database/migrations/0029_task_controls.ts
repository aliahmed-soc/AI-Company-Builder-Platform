// ACBP-P4-005 — task detail controls (CDR-043 §5; TASK-002/TASK-008).
// ADDITIVE migration — migrations 0001–0028 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no policy change on any existing table, and — the load-bearing part — **NO CHANGE TO
// THE `tasks` GRANTS**.
//
// TASK-008 requires that a task can be deleted, "with confirmation", and that the deletion is audited. `tasks` (0021)
// grants the app role SELECT + INSERT + a column-level UPDATE on exactly `(state, updated_at)`; there is no DELETE,
// and the adversarial catalog suite pins that grant set. Three options were weighed (CDR-043 §3):
//   1. GRANT DELETE — rejected: it destroys the very audit trail TASK-008 demands, and `task_dependencies` /
//      `planning_run_inputs` reference tasks.
//   2. Add `tasks.deleted_at` and widen the UPDATE grant — rejected: widening a grant the tenant-isolation suite pins
//      is a security-relevant change, and CDR-040 §8-G9 already declined to widen it for a feature.
//   3. A separate APPEND-ONLY table — chosen, and the established precedent: CDR-039 picked exactly this shape for
//      `task_review_flags` for exactly this reason.
//
// So deletion is a RECORDED FACT, not an erasure. The task row survives; reads exclude it.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── ADDITIVE constraint on an EXISTING table, so the composite FKs below have something to reference ────
  // `id` is already the PK, so `(id, company_id)` is trivially unique and this adds no new restriction — the same
  // additive trick as 0025/0026/0028. Dropped by `down()`.
  await sql`alter table public.tasks add constraint tasks_id_company_uq unique (id, company_id)`.execute(db);

  // ── task_deletions (immutable; one row per deleted task) ────────────────────────────────────────────────
  await db.schema
    .createTable('task_deletions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('task_id', 'uuid', (col) => col.notNull())
    // The state the task was in when it was removed. A completed task and a queued one are very different losses, and
    // once the task row is filtered out of every read this column is the only place that distinction survives.
    .addColumn('state_at_delete', 'text', (col) => col.notNull())
    .addColumn('reason', 'text')
    .addColumn('deleted_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('task_deletions_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_deletions_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED: referential-integrity checks ALWAYS bypass row security, so a single-column `task_id → tasks(id)`
    // would let a member of company B record a deletion naming company A's task — an existence oracle for foreign ids,
    // and a write that appears in A's history.
    .addForeignKeyConstraint('task_deletions_task_fk', ['task_id', 'company_id'], 'tasks', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_deletions_actor_fk', ['deleted_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    // A task is deleted once. A repeat delete is the SAME fact, not a second one — this makes the use case idempotent
    // at the database rather than by a check-then-insert that could race.
    .addUniqueConstraint('task_deletions_task_uq', ['task_id'])
    .addCheckConstraint('task_deletions_reason_len', sql`reason is null or char_length(reason) between 1 and 2000`)
    .addCheckConstraint(
      'task_deletions_state_valid',
      sql`state_at_delete in ('draft', 'planned', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused', 'completed', 'failed', 'cancelled')`,
    )
    .execute();
  await sql`create index task_deletions_company_created_idx on public.task_deletions (company_id, created_at desc)`.execute(db);

  // ── ADDITIVE column on an EXISTING table ────────────────────────────────────────────────────────────────
  // TASK-008's "repeated (re-queued as a NEW task)" — the lineage link the backlog calls for ("repeat links
  // lineage"). NULLABLE (most tasks are not repeats) and INSERT-ONLY: no GRANT statement here, so `tasks` keeps
  // exactly UPDATE(state, updated_at), which the adversarial catalog pins.
  await db.schema.alterTable('tasks').addColumn('repeated_from_task_id', 'uuid').execute();
  // Tenant-pinned for the same reason as above: a repeat must never be able to name another company's task as its
  // source. Self-referential, so it is added after the column exists.
  await sql`alter table public.tasks add constraint tasks_repeated_from_fk foreign key (repeated_from_task_id, company_id) references public.tasks(id, company_id) on delete set null (repeated_from_task_id)`.execute(db);
  // A task can never be its own source — a self-repeat would make the lineage chain a cycle of length one.
  await sql`alter table public.tasks add constraint tasks_repeated_from_not_self check (repeated_from_task_id is null or repeated_from_task_id <> id)`.execute(db);
  await sql`create index tasks_repeated_from_idx on public.tasks (repeated_from_task_id) where repeated_from_task_id is not null`.execute(db);

  // Least-privilege grant: SELECT + INSERT only (immutable — no UPDATE, no DELETE). A deletion record that could be
  // edited or removed would let the history of what an owner discarded be rewritten.
  await sql`grant select, insert on public.task_deletions to ${APP_ROLE}`.execute(db);
  await sql`alter table public.task_deletions enable row level security`.execute(db);
  await sql`alter table public.task_deletions force row level security`.execute(db);
  await sql`create policy task_deletions_select on public.task_deletions for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy task_deletions_insert on public.task_deletions for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists task_deletions_select on public.task_deletions`.execute(db);
  await sql`drop policy if exists task_deletions_insert on public.task_deletions`.execute(db);
  await sql`revoke all on public.task_deletions from ${APP_ROLE}`.execute(db);
  // Schema-qualified drops, matching `up` (an unqualified drop resolves through search_path).
  await sql`drop index if exists public.tasks_repeated_from_idx`.execute(db);
  await sql`alter table public.tasks drop constraint if exists tasks_repeated_from_not_self`.execute(db);
  await sql`alter table public.tasks drop constraint if exists tasks_repeated_from_fk`.execute(db);
  await db.schema.alterTable('tasks').dropColumn('repeated_from_task_id').execute();
  await sql`drop index if exists public.task_deletions_company_created_idx`.execute(db);
  // The child table references `tasks_id_company_uq`, so it must go before the constraint it depends on.
  await db.schema.dropTable('task_deletions').ifExists().execute();
  await sql`alter table public.tasks drop constraint if exists tasks_id_company_uq`.execute(db);
}
