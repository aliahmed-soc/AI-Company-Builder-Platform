// ACBP-P5-014 — link a usage event to the worker run that caused it (CDR-058 §4; CDR-057 §4 deferred this HERE).
//
// ALTER-ONLY and additive. `usage_events` is append-only (invariant 9) and this adds a nullable column plus a
// constraint; no existing row changes, and no grant changes — the table-level INSERT already covers a new column.
//
// WHY THE UNIQUE ON `worker_runs` FIRST: a composite FK needs a unique constraint on the exact parent columns. The
// primary key is `id` alone, so `(id, company_id)` has to exist before anything can reference the pair. It is
// additive and redundant with the PK for uniqueness purposes — its job is to be a legal FK target, which is what
// lets the reference carry the tenant with it.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table public.worker_runs add constraint worker_runs_id_company_uq unique (id, company_id)`.execute(db);
  await sql`alter table public.usage_events add column worker_run_id uuid`.execute(db);
  // TENANT-PINNED. RI checks always bypass RLS, so a single-column FK would let a usage event point at another
  // company's worker run and never be policy-checked. `usage_events.company_id` is NOT NULL, so the composite is
  // always fully specified when `worker_run_id` is set and MATCH SIMPLE cannot skip it.
  await sql`
    alter table public.usage_events
    add constraint usage_events_worker_run_fk
    foreign key (worker_run_id, company_id) references public.worker_runs (id, company_id)
  `.execute(db);
  // "What did this worker run cost?" — the read this link exists to make answerable.
  await sql`create index usage_events_worker_run_idx on public.usage_events (worker_run_id) where worker_run_id is not null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists public.usage_events_worker_run_idx`.execute(db);
  await sql`alter table public.usage_events drop constraint if exists usage_events_worker_run_fk`.execute(db);
  await sql`alter table public.usage_events drop column if exists worker_run_id`.execute(db);
  await sql`alter table public.worker_runs drop constraint if exists worker_runs_id_company_uq`.execute(db);
}
