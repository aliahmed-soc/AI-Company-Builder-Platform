// ACBP-P5-011 — artifacts (CDR-060; TASK-005; NFR-014; ADR-016; trust-critical #2 prefix isolation).
//
// THE ROW IS THE ARTIFACT. An object in a bucket that no row points at is unreachable garbage; a row pointing at an
// object that was never written is a HOLLOW SUCCESS — the failure `FAILURE-AND-RECOVERY` row 7 and TASK-005 both name
// explicitly, and the worst one this system has, because every downstream reader believes it. The row is therefore
// written only AFTER the object write returns, in the same transaction as the task's completion.
//
// NUMBERED 0043, not 0041: `p5-014-credit-ledger` holds 0041 and 0042 on its own unmerged branch, and two branches
// blocked behind the same CI gate cannot both take 0041. This assumes P5-014 merges first; if that order changes,
// this file renumbers, which is safe precisely because it has never been applied anywhere.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('artifacts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    // THE OBJECT. Derived from the company prefix + the content hash — never caller-supplied (CDR-060 G2).
    .addColumn('object_key', 'text', (col) => col.notNull())
    .addColumn('content_hash', 'text', (col) => col.notNull())
    .addColumn('format', 'text', (col) => col.notNull())
    .addColumn('size_bytes', 'integer', (col) => col.notNull())
    // PROVENANCE, ALL REQUIRED (TASK-005; CDR-060 G6). An artifact whose origin is unknown cannot be trusted,
    // corrected or revised — so "unknown provenance" is not a state this table can represent.
    .addColumn('run_id', 'uuid', (col) => col.notNull())
    .addColumn('worker_id', 'text', (col) => col.notNull())
    .addColumn('worker_version', 'integer', (col) => col.notNull())
    .addColumn('model_version', 'text', (col) => col.notNull())
    .addColumn('title', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('artifacts_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('artifacts_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED composite: an artifact can only cite a run in its OWN company. RI checks always bypass RLS, so a
    // single-column FK would let provenance point across a tenant boundary and never be policy-checked.
    .addForeignKeyConstraint('artifacts_run_fk', ['run_id', 'company_id'], 'task_runs', ['id', 'company_id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('artifacts_format_valid', sql`format in ('markdown', 'json', 'text')`)
    // The IOQ-11 cap, at the database too. The contract enforces it for callers that go through the use case; this
    // enforces it for everything else, and 8 MiB is written in exactly one other place (CDR-060 §3).
    .addCheckConstraint('artifacts_size_bounded', sql`size_bytes > 0 and size_bytes <= 8388608`)
    // A sha256, lowercase hex. The same shape the contract validates, so a row cannot exist that the contract would
    // have refused.
    .addCheckConstraint('artifacts_content_hash_shape', sql`content_hash ~ '^[0-9a-f]{64}$'`)
    // PREFIX ISOLATION, ENFORCED BY THE ROW (trust-critical #2). The key must literally begin with this company's
    // prefix, and may not contain `..`.
    //
    // THE SECOND CLAUSE IS NOT DECORATION. Review pass 1 caught the first version of this constraint claiming that
    // "a tampered value fails here" while checking only the prefix — and `company/<id>/../../other/x` satisfies a
    // prefix test perfectly. LIKE does not understand paths, so without the traversal clause the constraint would
    // have been a claim STATED and not ENFORCED, which is the failure this table exists to make impossible.
    //
    // It remains a BACKSTOP, not the primary defence: `companyObjectKey` refuses unsafe segments at construction and
    // `verifyKeyBelongsToCompany` re-validates every segment at use. This is the layer that catches a key which
    // reached an INSERT without passing either.
    .addCheckConstraint('artifacts_key_is_company_prefixed', sql`object_key like 'company/' || lower(company_id::text) || '/%' and position('..' in object_key) = 0`)
    .addCheckConstraint('artifacts_provenance_present', sql`btrim(worker_id) <> '' and btrim(model_version) <> '' and worker_version >= 1`)
    .addCheckConstraint('artifacts_title_present', sql`btrim(title) <> '' and length(title) <= 500`)
    .execute();

  // CONTENT-ADDRESSED IDEMPOTENCE (the backlog's rollback column), keyed on the RUN as well as the content.
  //
  // The obvious key is `(company_id, content_hash)` — one row per distinct content. It is WRONG, and wrong in the
  // direction that matters: if run B produces byte-identical output to an earlier run A, the conflict hands B back
  // A's row, and the artifact now claims run A produced something run B produced. That is provenance (G6) STATED but
  // not ENFORCED — a lie the revision workflow (P5-012) would read as truth.
  //
  // Keying on the run keeps both properties. A retry of the SAME run re-writing the same bytes still collapses to one
  // row, which is the idempotence `FAILURE-AND-RECOVERY` row 7 asks for; a DIFFERENT run producing identical bytes
  // gets its own row with its own honest provenance, pointing at the same object — which costs nothing, because a
  // content-addressed object write of identical bytes to an identical key is already a no-op.
  await sql`create unique index artifacts_company_content_run_uq on public.artifacts (company_id, content_hash, run_id)`.execute(db);
  await sql`create index artifacts_run_idx on public.artifacts (run_id)`.execute(db);
  await sql`create index artifacts_company_created_idx on public.artifacts (company_id, created_at desc)`.execute(db);

  // LEAST PRIVILEGE. SELECT + INSERT only — an artifact is a record that a worker produced something, and rewriting
  // it would break the provenance it exists to carry. NO UPDATE, NO DELETE: a superseded artifact is a NEW row
  // (P5-012's revision lineage), never an edit of the old one.
  await sql`grant select, insert on public.artifacts to ${APP_ROLE}`.execute(db);

  await sql`alter table public.artifacts enable row level security`.execute(db);
  await sql`alter table public.artifacts force row level security`.execute(db);
  await sql`create policy artifacts_select on public.artifacts for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy artifacts_insert on public.artifacts for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists artifacts_insert on public.artifacts`.execute(db);
  await sql`drop policy if exists artifacts_select on public.artifacts`.execute(db);
  await sql`revoke all on public.artifacts from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.artifacts_company_created_idx`.execute(db);
  await sql`drop index if exists public.artifacts_run_idx`.execute(db);
  await sql`drop index if exists public.artifacts_company_content_run_uq`.execute(db);
  await db.schema.dropTable('artifacts').ifExists().execute();
}
