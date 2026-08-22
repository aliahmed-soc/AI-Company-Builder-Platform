#!/usr/bin/env node
// ACBP — the account rollup must filter by `usage_events.kind` the moment more than one kind can exist.
//
// WHY THIS EXISTS. `sumCompanyUsage`/`sumCompanyCorrections` (ACBP-P6-009, migration 0051) sum `usage_events`
// with NO `kind` predicate. That is correct today and only today: migration 0017 pins
// `kind in ('model_call')`, so there is nothing else to count. Migration 0017 also calls `kind` "the extension
// point (v1: only `model_call`; tool/worker usage arrive later)" — the widening is planned, not hypothetical.
//
// WHAT WIDENING WOULD DO, unguarded: every rollup begins counting the new kind, INCLUDING for already-closed,
// already-invoiced periods, so a past bill changes with no code touching the rollup. And the drift check
// (CDR-073 §1-G11) cannot detect it, because reconciliation recomputes down the SAME query and would agree with
// itself — the number moves, both sides match, nothing alerts. Wrong, plausible, silent: CDR-073 §0 exactly.
//
// WHY A CHECKER RATHER THAN A PREDICATE. Which kinds are billable is a commercial question and D-02 is open, so
// filtering now would invent a requirement. The decision is deliberately DEFERRED — and a deferred decision with
// no alarm is one that gets discovered on an invoice. This makes widening the CHECK fail the build until someone
// answers it, which is the same shape as `check-approval-port.mjs`: a guard that forces a question at the moment
// it becomes live.
//
// DELIBERATELY STATIC: no database, no migrations run. It reads the migration sources and the repository source.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'packages', 'database', 'migrations');
const REPOSITORY = join(ROOT, 'packages', 'database', 'src', 'usage-rollup-repository.ts');
const CONSTRAINT = 'usage_events_kind_valid';

/**
 * The kinds `usage_events.kind` currently admits, according to the LAST migration that defines the constraint.
 *
 * Scanned across ALL migrations in filename order rather than just 0017, because a widening arrives as a NEW
 * migration (`drop constraint` + `add constraint`), never as an edit to an applied one. Reading only 0017 would
 * be a guard that cannot see the change it exists for.
 *
 * Returns `null` when the constraint is dropped and not redefined — an unconstrained `kind` is the widest case
 * of all and must trip the same requirement.
 */
