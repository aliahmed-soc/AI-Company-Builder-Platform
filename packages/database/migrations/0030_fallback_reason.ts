// ACBP-P5-009 — the fallback REASON on the usage ledger (CDR-047 §3; NFR-019).
// ADDITIVE migration — migrations 0001–0029 are untouched, NO SECURITY DEFINER is added, no new role, no policy
// change, and NO GRANT change: `usage_events` keeps its append-only SELECT+INSERT (invariant 9).
//
// `fallback_used` already records WHETHER a call fell over to the secondary provider. Canon asks for the REASON
// (NFR-019, and the ticket's acceptance criterion "reason recorded"), and the difference is operational rather than
// pedantic: an engineer looking at a degraded answer needs to know the primary TIMED OUT versus was RATE-LIMITED
// versus was UNAVAILABLE, because those imply different responses. A boolean collapses all of them into "something
// happened".
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Nullable and INSERT-only, like every other column on this append-only table.
  await db.schema.alterTable('usage_events').addColumn('fallback_reason', 'text').execute();

  // The SAME closed category set `error_category` uses — the normalized taxonomy, never raw provider text, which
  // would put an unbounded vendor string into a ledger retained for the billing lifetime.
  await sql`alter table public.usage_events add constraint usage_events_fallback_reason_valid check (fallback_reason is null or fallback_reason in ('timeout', 'rate_limited', 'provider_unavailable', 'invalid_output', 'content_refused', 'budget_exceeded', 'internal'))`.execute(db);

  // A reason NEVER appears without a fallover. That is the contradictory state worth forbidding: a row claiming
  // `fallback_used = false` while naming why it fell back is worse than no record, because it looks authoritative.
  //
  // Deliberately ONE-DIRECTIONAL. The symmetric constraint — every `fallback_used = true` row must carry a reason —
  // is what the writer now guarantees, but it CANNOT be asserted here: rows written before this migration have
  // `fallback_used = true` and no reason, so `ADD CONSTRAINT` would fail against existing data. (It would have
  // passed in CI, where the schema is rebuilt each run, and failed on the first real deployment carrying history —
  // the worst place to discover it.) The forward guarantee is pinned by the gateway's own tests instead.
  await sql`alter table public.usage_events add constraint usage_events_fallback_reason_requires_fallback check (fallback_reason is null or fallback_used = true)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table public.usage_events drop constraint if exists usage_events_fallback_reason_requires_fallback`.execute(db);
  await sql`alter table public.usage_events drop constraint if exists usage_events_fallback_reason_valid`.execute(db);
  await db.schema.alterTable('usage_events').dropColumn('fallback_reason').execute();
}
