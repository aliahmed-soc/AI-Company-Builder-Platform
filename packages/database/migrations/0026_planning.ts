// ACBP-P4-001 — goals, roadmap and milestones (CDR-039 §3; ROAD-001/002; DATA-ARCHITECTURE §Goal/Roadmap/Milestone).
// ADDITIVE migration — migrations 0001–0025 are untouched, NO SECURITY DEFINER is added (the closed allowlist stays
// exactly three), no new role, no policy change. The ONE change to an existing table is additive and reversed by
// `down()`: a foreign key tying `tasks.milestone_id` to the milestones this migration creates (see below).
//
// Four company-owned, dual-keyed FORCE-RLS tables, all SELECT + INSERT only:
//   - `roadmaps`   — VERSIONED append-only (the understanding_documents 0019 pattern). A new version is a NEW ROW,
//                    never an in-place edit, which is what makes ROAD-002's "version write failure blocks the edit
//                    rather than losing history" structural rather than procedural.
//   - `goals`      — immutable; ordinal-sequenced within a roadmap version.
//   - `milestones` — immutable; ordinal-sequenced (ROAD-001 "target sequencing" — ORDER only, never invented dates,
//                    ADR-019). MAY name the goal it serves, pinned to the same roadmap version by a composite FK.
//   - `task_review_flags` — immutable; ROAD-002 "changes flag affected tasks". A separate append-only table rather
//                    than a column on `tasks`, because `tasks` grants only UPDATE(state, updated_at) and the
//                    adversarial catalog suite pins that exact grant set.
//
// Roadmap CONTENT stays in Postgres: ADR-016 (generated-artifact object storage) is blocked on the provider selection
// (ACBP-P0-005 / IOQ-05), so depending on it here would make this ticket owner-gated. Adopting it later is additive.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

