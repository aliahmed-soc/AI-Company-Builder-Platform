// ACBP-P5-012 — artifact revisions (CDR-064; TASK-005 lineage; J-13; ADR-016).
//
// A REVISION IS NOT AN EDIT. ADR-016 §5: "new version per revision, lineage-linked; no destructive overwrite."
// `AI-AND-WORKER-ARCHITECTURE.md:13`: revisions "create lineage-linked new runs." So this table records a REQUEST for
// new work — what was being revised, what to change, and the run started to do it — and never touches the original.
//
// "Original never overwritten" needs no enforcement here and gets none: `artifacts` has NO UPDATE grant at all, not
// even column-level (CDR-060). This migration deliberately does not add one.
//
// LINEAGE LIVES IN EXACTLY ONE PLACE (CDR-064 G1). There is no `revision_of_artifact_id` column on `artifacts`: an
// artifact is a revision of the original BECAUSE its `run_id` is the run named here. A column would put the same fact
// in two places that can disagree, and a revision run that wrote three artifacts would need it set correctly three
// times — the one that was missed becoming a document with no visible ancestor.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // A composite FK requires a UNIQUE on exactly the referenced columns. `artifacts` is keyed on `id` alone, so the
  // tenant-pinned reference below needs this. Additive and index-only — no column, constraint or grant on `artifacts`
  // changes, which keeps that table's append-only posture exactly as P5-011 shipped it.
  await sql`create unique index artifacts_id_company_uq on public.artifacts (id, company_id)`.execute(db);

  await db.schema
    .createTable('artifact_revisions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    // WHAT is being revised, and WHICH RUN was started to revise it. Both required: a revision request that names
    // neither end is not lineage, and "lineage audited" is this ticket's stated audit behaviour.
    .addColumn('original_artifact_id', 'uuid', (col) => col.notNull())
    .addColumn('run_id', 'uuid', (col) => col.notNull())
    // The founder's instruction. REQUIRED — a revision with nothing to change is a re-run wearing a revision's name,
    // and it costs a credit for the same output (CDR-064 G7).
    .addColumn('guidance', 'text', (col) => col.notNull())
    .addColumn('idempotency_key', 'text', (col) => col.notNull())
    .addColumn('requested_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('artifact_revisions_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('artifact_revisions_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED, both of them. RI checks ALWAYS bypass RLS, so a single-column FK would let a revision cite an
    // artifact — or a run — belonging to another company and never be policy-checked. This is the same reasoning that
    // pinned `artifacts.run_id`, and it matters more here: the whole value of the row is that it links two things,
    // and a link that can cross a tenant boundary is worse than no link.
    .addForeignKeyConstraint('artifact_revisions_original_fk', ['original_artifact_id', 'company_id'], 'artifacts', ['id', 'company_id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    .addForeignKeyConstraint('artifact_revisions_run_fk', ['run_id', 'company_id'], 'task_runs', ['id', 'company_id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    // CHARACTERS, not bytes, matching `REVISION_GUIDANCE_MAX` in the contract. `char_length` counts characters;
    // `octet_length` would refuse a shorter piece of Arabic or emoji prose than of English, which is a silent penalty
    // on non-Latin scripts rather than a real limit. A row the contract would have refused cannot exist.
    .addCheckConstraint('artifact_revisions_guidance_present', sql`btrim(guidance) <> '' and char_length(guidance) <= 2000`)
    // A blank key is not a key. P5-003b and P5-014 both paid for the opposite: an empty string accepted as a real key
    // makes unrelated calls collide, and for a metered operation that means one founder's revision answering another's.
    .addCheckConstraint('artifact_revisions_key_present', sql`btrim(idempotency_key) <> ''`)
    // ONE REQUEST PER KEY (CDR-064 G3), as a REAL NAMED CONSTRAINT rather than a partial unique index.
    //
    // This differs from P5-014's reservation key deliberately, and the difference is that `idempotency_key` is NOT
    // NULL here. There, only reservations carried a key, so the guard HAD to be partial (`WHERE kind = 'reservation'
    // AND idempotency_key IS NOT NULL`) — and PostgreSQL unique CONSTRAINTS cannot be partial, which is exactly how
    // D1 happened: `ON CONFLICT ON CONSTRAINT` named an INDEX and raised 42704 on every reservation. Here the
    // predicate is unnecessary, so a real constraint is available, and a real constraint is strictly better: it is a
    // legal `ON CONFLICT ON CONSTRAINT` target and the whole D1 class cannot arise.
    //
    // Scoped to the COMPANY, not the account: the operation is company-scoped and the RLS is dual-keyed, so a key
    // means "this request, in the company I am acting in". Account-scoping would refuse a second company's legitimate
    // reuse of a client-chosen string.
    .addUniqueConstraint('artifact_revisions_company_key_uq', ['company_id', 'idempotency_key'])
    .execute();

  // The lineage lookup: "what revisions were asked of this artifact", and the reverse "what was this run revising".
  await sql`create index artifact_revisions_original_idx on public.artifact_revisions (original_artifact_id)`.execute(db);
  await sql`create unique index artifact_revisions_run_uq on public.artifact_revisions (run_id)`.execute(db);
  await sql`create index artifact_revisions_company_created_idx on public.artifact_revisions (company_id, created_at desc)`.execute(db);

  // LEAST PRIVILEGE. SELECT + INSERT only — no UPDATE, no DELETE. A revision request is a record that the owner asked
  // for something at a moment in time; editing it would rewrite the reason a run exists, which is the one thing the
  // lineage must be able to carry honestly.
  await sql`grant select, insert on public.artifact_revisions to ${APP_ROLE}`.execute(db);

  await sql`alter table public.artifact_revisions enable row level security`.execute(db);
  await sql`alter table public.artifact_revisions force row level security`.execute(db);
  await sql`create policy artifact_revisions_select on public.artifact_revisions for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy artifact_revisions_insert on public.artifact_revisions for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists artifact_revisions_insert on public.artifact_revisions`.execute(db);
  await sql`drop policy if exists artifact_revisions_select on public.artifact_revisions`.execute(db);
  await sql`revoke all on public.artifact_revisions from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.artifact_revisions_company_created_idx`.execute(db);
  await sql`drop index if exists public.artifact_revisions_run_uq`.execute(db);
  await sql`drop index if exists public.artifact_revisions_original_idx`.execute(db);
  await db.schema.dropTable('artifact_revisions').ifExists().execute();
  await sql`drop index if exists public.artifacts_id_company_uq`.execute(db);
}
