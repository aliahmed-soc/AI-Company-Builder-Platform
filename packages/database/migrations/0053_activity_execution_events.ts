// ACBP-P6-008 — widen the activity taxonomy so execution reaches the founder-facing feed (CDR-076 §7; ACT-001,
// ACT-003, ACT-005).
//
// UNTIL THIS MIGRATION, THE FEED SHOWED ONLY THE FOUR `company.*` EVENTS. Every task and approval in the system
// was fully AUDITED and completely INVISIBLE to the founder whose company performed it: they could read that
// their company was created and never that a run failed. `docs/agent/PROJECT-STATE.md` records that gap and
// assigns it to this ticket, and the Slice E journey asserts the ABSENCE precisely so that closing it has to be
// deliberate rather than accidental.
//
// THE CHECK AND THE CONTRACT ARE ONE CHANGE, NOT TWO. ACBP-P5-013 widened `ACTIVITY_TYPES` in `@acbp/contracts`
// with no matching migration. Nothing failed at build time and no unit test noticed, because the divergence only
// bites at INSERT — and the projector is FAIL-CLOSED, so the first correctly-wired caller would have made every
// run failure roll back its own audit write. The widening was reverted rather than shipped half-done, and the
// pairing is now asserted from BOTH sides: `activityTypesMatchDatabase()` compares the contract's two lists, and
// an integration test reads THIS constraint back out of `pg_constraint` and compares it as a set to
// `ACTIVITY_TYPES`. Widening either side alone is a red build.
//
// NO BACKFILL, and that is a decision rather than an omission. `audit_events` holds the historical task and
// approval events, so a backfill is technically possible — but a projection is a REDACTED view built by an
// allowlist that did not exist when those rows were written, and replaying them now would present today's
// redaction rules as though they had governed yesterday's events. The feed therefore begins showing execution
// from this migration forward; the audit trail remains complete and authoritative for everything before it.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

// Mirrors `ACTIVITY_TYPES` in @acbp/contracts. Duplicated on purpose and asserted equal by
// `activity-execution-events.integration.test.ts`, which reads the live CHECK rather than this source text.
const TYPES = [
  'company.created',
  'company.updated',
  'company.paused',
  'company.resumed',
  // The work a founder is paying for, from the board to the result.
  'task.created',
  'task.started',
  'task.completed',
  'task.failed',
  // ACT-003's proposed-vs-executed distinction, which was untestable while every projected event was executed:
  // `approval.requested` is the first PROPOSED fact the feed can carry.
  'approval.requested',
  'approval.approved',
  'approval.rejected',
] as const;

const OLD_TYPES = "'company.created', 'company.updated', 'company.paused', 'company.resumed'";
const NEW_TYPES = TYPES.map((t) => `'${t}'`).join(', ');

export async function up(db: Kysely<unknown>): Promise<void> {
  // DROP + ADD rather than a second constraint: two overlapping CHECKs on one column is a puzzle for whoever
  // reads it next, and the narrower one would silently win.
  await sql`alter table public.activity_events drop constraint activity_events_type_valid`.execute(db);
  await sql.raw(`alter table public.activity_events add constraint activity_events_type_valid check (activity_type in (${NEW_TYPES}))`).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // NARROWING IS ONLY SAFE IF NOTHING ALREADY VIOLATES IT. Rows projected while this migration was applied would
  // make the re-added constraint invalid, and PostgreSQL validates on ADD — so the failure would come from the
  // ALTER with a message about a constraint rather than about the rows. Delete the newly-projectable rows first,
  // which is exactly reverting what this migration made possible: the authoritative audit events are untouched,
  // so re-applying `up` and rebuilding from `audit_events` remains available.
  await sql.raw(`delete from public.activity_events where activity_type not in (${OLD_TYPES})`).execute(db);
  await sql`alter table public.activity_events drop constraint activity_events_type_valid`.execute(db);
  await sql.raw(`alter table public.activity_events add constraint activity_events_type_valid check (activity_type in (${OLD_TYPES}))`).execute(db);
}
