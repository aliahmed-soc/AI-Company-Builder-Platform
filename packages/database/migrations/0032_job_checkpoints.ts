// ACBP-P5-001b — checkpoints, so a killed job resumes instead of re-running work (CDR-050; ADR-008; NFR-005).
//
// A CHECKPOINT RECORDS THAT A STEP COMPLETED, not that progress was made (CDR-050 §2-G1). Canon's "steps idempotent by
// checkpoint design" (FAILURE-AND-RECOVERY row 12) only holds if the PRESENCE of a checkpoint is what makes
// re-execution unnecessary — "we got this far" would still leave a reader guessing whether the effect landed.
//
// Company-owned and dual-keyed exactly like `jobs` (CDR-049): the tenancy argument is not repeated here, it is
// inherited. No new SECURITY DEFINER (the closed allowlist stays three), no new role, no policy change to any
// existing table.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // `jobs` needs an additive (id, company_id) UNIQUE so the child FK can be TENANT-PINNED. RI checks ALWAYS bypass
  // RLS, so a single-column FK to `jobs.id` would let a checkpoint reference ANOTHER company's job and the reference
  // itself would never be policy-checked. The composite FK below makes that structurally impossible.
  await sql`alter table public.jobs add constraint jobs_id_company_uq unique (id, company_id)`.execute(db);

  await db.schema
    .createTable('job_checkpoints')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('job_id', 'uuid', (col) => col.notNull())
    // The step this checkpoint completes. Bounded text rather than a closed DB set: steps belong to job KINDS, and
    // adding a step must not be a migration — the `jobs.kind` precedent (CDR-049 §4).
    .addColumn('step_name', 'text', (col) => col.notNull())
    // What the step produced, for a later step that needs it. REFERENCES, NEVER SECRETS (ADR-008 §11), same bound as
    // `jobs.payload`. Nullable because most steps produce nothing a successor needs.
    .addColumn('output', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('job_checkpoints_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('job_checkpoints_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED composite (see the UNIQUE above): a checkpoint can only reference a job in its OWN company.
    .addForeignKeyConstraint('job_checkpoints_job_fk', ['job_id', 'company_id'], 'jobs', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // A STEP COMPLETES ONCE (CDR-050 §2-G2). This is what makes a duplicate completion the SAME FACT rather than a
    // second row, so the crash-between-effect-and-record race resolves at the database instead of in a
    // check-then-insert that would itself race.
    .addUniqueConstraint('job_checkpoints_step_uq', ['job_id', 'step_name'])
    .addCheckConstraint('job_checkpoints_step_len', sql`char_length(step_name) between 1 and 100`)
    .addCheckConstraint('job_checkpoints_output_bounded', sql`output is null or pg_column_size(output) <= 65536`)
    .execute();

  // Resume reads a job's checkpoints in plan order; the unique constraint already indexes (job_id, step_name), so
  // this covers the "everything for this job" read without duplicating that.
  await sql`create index job_checkpoints_job_created_idx on public.job_checkpoints (job_id, created_at)`.execute(db);

  // APPEND-ONLY. SELECT + INSERT and nothing else: a completed step is a fact about the past, so there is no
  // legitimate UPDATE, and a DELETE would let the code that failed erase the evidence that it had already run —
  // which is exactly the double-execution this sub-scope exists to prevent.
  await sql`grant select, insert on public.job_checkpoints to ${APP_ROLE}`.execute(db);

  await sql`alter table public.job_checkpoints enable row level security`.execute(db);
  await sql`alter table public.job_checkpoints force row level security`.execute(db);
  await sql`create policy job_checkpoints_select on public.job_checkpoints for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy job_checkpoints_insert on public.job_checkpoints for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists job_checkpoints_insert on public.job_checkpoints`.execute(db);
  await sql`drop policy if exists job_checkpoints_select on public.job_checkpoints`.execute(db);
  await sql`revoke all on public.job_checkpoints from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.job_checkpoints_job_created_idx`.execute(db);
  await db.schema.dropTable('job_checkpoints').ifExists().execute();
  // Dropped only after the child is gone, since the composite FK depends on it.
  await sql`alter table public.jobs drop constraint if exists jobs_id_company_uq`.execute(db);
}