const TABLES = ['roadmaps', 'goals', 'milestones', 'task_review_flags'] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── roadmaps (versioned append-only; one version per row) ────────────────────────────────────────────────
  await db.schema
    .createTable('roadmaps')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull())
    // The DECISION this plan derives from (J-08 "decision recorded before any planning"). Pinning it makes the
    // planning gate auditable after the fact and realizes DATA-ARCHITECTURE's "Roadmap … from Decision".
    .addColumn('decision_id', 'uuid', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('origin', 'text', (col) => col.notNull())
    .addColumn('supersedes_roadmap_id', 'uuid')
    .addColumn('edit_reason', 'text')
    .addColumn('model_flagged_partial', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('roadmaps_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('roadmaps_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('roadmaps_decision_fk', ['decision_id'], 'decisions', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('roadmaps_supersedes_fk', ['supersedes_roadmap_id'], 'roadmaps', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('roadmaps_actor_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addUniqueConstraint('roadmaps_company_version_uq', ['company_id', 'version'])
    .addCheckConstraint('roadmaps_version_positive', sql`version >= 1`)
    .addCheckConstraint('roadmaps_status_valid', sql`status in ('complete', 'partial')`)
    .addCheckConstraint('roadmaps_origin_valid', sql`origin in ('generated', 'edited')`)
    // ROAD-002 "record rationale": an EDITED version must carry a non-blank bounded reason; a GENERATED version must
    // carry none (a model generation has no owner rationale to record).
    .addCheckConstraint(
      'roadmaps_edit_reason_shape',
      sql`(origin = 'generated' and edit_reason is null) or (origin = 'edited' and edit_reason is not null and char_length(edit_reason) between 1 and 4000)`,
    )
    // Version 1 supersedes nothing; every later version must name what it supersedes (an unbroken history chain).
    .addCheckConstraint('roadmaps_supersedes_shape', sql`(version = 1 and supersedes_roadmap_id is null) or (version > 1 and supersedes_roadmap_id is not null)`)
    .execute();
  await sql`create index roadmaps_company_version_idx on public.roadmaps (company_id, version desc)`.execute(db);

  // ── goals (immutable; belong to one roadmap version) ─────────────────────────────────────────────────────
  await db.schema
    .createTable('goals')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('roadmap_id', 'uuid', (col) => col.notNull())
    .addColumn('ordinal', 'integer', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('goals_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('goals_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('goals_roadmap_fk', ['roadmap_id'], 'roadmaps', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addUniqueConstraint('goals_ordinal_uq', ['roadmap_id', 'ordinal'])
    // Additive, purely so the milestone composite FK below can reference it (the 0023/0025 trick); `id` is already the
    // PK, so the pair is trivially unique.
    .addUniqueConstraint('goals_id_roadmap_uq', ['id', 'roadmap_id'])
    .addCheckConstraint('goals_ordinal_nonneg', sql`ordinal >= 0`)
    .addCheckConstraint('goals_title_len', sql`char_length(title) between 1 and 200`)
    .addCheckConstraint('goals_description_len', sql`description is null or char_length(description) between 1 and 4000`)
    .addCheckConstraint('goals_status_valid', sql`status in ('active', 'achieved', 'dropped')`)
    .execute();
  await sql`create index goals_roadmap_idx on public.goals (roadmap_id, ordinal)`.execute(db);

  // ── milestones (immutable; ordinal = ROAD-001 "target sequencing", order only — never dates) ─────────────
  await db.schema
    .createTable('milestones')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('roadmap_id', 'uuid', (col) => col.notNull())
    .addColumn('goal_id', 'uuid')
    .addColumn('ordinal', 'integer', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('planned'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('milestones_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('milestones_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('milestones_roadmap_fk', ['roadmap_id'], 'roadmaps', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // COMPOSITE FK: a named goal must belong to THIS roadmap version — a milestone can never point at a goal from a
    // different version. A NULL goal_id (an unlinked milestone) skips the check (MATCH SIMPLE).
    .addForeignKeyConstraint('milestones_goal_fk', ['goal_id', 'roadmap_id'], 'goals', ['id', 'roadmap_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addUniqueConstraint('milestones_ordinal_uq', ['roadmap_id', 'ordinal'])
    .addCheckConstraint('milestones_ordinal_nonneg', sql`ordinal >= 0`)
    .addCheckConstraint('milestones_title_len', sql`char_length(title) between 1 and 200`)
    .addCheckConstraint('milestones_description_len', sql`description is null or char_length(description) between 1 and 4000`)
    .addCheckConstraint('milestones_status_valid', sql`status in ('planned', 'reached', 'dropped')`)
    .execute();
  await sql`create index milestones_roadmap_idx on public.milestones (roadmap_id, ordinal)`.execute(db);

  // ── task_review_flags (immutable; ROAD-002 "changes flag affected tasks") ────────────────────────────────
  await db.schema
    .createTable('task_review_flags')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('task_id', 'uuid', (col) => col.notNull())
    // The NEW roadmap version whose creation flagged this task.
    .addColumn('roadmap_id', 'uuid', (col) => col.notNull())
    .addColumn('reason', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('task_review_flags_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_review_flags_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_review_flags_task_fk', ['task_id'], 'tasks', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('task_review_flags_roadmap_fk', ['roadmap_id'], 'roadmaps', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // A re-flag for the same version is idempotent rather than a duplicate row.
    .addUniqueConstraint('task_review_flags_task_roadmap_uq', ['task_id', 'roadmap_id'])
    .addCheckConstraint('task_review_flags_reason_len', sql`reason is null or char_length(reason) between 1 and 4000`)
    .execute();
  await sql`create index task_review_flags_task_idx on public.task_review_flags (task_id, created_at desc)`.execute(db);

  // ── ADDITIVE constraint on an EXISTING table ────────────────────────────────────────────────────────────
  // ROAD-001 requires that "generated tasks trace to milestones". `tasks.milestone_id` (0021) has carried no FK and no
  // validation because milestones did not exist yet — the P4-002 review recorded this and flagged it for P4-001.
  // ON DELETE SET NULL runs as the table OWNER, so the app role's deliberately absent UPDATE(milestone_id) grant is not
  // an obstacle: dropping a roadmap version orphans its tasks' milestone link rather than deleting the tasks.
  await sql`alter table public.tasks add constraint tasks_milestone_fk foreign key (milestone_id) references public.milestones(id) on delete set null`.execute(db);

  // Least-privilege grants: SELECT + INSERT only on all four (immutable/append-only — no UPDATE, no DELETE).
  for (const t of TABLES) {
    await sql`grant select, insert on ${sql.ref(`public.${t}`)} to ${APP_ROLE}`.execute(db);
    await sql`alter table ${sql.ref(`public.${t}`)} enable row level security`.execute(db);
    await sql`alter table ${sql.ref(`public.${t}`)} force row level security`.execute(db);
    await sql`create policy ${sql.ref(`${t}_select`)} on ${sql.ref(`public.${t}`)} for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
    await sql`create policy ${sql.ref(`${t}_insert`)} on ${sql.ref(`public.${t}`)} for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop the constraint on the pre-existing table FIRST, so `milestones` is droppable.
  await sql`alter table public.tasks drop constraint if exists tasks_milestone_fk`.execute(db);
  for (const t of TABLES) {
    for (const suffix of ['select', 'insert'] as const) {
      await sql`drop policy if exists ${sql.ref(`${t}_${suffix}`)} on ${sql.ref(`public.${t}`)}`.execute(db);
    }
    await sql`revoke all on ${sql.ref(`public.${t}`)} from ${APP_ROLE}`.execute(db);
  }
  // FK-safe drop order: flags → milestones → goals → roadmaps.
  await db.schema.dropTable('task_review_flags').ifExists().execute();
  await db.schema.dropTable('milestones').ifExists().execute();
  await db.schema.dropTable('goals').ifExists().execute();
  await db.schema.dropTable('roadmaps').ifExists().execute();
}
