// ACBP-API-008 (CDR-092 §2) — admit a 'company' scope to the API rate-limit buckets.
//
// WHY THIS IS A MIGRATION AND NOT A TYPE CHANGE. Migration 0055 wrote a CHECK constraint pinning `scope_kind` to
// exactly `'session', 'account'`, and its comment said a third kind "would need a value decision, not a code
// change." That decision has now been made (CDR-091 §2.3, owner-ruled): the four generate routes get a per-company
// ceiling, because each of their calls spends real money. Widening the union in TypeScript alone would leave the
// database refusing every write the new scope makes — correctly, since the constraint is doing its job.
//
// THE CONSTRAINT IS REPLACED, NOT DROPPED. `session` and `account` remain exactly as ruled; this only adds a third
// admissible value. Dropping the constraint outright would be the easy edit and the wrong one: it exists so a
// typo'd or attacker-supplied scope is refused by the database rather than silently creating a parallel bucket
// namespace that no limit rule governs.
//
// NO DATA MIGRATION. The table holds only transient token counters keyed by digest; no existing row changes
// meaning, and no row needs rewriting. A company bucket simply did not exist before this.
//
// ⚠️ THE CEILING ITSELF IS PROVISIONAL (5/min/company — see `packages/config/src/rate-limits.ts` and CDR-092 §2.1).
// This migration is not: admitting the scope is independent of what its rule turns out to be, and re-running a
// constraint swap to change a NUMBER would be a migration that carries no schema meaning.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const CONSTRAINT = 'api_rate_limit_buckets_scope_kind_valid';

/** Post-CDR-091: the three ruled keys. A fourth still needs a value decision, not a code change. */
const SCOPE_KINDS_AFTER = "'session', 'account', 'company'";
/** What 0055 wrote, restored verbatim by `down`. */
const SCOPE_KINDS_BEFORE = "'session', 'account'";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`alter table public.api_rate_limit_buckets drop constraint ${CONSTRAINT}`).execute(db);
  await sql
    .raw(`alter table public.api_rate_limit_buckets add constraint ${CONSTRAINT} check (scope_kind in (${SCOPE_KINDS_AFTER}))`)
    .execute(db);

  await sql`comment on constraint api_rate_limit_buckets_scope_kind_valid on public.api_rate_limit_buckets is
    'ACBP-API-008: session and account (CDR-008 section 8), plus company (CDR-091 section 2.3) for the metered generate routes.'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // NOT LOSSLESS IN ONE CASE, AND THAT IS DELIBERATE: if any company bucket exists, restoring the narrower
  // constraint would fail on it. Delete those rows first — they are transient counters, so the cost is at most
  // one refill window of leniency for companies that were being limited, and the alternative is a `down` that
  // cannot run. This is the same reasoning 0055's own `down` gives for dropping the table.
  await sql`delete from public.api_rate_limit_buckets where scope_kind = 'company'`.execute(db);

  await sql.raw(`alter table public.api_rate_limit_buckets drop constraint ${CONSTRAINT}`).execute(db);
  await sql
    .raw(`alter table public.api_rate_limit_buckets add constraint ${CONSTRAINT} check (scope_kind in (${SCOPE_KINDS_BEFORE}))`)
    .execute(db);
}
