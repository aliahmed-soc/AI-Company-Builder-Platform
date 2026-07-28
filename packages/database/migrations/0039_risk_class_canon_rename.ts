// ACBP — canon correction: the fourth risk class is `sensitive_irreversible` (owner decision 2026-07-28;
// CDR-051 §0.2; APPR-001).
//
// WHY A NEW MIGRATION RATHER THAN EDITING 0033/0036/0038. Those three are merged and may have been applied; a
// migration that has run is a historical fact, and rewriting it would make the recorded history disagree with what any
// existing database actually did. So this one ALTERS forward, which is also the only shape that can carry data.
//
// WHAT THIS IS NOT: a behaviour change. The ordering, every rank, and the MVP ceiling (`internal_reversible`) are
// untouched — this renames the top class to the name canon already gave it. `external_irreversible` tied that class to
// EXTERNAL effects, so an irreversible INTERNAL action had no home above the second-least restrictive value;
// `sensitive_irreversible` is about sensitivity and irreversibility wherever they occur, which is what canon means.
//
// DATA FIRST, THEN CONSTRAINTS. Rewriting rows while the old CHECK still permits the old value and the new one does
// not yet exist is the only order that cannot strand a row: widening first would briefly allow both, and narrowing
// first would reject the very UPDATE that fixes the data.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const OLD = 'external_irreversible';
const NEW = 'sensitive_irreversible';

const CLASSES_OLD = "'informational', 'internal_reversible', 'external_reversible', 'external_irreversible'";
const CLASSES_NEW = "'informational', 'internal_reversible', 'external_reversible', 'sensitive_irreversible'";

/** The three CHECKs that name the class set, with the table each guards. */
const CONSTRAINTS: ReadonlyArray<readonly [table: string, name: string, predicate: (classes: string) => string]> = [
  ['tool_definitions', 'tool_definitions_risk_class_valid', (c) => `risk_class is null or risk_class in (${c})`],
  ['tool_calls', 'tool_calls_risk_class_valid', (c) => `risk_class in (${c})`],
  [
    'worker_definitions',
    'worker_definitions_approval_threshold_valid',
    (c) => `approval_threshold_risk_class is null or approval_threshold_risk_class in (${c})`,
  ],
];

/** Columns carrying a class value, which must be rewritten before the constraints narrow. */
const COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['tool_definitions', 'risk_class'],
  ['tool_calls', 'risk_class'],
  ['worker_definitions', 'approval_threshold_risk_class'],
];

async function rewrite(db: Kysely<unknown>, from: string, to: string, classes: string): Promise<void> {
  // Drop every CHECK first so the UPDATE below is not fighting a predicate that forbids its own result.
  for (const [table, name] of CONSTRAINTS) {
    await sql.raw(`alter table public.${table} drop constraint if exists ${name}`).execute(db);
  }
  for (const [table, column] of COLUMNS) {
    await sql.raw(`update public.${table} set ${column} = '${to}' where ${column} = '${from}'`).execute(db);
  }
  for (const [table, name, predicate] of CONSTRAINTS) {
    await sql.raw(`alter table public.${table} add constraint ${name} check (${predicate(classes)})`).execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await rewrite(db, OLD, NEW, CLASSES_NEW);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Fully reversible: the same rewrite in the other direction. Nothing is lost either way, because the two names
  // denote the same POSITION in the ordering — which is what every gate actually reads.
  await rewrite(db, NEW, OLD, CLASSES_OLD);
}
