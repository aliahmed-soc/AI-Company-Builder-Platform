// ACBP-P2-002 — interview questions + answers (CDR-023; DISC-008 persistence; DATA-ARCHITECTURE
// Question/Answer). ADDITIVE expand migration — migrations 0001–0012 are untouched, NO SECURITY DEFINER
// function is added (the closed allowlist stays exactly three), and no existing table/policy changes.
//
// Two company-owned, dual-keyed tables hanging off the P2-001 interview session:
//
//   - `interview_questions` — the IMMUTABLE question rows (DATA-ARCHITECTURE Question `I`). Ordered within a
//     session (`unique (session_id, position)`). Grants are SELECT + INSERT only — no UPDATE/DELETE — so a
//     question row can never change; its `answered/skipped` lifecycle is DERIVED from the answers, never a
//     mutable column.
//   - `interview_answers` — the APPEND-ONLY answer rows (DATA-ARCHITECTURE Answer `A`; "given→revised(new
//     row)"). Composite PK `(question_id, revision)` serializes concurrent writers (loser retries), giving
//     last-write-wins with a visible history; the current answer is `max(revision)` per question. Grants are
//     SELECT + INSERT only — a revision is a NEW row, never an in-place edit (the `company_profiles`
//     append-only precedent).
//
// Both are dual-keyed under FORCE RLS (account AND company must match) and reference `interview_sessions` +
// `companies` + `accounts`. No backfill (existing sessions have no Q&A until the app records some), so no
// BYPASSRLS guard is needed.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** Restricted application role name (an object identifier, not a secret) — created in migration 0005. */
const APP_ROLE = sql.ref('acbp_app');

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── 1) interview_questions — immutable, ordered per session ───────────────────────────────────────────────
  await db.schema
    .createTable('interview_questions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('session_id', 'uuid', (col) => col.notNull())
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('position', 'integer', (col) => col.notNull())
    .addColumn('prompt', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('interview_questions_session_fk', ['session_id'], 'interview_sessions', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('interview_questions_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('interview_questions_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addCheckConstraint('interview_questions_position_positive', sql`position >= 1`)
    .addCheckConstraint('interview_questions_prompt_len', sql`char_length(prompt) between 1 and 4000`)
    // Ordered + gap-checked at the app layer; unique position per session (no two questions share a slot).
    .addUniqueConstraint('interview_questions_session_position_uk', ['session_id', 'position'])
    .execute();
  await sql`create index interview_questions_session_idx on public.interview_questions (session_id, position)`.execute(db);

  // ── 2) interview_answers — append-only revisions, PK (question_id, revision) ──────────────────────────────
  await db.schema
    .createTable('interview_answers')
    .addColumn('question_id', 'uuid', (col) => col.notNull())
    .addColumn('revision', 'integer', (col) => col.notNull())
    .addColumn('session_id', 'uuid', (col) => col.notNull())
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('content', 'text')
    .addColumn('created_by_user_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('interview_answers_pk', ['question_id', 'revision'])
    .addForeignKeyConstraint('interview_answers_question_fk', ['question_id'], 'interview_questions', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('interview_answers_session_fk', ['session_id'], 'interview_sessions', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('interview_answers_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('interview_answers_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('interview_answers_author_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('interview_answers_revision_positive', sql`revision >= 1`)
    .addCheckConstraint('interview_answers_status_valid', sql`status in ('answered', 'skipped')`)
    // Shape: an answered row carries non-empty bounded content; a skipped row carries NO content.
    .addCheckConstraint('interview_answers_content_shape', sql`(status = 'answered' and content is not null and char_length(content) between 1 and 10000) or (status = 'skipped' and content is null)`)
    .execute();
  await sql`create index interview_answers_question_idx on public.interview_answers (question_id, revision desc)`.execute(db);

  // ── 3) Least-privilege grants: SELECT + INSERT only on BOTH (append-only / immutable). No UPDATE/DELETE. ──
  await sql`grant select, insert on public.interview_questions to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert on public.interview_answers to ${APP_ROLE}`.execute(db);

  // ── 4) Enable + FORCE RLS ─────────────────────────────────────────────────────────────────────────────────
  for (const t of ['interview_questions', 'interview_answers'] as const) {
    await sql`alter table public.${sql.ref(t)} enable row level security`.execute(db);
    await sql`alter table public.${sql.ref(t)} force row level security`.execute(db);
  }

  // ── 5) Dual-keyed fail-closed policies (select/insert only — append-only, no update/delete policy) ────────
  for (const t of ['interview_questions', 'interview_answers'] as const) {
    await sql`
      create policy ${sql.ref(`${t}_select`)} on public.${sql.ref(t)} for select
        using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
    `.execute(db);
    await sql`
      create policy ${sql.ref(`${t}_insert`)} on public.${sql.ref(t)} for insert
        with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of ['interview_answers', 'interview_questions'] as const) {
    await sql`drop policy if exists ${sql.ref(`${t}_select`)} on public.${sql.ref(t)}`.execute(db);
    await sql`drop policy if exists ${sql.ref(`${t}_insert`)} on public.${sql.ref(t)}`.execute(db);
    await sql`revoke all on public.${sql.ref(t)} from ${APP_ROLE}`.execute(db);
  }
  // Drop answers first (FK → questions).
  await db.schema.dropTable('interview_answers').ifExists().execute();
  await db.schema.dropTable('interview_questions').ifExists().execute();
}
