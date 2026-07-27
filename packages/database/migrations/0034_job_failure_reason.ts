// ACBP-P5-001c — the dead-letter reason (CDR-052; NFR-007; ADR-008).
//
// ALTER-ONLY, and that is the point worth noticing: `attempts` and the `dead_letter` state were both declared up
// front by 0031 (CDR-049 §4-G6), so this sub-scope adds ONE nullable column and changes no grant, no policy and no
// state set. Declaring the terminal state before anything could reach it is what made the retry work additive.
//
// `failure_reason` is nullable and its CHECK is ONE-DIRECTIONAL — a reason implies dead_letter, but dead_letter does
// not require a reason. The symmetric constraint is tempting and would pass in CI, where the schema is rebuilt every
// run; it would fail on the first real deployment carrying history, because rows dead-lettered before this migration
// have no reason to supply. That is the P5-009 lesson (migration 0030), applied deliberately rather than rediscovered.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('jobs').addColumn('failure_reason', 'text').execute();

  // A CLOSED category set, mirroring JOB_FAILURE_REASONS in @acbp/contracts. Never provider exception text: this
  // value is rendered in the Decision Room blocked queue, so an open string would put arbitrary provider output —
  // potentially including connection strings or payload fragments — onto a human-facing surface.
  await sql`alter table public.jobs add constraint jobs_failure_reason_valid
    check (failure_reason is null or failure_reason in ('attempts_exhausted', 'timeout', 'provider_error', 'invalid_payload', 'cancelled', 'internal_error'))`.execute(db);

  // ONE-DIRECTIONAL (see the header). A reason may only accompany a dead-lettered job; a dead-lettered job need not
  // carry one, so pre-existing history stays legal.
  await sql`alter table public.jobs add constraint jobs_failure_reason_requires_dead_letter
    check (failure_reason is null or state = 'dead_letter')`.execute(db);

  // The column must be writable for the transition to be recordable at all. This EXTENDS the existing column-scoped
  // grant rather than widening it to the whole row — tenancy, kind and payload stay immutable to the app role
  // exactly as CDR-049 §4 requires.
  await sql`grant update (failure_reason) on public.jobs to ${sql.ref('acbp_app')}`.execute(db);

  // The Decision Room blocked queue reads dead-lettered jobs per company, newest first.
  await sql`create index jobs_dead_letter_idx on public.jobs (company_id, updated_at desc) where state = 'dead_letter'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists public.jobs_dead_letter_idx`.execute(db);
  await sql`revoke update (failure_reason) on public.jobs from ${sql.ref('acbp_app')}`.execute(db);
  await sql`alter table public.jobs drop constraint if exists jobs_failure_reason_requires_dead_letter`.execute(db);
  await sql`alter table public.jobs drop constraint if exists jobs_failure_reason_valid`.execute(db);
  await db.schema.alterTable('jobs').dropColumn('failure_reason').execute();
}
