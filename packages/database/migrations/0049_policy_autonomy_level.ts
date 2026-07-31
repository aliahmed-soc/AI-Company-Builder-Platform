// ACBP-P6-006 — the autonomy level a policy version was written under (CDR-071 §2-G1/G3/G5; APPR-008; PRD §12).
//
// THE LEVEL LIVES ON `policies`, NOT ON `companies`. A policy row is already the versioned, supersedable record of
// what a company may do unsupervised, and the level is part of that answer. Putting it on `companies` would make it
// mutable out-of-band from the thing it governs, so an evaluation record could cite version 4 while the level that
// actually decided had since changed — precisely what ADR-010's "versioned" requirement exists to prevent. Here, a
// level change IS a new policy version, and `policy.changed` already fires for that (CDR-071 §2-G6).
//
// 1–5 ARE STORABLE; ONLY 1–2 ARE ACCEPTED. Following migration 0047's precedent for approval scopes: canon's full
// set is representable so later levels are additive rather than a migration, while the SERVICE admits only the MVP
// pair and returns a typed refusal for the rest (CDR-071 §2-G5). A CHECK of 1..2 would have to be dropped and
// recreated the day level 3 ships, and a constraint change on a live governance table is the worst possible moment
// to be editing what "allowed" means.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // ADDED NULLABLE, BACKFILLED, THEN SET NOT NULL — the three-step so the ALTER does not fail on existing rows and
  // does not need a DEFAULT left behind. A lingering column default would silently supply a level to any future
  // insert that forgot one, which is exactly the kind of quiet fallback this ticket exists to remove.
  await sql`alter table public.policies add column autonomy_level smallint`.execute(db);

  // BACKFILL TO 2, DELIBERATELY (CDR-071 §2-G3). Existing rows predate the column and their effective behaviour IS
  // level 2 — that is what the owner-ruled `DEFAULT_NEW_COMPANY_POLICY` does. Backfilling 1 would read as the
  // "safer" choice while silently tightening every existing company and overriding an accepted owner decision.
  // No company's behaviour changes when this migration runs.
  await sql`update public.policies set autonomy_level = 2 where autonomy_level is null`.execute(db);

  await sql`alter table public.policies alter column autonomy_level set not null`.execute(db);

  // Validated against existing rows at ADD CONSTRAINT time, so the backfill above must already satisfy it — if a row
  // somehow held something else, this migration fails loudly here rather than admitting an ungoverned value.
  await sql`alter table public.policies
    add constraint policies_autonomy_level_range
    check (autonomy_level between 1 and 5)`.execute(db);

  await sql`comment on column public.policies.autonomy_level is
    'APPR-008 autonomy level for this policy version. 1-5 storable so later levels are additive; the service accepts 1-2 only (PRD §11.5). A level change creates a NEW policy version — never an in-place update.'`.execute(db);

  // NO NEW GRANT. `policies` already carries the grants this needs, and deliberately no UPDATE: a policy version is
  // superseded, not edited, so the level a past evaluation was decided under cannot be rewritten after the fact.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table public.policies drop constraint if exists policies_autonomy_level_range`.execute(db);
  await sql`alter table public.policies drop column if exists autonomy_level`.execute(db);
}
