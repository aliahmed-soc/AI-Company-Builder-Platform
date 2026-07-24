// ACBP-P2-005 — adaptive-orchestration columns on `interview_questions` (CDR-028 §6; DISC-002/006). ADDITIVE
// migration — migrations 0001–0017 are untouched, NO SECURITY DEFINER is added (allowlist stays three), no new
// role, no new grant (the table-level INSERT grant from 0013 already covers new columns), no backfill.
//
// Adds two columns to the immutable, append-only `interview_questions` table (set at INSERT, never updated):
//   - `rationale text` (nullable) — the "why we ask" explanation shown with each question (DISC-006); bounded.
//   - `source text NOT NULL DEFAULT 'adaptive'` with a CHECK in ('adaptive','static_fallback') — the honest
//     "flagged non-adaptive" marker for questions drawn from the static fallback bank on generation failure
//     (DISC-002; "Generation failure = flagged fallback"). The default keeps the P2-002 addInterviewQuestion
//     primitive backward-compatible.
//
// The existing dual-keyed FORCE-RLS policies (migration 0013) govern these columns too — no new policy, no UPDATE
// grant (the table stays immutable + append-only: a question never changes).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('interview_questions')
    .addColumn('rationale', 'text')
    .addColumn('source', 'text', (col) => col.notNull().defaultTo('adaptive'))
    .execute();
  await sql`alter table public.interview_questions add constraint interview_questions_source_valid check (source in ('adaptive', 'static_fallback'))`.execute(db);
  await sql`alter table public.interview_questions add constraint interview_questions_rationale_len check (rationale is null or char_length(rationale) between 1 and 1000)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table public.interview_questions drop constraint if exists interview_questions_rationale_len`.execute(db);
  await sql`alter table public.interview_questions drop constraint if exists interview_questions_source_valid`.execute(db);
  await db.schema.alterTable('interview_questions').dropColumn('source').dropColumn('rationale').execute();
}
