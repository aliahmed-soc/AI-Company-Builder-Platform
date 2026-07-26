// ACBP-P4-003 — task planning fields (CDR-040 §5; PLAN-001; ADR-019).
// ADDITIVE migration — migrations 0001–0026 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no new table, no policy change, and NO NEW GRANT.
//
// Two columns on the existing `tasks` table, both required by PLAN-001's acceptance criterion ("3+ prioritized tasks
// …; each has type and description") rather than invented:
//   - `task_type` — the closed initial set from the PRD. NULLABLE because manual task creation supplies none and every
//     existing row has none; a missing type renders as explicitly missing (TASK-002) rather than being guessed.
//   - `priority`  — an integer RANK (the plan's own ordering), NOT a scale. Canon says "prioritized" but defines no
//     scale anywhere, and an invented high/medium/low would be exactly the fabricated precision ADR-019 forbids —
//     the same reasoning as CDR-039 §7-G6 (milestones sequence by ordinal, never by an invented date).
//
// Both are INSERT-ONLY: the column-level UPDATE grant deliberately stays exactly `(state, updated_at)` (migration
// 0021), which the adversarial catalog pins. Stated plainly (CDR-040 §8-G9): this leaves J-10's "adjust priorities"
// unreachable, which is preferred over widening a grant the tenant-isolation suite asserts.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** The seven "Initial task types" (MASTER-PRD-v1). Mirrors the contract's TASK_TYPES — both are closed on purpose. */
const TASK_TYPES = ['market_research', 'competitor_research', 'customer_segment_analysis', 'business_model_comparison', 'business_plan_generation', 'landing_page_copy', 'internal_product_requirements'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('tasks').addColumn('task_type', 'text').execute();
  await db.schema.alterTable('tasks').addColumn('priority', 'integer').execute();

  // Deny-by-default enums, consistent with every other closed set in the schema. A NULL is the honest "not stated".
  await sql`alter table public.tasks add constraint tasks_task_type_valid check (task_type is null or task_type in (${sql.join(TASK_TYPES.map((t) => sql.lit(t)))}))`.execute(db);
  // A rank, so any non-negative integer is meaningful; there is no upper bound to invent.
  await sql`alter table public.tasks add constraint tasks_priority_nonneg check (priority is null or priority >= 0)`.execute(db);

  // Planning reads a company's tasks by rank; the existing (company_id, state) index does not serve that ordering.
  await sql`create index tasks_company_priority_idx on public.tasks (company_id, priority asc nulls last)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Schema-qualified, matching `up` and the 0008 precedent: an unqualified drop resolves through search_path.
  await sql`drop index if exists public.tasks_company_priority_idx`.execute(db);
  await sql`alter table public.tasks drop constraint if exists tasks_priority_nonneg`.execute(db);
  await sql`alter table public.tasks drop constraint if exists tasks_task_type_valid`.execute(db);
  await db.schema.alterTable('tasks').dropColumn('priority').execute();
  await db.schema.alterTable('tasks').dropColumn('task_type').execute();
}