export function admittedKinds(files) {
  let kinds = null;
  let seen = false;
  for (const { name, source } of files) {
    void name;
    // Strip comments so prose mentioning the constraint cannot be mistaken for a definition. This checker's own
    // header names the constraint repeatedly, and so does migration 0017's warning.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
    // `addCheckConstraint('usage_events_kind_valid', sql`kind in ('a', 'b')`)` or a raw `add constraint … check`.
    const defs = [...code.matchAll(new RegExp(`${CONSTRAINT}[^\\n]*?kind\\s+in\\s*\\(([^)]*)\\)`, 'gi'))];
    for (const d of defs) {
      kinds = [...d[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
      seen = true;
    }
    // A drop with no redefinition later in the same file leaves it unconstrained.
    const drops = [...code.matchAll(new RegExp(`drop\\s+constraint[^\\n]*${CONSTRAINT}`, 'gi'))];
    if (drops.length > 0) {
      const lastDrop = drops[drops.length - 1].index ?? 0;
      const lastDef = defs.length > 0 ? (defs[defs.length - 1].index ?? 0) : -1;
      if (lastDrop > lastDef) {
        kinds = null;
        seen = true;
      }
    }
  }
  return seen ? kinds : undefined;
}

/** Does the rollup aggregation constrain `kind`? Looks only at the two summing queries' text. */
export function rollupFiltersKind(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
  // `(?:=|in\b)`, not `(=|in)\b`: there is no word boundary after `=` in `kind = 'model_call'`, so the trailing
  // `\b` made this return false for the commonest form. The self-test below caught it on the first run — which is
  // the entire reason a detector ships with one.
  return /\bkind\s*(?:=|in\b)/i.test(code);
}

/** The decision, split out so the self-test can drive it without touching the filesystem. */
export function verdict(kinds, filters) {
  if (kinds === undefined) return { ok: false, reason: `constraint ${CONSTRAINT} not found in any migration — this check can no longer see what it guards` };
  if (kinds === null) return filters ? { ok: true } : { ok: false, reason: `${CONSTRAINT} is DROPPED (kind unconstrained) and the rollup carries no kind predicate` };
  if (kinds.length <= 1) return { ok: true };
  return filters ? { ok: true } : { ok: false, reason: `${CONSTRAINT} now admits ${kinds.length} kinds (${kinds.join(', ')}) and the rollup carries no kind predicate` };
}

function selfTest() {
  const mig = (body) => [{ name: 'x', source: body }];
  const one = mig(`addCheckConstraint('${CONSTRAINT}', sql\`kind in ('model_call')\`)`);
  const two = mig(`addCheckConstraint('${CONSTRAINT}', sql\`kind in ('model_call', 'tool_call')\`)`);
  const dropped = mig(`addCheckConstraint('${CONSTRAINT}', sql\`kind in ('model_call')\`)\nalter table x drop constraint ${CONSTRAINT}`);

  const cases = [
    ['one kind, no filter → pass', verdict(admittedKinds(one), false).ok === true],
    ['two kinds, no filter → FAIL', verdict(admittedKinds(two), false).ok === false],
    ['two kinds, filtered → pass', verdict(admittedKinds(two), true).ok === true],
    ['dropped, no filter → FAIL', verdict(admittedKinds(dropped), false).ok === false],
    ['constraint absent → FAIL', verdict(admittedKinds(mig('nothing here')), true).ok === false],
    ['a commented-out definition does not count', admittedKinds(mig(`// addCheckConstraint('${CONSTRAINT}', sql\`kind in ('a','b')\`)`)) === undefined],
    ['filter detection sees a kind predicate', rollupFiltersKind("where kind = 'model_call'") === true],
    ['filter detection ignores a commented one', rollupFiltersKind("// where kind = 'model_call'") === false],
  ];
  const failed = cases.filter(([, pass]) => !pass).map(([name]) => name);
  if (failed.length > 0) {
    // EXIT 2, not 1. "This check cannot be trusted" is a different fact from "a violation was found", and the
    // five sibling checkers all say so with 2. This one said 1, which made a broken detector indistinguishable
    // from a real billing defect by exit code.
    console.error(`✖ usage-kind-predicate SELF-TEST FAILED: ${failed.join('; ')}`);
    console.error('  A clean result would be meaningless. Fix the detectors before trusting a pass.');
    process.exit(2);
  }
}

function main() {
  selfTest();

  // ⚠️ GUARDED READS. Both of these were bare, so a tree missing either path died with a raw Node ENOENT/readdir
  // stack and exit 1 — the SAME code as a real finding, on a check whose finding means the account rollup is
  // silently recounting already-invoiced periods. Blindness must not wear the costume of a billing defect.
  for (const [label, path] of [
    ['the migrations directory', MIGRATIONS],
    ['the rollup repository', REPOSITORY],
  ]) {
    if (existsSync(path)) continue;
    console.error(`\n✖ usage-kind-predicate check CANNOT SEE ITS TARGET: ${label} is not there:`);
    console.error(`  ${relative(ROOT, path).split('\\').join('/')}`);
    console.error('  A missing target is not agreement. If it moved, move this check with it.\n');
    process.exit(2);
  }

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(MIGRATIONS, name), 'utf8') }));
  const kinds = admittedKinds(files);
  const filters = rollupFiltersKind(readFileSync(REPOSITORY, 'utf8'));
  const result = verdict(kinds, filters);

  if (!result.ok) {
    console.error(`✖ usage-kind-predicate check FAILED — ${result.reason}.`);
    console.error('  The account rollup sums `usage_events` with no `kind` filter, which is safe only while one');
    console.error('  kind exists. With more than one it silently recounts ALREADY-INVOICED periods, and the drift');
    console.error('  check cannot see it because reconciliation recomputes down the same query.');
    console.error('  Decide which kinds are billable (D-02) and filter in `usage-rollup-repository.ts`, or state');
    console.error('  in CDR-073 why counting every kind is correct — then this check passes.');
    process.exit(1);
  }
  const shape = kinds === null ? 'unconstrained' : `${kinds.length} kind(s): ${kinds.join(', ')}`;
  console.log(`✔ usage-kind-predicate check passed (${shape}; rollup kind predicate ${filters ? 'present' : 'not required'}). Self-test passed.`);
}

main();
