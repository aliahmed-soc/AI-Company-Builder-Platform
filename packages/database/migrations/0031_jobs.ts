// ACBP-P5-001a — the durable job store (CDR-049 §4; ADR-008; NFR-005/007; invariant 3, trust-critical #3).
//
// WE OWN THIS TABLE, and that is the load-bearing decision (CDR-049 §2). ADR-008 names a "pg-boss/graphile-worker
// class" runner, and those libraries manage their own DDL — a table we do not own could not carry a NOT NULL tenant
// stamp, dual-keyed FORCE RLS, or the refusal this sub-scope exists to deliver. The owner's ADR-008 amendment makes
// it binding: "job tables remain standard SQL (exit path)", and §13 adds that job semantics are
// "library-independent design". A runner may later POLL this table; it may not own it.
//
// NO SECURITY DEFINER is added (the closed allowlist stays exactly three), no new role, and no policy change to any
// existing table.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('jobs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // TENANT CONTEXT IS MANDATORY (ADR-008 §5; invariant 3). NOT NULL is the first of three deliberately redundant
    // layers (CDR-049 §3-G3): it catches code that forgets the fields entirely. It cannot catch a caller supplying
    // ANOTHER tenant's ids — that is what the dual-keyed WITH CHECK below is for.
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    // NOT NULL rather than nullable-for-possible-account-jobs (§3-G4): a nullable column makes "no company" a legal
    // state the moment anything writes NULL, which is precisely the defaulting this table forbids.
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    // What work this job represents. Bounded here; the CLOSED set is validated at the use-case layer, so adding a
    // job type is not a migration.
    .addColumn('kind', 'text', (col) => col.notNull())
    .addColumn('state', 'text', (col) => col.notNull().defaultTo('queued'))
    // REFERENCES, NEVER SECRETS (ADR-008 §11). Bounded so a runaway payload cannot become a storage incident.
    .addColumn('payload', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    // Attempt counter. Declared now though P5-001c owns the retry cap — see the state-set note below.
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    // TASK-009/NFR-006: the same logical job enqueued twice is ONE row. Nullable, because not every job is
    // deduplicable; unique per company WHEN PRESENT, via the partial index below.
    .addColumn('idempotency_key', 'text')
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('jobs_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('jobs_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('jobs_actor_fk', ['created_by_user_id'], 'users', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    // The CLOSED state set, including `dead_letter` from the start even though P5-001c implements REACHING it
    // (CDR-049 §4-G6). A state added later by migration is a state the earlier code never handled; declaring it now
    // costs nothing and lets b/c extend behaviour rather than reshape the table.
    .addCheckConstraint('jobs_state_valid', sql`state in ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')`)
    .addCheckConstraint('jobs_kind_len', sql`char_length(kind) between 1 and 100`)
    .addCheckConstraint('jobs_attempts_nonneg', sql`attempts >= 0`)
    // A bounded payload. 64 KiB is far beyond any reference-carrying payload and far below anything that would make
    // the job table a content store — ADR-008 §11 is explicit that payloads carry references, not content.
    .addCheckConstraint('jobs_payload_bounded', sql`pg_column_size(payload) <= 65536`)
    .addCheckConstraint('jobs_idempotency_len', sql`idempotency_key is null or char_length(idempotency_key) between 1 and 200`)
    .execute();

  // Idempotency is per COMPANY, not global: two tenants may legitimately choose the same key, and a global unique
  // would let one company's key collide with — and therefore reveal the existence of — another's.
  await sql`create unique index jobs_company_idempotency_uq on public.jobs (company_id, idempotency_key) where idempotency_key is not null`.execute(db);
  // The runner's pickup path: oldest queued work per company first.
  await sql`create index jobs_company_state_created_idx on public.jobs (company_id, state, created_at)`.execute(db);

  // LEAST PRIVILEGE. SELECT + INSERT, plus a COLUMN-SCOPED update of exactly the mutable lifecycle columns — the
  // `tasks` precedent. Identity, tenancy, kind, payload and provenance are immutable to the app role, so a job
  // cannot be re-pointed at another tenant or have its work swapped after enqueue.
  //
  // NO DELETE (CDR-049 §4-G5): job history is the run trail the ticket's "Run trail audited" behaviour depends on.
  // Archival is a later deliberate operation, not a routine capability.
  await sql`grant select, insert on public.jobs to ${APP_ROLE}`.execute(db);
  await sql`grant update (state, updated_at, attempts) on public.jobs to ${APP_ROLE}`.execute(db);

  await sql`alter table public.jobs enable row level security`.execute(db);
  await sql`alter table public.jobs force row level security`.execute(db);
  await sql`create policy jobs_select on public.jobs for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  // The SECOND refusal layer (CDR-049 §3-G3): an insert must match BOTH GUCs. This is what catches a caller who
  // supplies a well-formed but FOREIGN pair of ids — something NOT NULL can never see.
  await sql`create policy jobs_insert on public.jobs for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy jobs_update on public.jobs for update using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY}) with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists jobs_update on public.jobs`.execute(db);
  await sql`drop policy if exists jobs_insert on public.jobs`.execute(db);
  await sql`drop policy if exists jobs_select on public.jobs`.execute(db);
  await sql`revoke all on public.jobs from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.jobs_company_state_created_idx`.execute(db);
  await sql`drop index if exists public.jobs_company_idempotency_uq`.execute(db);
  await db.schema.dropTable('jobs').ifExists().execute();
}
