// ACBP-P6-011 — duplicate suppression for the usage ledger (CDR-074 §2; TASK-009, NFR-006; ADR-008/ADR-013;
// trust-critical #12; launch gate 5).
//
// THE HOLE THIS CLOSES. `usage_events` (0017) has no idempotency key and no uniqueness beyond its primary key,
// so two deliveries of one model call insert two rows. ACBP-P6-009 proved the account rollup does not double
// count a single ledger row and said explicitly that it had no defence against the ledger itself holding
// duplicates — that is this half of trust-critical #12.
//
// AND RECONCILIATION CANNOT CATCH IT. CDR-073's drift check recomputes FROM the ledger, so a duplicated row is
// faithfully reproduced on both sides: the total is wrong, the two sides agree, nothing alerts. The rollup's
// only protection against a duplicated ledger row is that the row cannot exist.
//
// ADDITIVE AND NULLABLE. The column is nullable and the index is PARTIAL, matching `jobs` (0031) and
// `tool_calls` (0036): rows without a key never collide with one another. That is deliberate, not laxity — it
// is the dispatcher's "a blank key is no key" rule at the schema level, because two calls that both omitted a
// key are not duplicates of each other and must both count. A natural key over the call's attributes was
// rejected in CDR-074 §2: two distinct calls with identical attributes in the same instant are legitimate, and
// collapsing them would be an UNDER-count — the same class of error in the opposite direction.
//
// NOTHING EXISTING IS WEAKENED: no policy, grant or CHECK on `usage_events` is modified, and the table keeps its
// append-only SELECT+INSERT grants (invariant 9).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('usage_events').addColumn('idempotency_key', 'text').execute();

  // Bounded, like every other key column in this schema (`jobs_idempotency_len` is the precedent at 1..200).
  // A blank string is refused outright rather than treated as absent: '' would satisfy `is not null` and so
  // WOULD collide in the partial index, making two unrelated keyless calls suppress each other — exactly the
  // failure the nullable design exists to avoid.
  await sql`
    alter table public.usage_events
      add constraint usage_events_idempotency_len
      check (idempotency_key is null or char_length(btrim(idempotency_key)) between 1 and 200)
  `.execute(db);

  // ONE USAGE ROW PER (COMPANY, KEY). Per company rather than per account: usage is company-owned and dual-keyed
  // (0017), so a key minted in one company must not be able to suppress another company's row — that would be a
  // cross-tenant effect reachable without tripping a policy, since a unique index is enforced regardless of RLS.
  await sql`
    create unique index usage_events_company_idempotency_uq
      on public.usage_events (company_id, idempotency_key)
      where idempotency_key is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists public.usage_events_company_idempotency_uq`.execute(db);
  await sql`alter table public.usage_events drop constraint if exists usage_events_idempotency_len`.execute(db);
  await db.schema.alterTable('usage_events').dropColumn('idempotency_key').execute();
}
