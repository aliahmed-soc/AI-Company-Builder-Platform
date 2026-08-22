// ACBP — tests for the usage-kind-predicate check (ACBP-P6-009; CDR-073 §0, §1-G11; migrations 0017 + 0051).
//
// The guarded defect is a SILENT one: the account rollup sums `usage_events` with no `kind` predicate, which is
// correct only while `usage_events_kind_valid` admits exactly one kind. The moment a migration widens that set,
// every rollup — including for already-closed, already-invoiced periods — starts counting the new kind, and the
// drift check cannot see it because reconciliation recomputes down the same query and agrees with itself.
//
// This checker had NEVER been watched go red against that defect, so per AGENTS.md §3 it was a hypothesis, not a
// control. These tests run the REAL checker as a subprocess against throwaway trees and assert BOTH directions.
//
// TWO STRUCTURAL FACTS SHAPE EVERY TEST HERE:
//
//   1. The checker calls `main()` unconditionally at module scope (line 130) — there is no `import.meta.main`
//      guard. Importing it to unit-test the exported `admittedKinds`/`rollupFiltersKind`/`verdict` would run the
//      real check inside the vitest worker and could `process.exit(1)` mid-suite. Subprocess only.
//
//   2. ⚠️ THIS CHECKER USED TO HAVE NO EXIT 2, AND WRITING THIS SUITE IS WHAT SURFACED IT. A self-test failure,
//      "cannot see the target", and a real violation ALL exited 1 — and the two reads were bare, so a tree
//      missing either path died with a raw Node stack, also at exit 1. On a check whose finding means the
//      account rollup is silently recounting already-invoiced periods, blindness wore the costume of a billing
//      defect.
//
//      Fixed in the same change: self-test failure and both missing targets are now exit 2, matching the five
//      sibling checkers. `expect(code).toBe(1)` therefore means "a real violation" here and nothing else.
//      EVERY red assertion below still pins the reason string as well, because an exit code alone has been the
//      wrong evidence in this repository often enough to stop trusting it on its own.
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, '..', 'check-usage-kind-predicate.mjs');

// ---------------------------------------------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------------------------------------------

/** Migration 0017's real line, verbatim in shape: the single-kind pin the rollup's safety currently rests on. */
const PIN_ONE_KIND = [
  "import { sql } from 'kysely';",
  'export async function up(db) {',
  '  await db.schema',
  "    .alterTable('usage_events')",
  "    .addCheckConstraint('usage_events_kind_valid', sql`kind in ('model_call')`)",
  '    .execute();',
  '}',
  'export async function down(db) {',
  "  await db.schema.dropTable('usage_events').execute();",
  '}',
  '',
].join('\n');

/** THE DEFECT. A later migration widens the admitted set — raw-SQL drop/add, this repo's house style. */
const WIDEN_TO_TWO_KINDS = [
  "import { sql } from 'kysely';",
  'export async function up(db) {',
  '  await sql`alter table public.usage_events drop constraint if exists usage_events_kind_valid`.execute(db);',
  "  await sql`alter table public.usage_events add constraint usage_events_kind_valid check (kind in ('model_call', 'tool_call'))`.execute(db);",
  '}',
  '',
].join('\n');

/** The widest case of all: the constraint dropped and never redefined, so `kind` admits anything. */
const DROP_AND_NEVER_REDEFINE = [
  "import { sql } from 'kysely';",
  'export async function up(db) {',
  '  await sql`alter table public.usage_events drop constraint if exists usage_events_kind_valid`.execute(db);',
  '}',
  '',
].join('\n');

/** A widening that only exists in prose. The checker strips comments; if it stopped, this would go red. */
const WIDENING_IN_A_COMMENT = [
  '// Someday, per D-02:',
  "//   add constraint usage_events_kind_valid check (kind in ('model_call', 'tool_call'))",
  'export async function up() {}',
  '',
].join('\n');

/** The constraint renamed out from under the checker — it must SAY it is blind, not report all-clear. */
const CONSTRAINT_RENAMED = [
  "import { sql } from 'kysely';",
  'export async function up(db) {',
  '  await db.schema',
  "    .alterTable('usage_events')",
  "    .addCheckConstraint('usage_events_kind_ok', sql`kind in ('model_call')`)",
  '    .execute();',
  '}',
  '',
].join('\n');

const sumQuery = (bucket, kindPredicate) =>
  [
    '    const result = await sql`',
    '      select',
    '        count(*) as event_count,',
    '        coalesce(sum(input_tokens), 0) as input_tokens,',
    '        coalesce(sum(estimated_cost_micros), 0) as estimated_cost_micros',
    '      from public.usage_events',
    `      where date_trunc('${bucket}', created_at at time zone 'UTC') = \${periodStart}::date${kindPredicate}`,
    '    `.execute(this.#db);',
    '',
  ].join('\n');

/** The rollup EXACTLY as it stands today: three raw-SQL sums over `usage_events`, none constraining `kind`. */
const buildRollup = (kindPredicate) =>
  [
    "import { sql } from 'kysely';",
    'export class UsageRollupReadRepository {',
    '  async sumCompanyUsage(periodStart) {',
    sumQuery('month', kindPredicate) + '  }',
    '  async sumCompanyUsageForDay(periodStart) {',
    sumQuery('day', kindPredicate) + '  }',
    '  async sumCompanyCorrections(periodStart) {',
    sumQuery('month', kindPredicate) + '  }',
    '}',
    '',
  ].join('\n');

const ROLLUP_UNFILTERED = buildRollup('');
const ROLLUP_FILTERED = buildRollup("\n        and kind = 'model_call'");

/**
 * A throwaway repo with only what this checker reads. BOTH paths are a FLOOR, not decoration:
 * `readdirSync(packages/database/migrations)` and `readFileSync(packages/database/src/usage-rollup-repository.ts)`
 * are unguarded, so omitting either crashes the checker with an ENOENT stack trace — exit 1, the same code as a
 * real violation. `omitMigrationsDir` / `omitRollup` exist ONLY so the vacuity tests can prove that distinction.
 */
function makeTree({ migrations = {}, rollup = ROLLUP_UNFILTERED, omitMigrationsDir = false, omitRollup = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-usage-kind-'));
  if (!omitMigrationsDir) mkdirSync(join(root, 'packages', 'database', 'migrations'), { recursive: true });
  mkdirSync(join(root, 'packages', 'database', 'src'), { recursive: true });
  for (const [name, source] of Object.entries(migrations)) {
    writeFileSync(join(root, 'packages', 'database', 'migrations', name), source);
  }
  if (!omitRollup) writeFileSync(join(root, 'packages', 'database', 'src', 'usage-rollup-repository.ts'), rollup);
  return root;
}

/**
 * Run the REAL checker file (not a copy) with the fixture as cwd. The checker resolves everything from
 * `process.cwd()`, so cwd IS the injection point — no copy, and therefore no chance of testing a stale one.
 */
function run(root) {
  try {
    const out = execFileSync(process.execPath, [CHECKER], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const BASELINE = { '0017_usage_events.ts': PIN_ONE_KIND };

// ---------------------------------------------------------------------------------------------------------------

describe('usage-kind-predicate check', () => {
  test('CONTROL — the tree as it stands today passes: one kind, rollup unfiltered, no predicate required', () => {
    // Without this, a checker that rejected every tree would satisfy every red test below.
    const r = run(makeTree({ migrations: BASELINE }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 kind(s): model_call');
    expect(r.out).toContain('rollup kind predicate not required');
    expect(r.out).toContain('Self-test passed');
  });

  test('RED — a migration widens `kind` to two values while the rollup still sums every row', () => {
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_usage_events_tool_kind.ts': WIDEN_TO_TWO_KINDS } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('usage_events_kind_valid now admits 2 kinds (model_call, tool_call)');
    expect(r.out).toContain('the rollup carries no kind predicate');
    // The message must name the consequence and the open decision, or the next reader just deletes the check.
    expect(r.out).toContain('ALREADY-INVOICED');
    expect(r.out).toContain('D-02');
    expect(r.out).not.toContain('check passed');
  });

  test('GREEN AFTER THE FIX — the same widening passes once the sums constrain `kind`', () => {
    // This is what proves the red above was caused by the MISSING PREDICATE, not by the widened migration merely
    // being present. Same migrations, one changed file.
    const r = run(
      makeTree({
        migrations: { ...BASELINE, '0057_usage_events_tool_kind.ts': WIDEN_TO_TWO_KINDS },
        rollup: ROLLUP_FILTERED,
      }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 kind(s): model_call, tool_call');
    expect(r.out).toContain('rollup kind predicate present');
  });

  test('RED — dropping the constraint outright is the widest case and must trip the same requirement', () => {
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_drop_kind_check.ts': DROP_AND_NEVER_REDEFINE } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('usage_events_kind_valid is DROPPED (kind unconstrained)');
  });

  test('RED — going blind is a failure, not a pass: a renamed constraint must say so, distinctly', () => {
    // A guard that silently passes once it can no longer find its target is worse than no guard.
    const r = run(makeTree({ migrations: { '0017_usage_events.ts': CONSTRAINT_RENAMED } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not found in any migration — this check can no longer see what it guards');
    // Distinct from the violation message, so the two are never confused in CI output.
    expect(r.out).not.toContain('now admits');
  });

  test('CONTROL — a widening that exists only in a comment does not trip it', () => {
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_someday.ts': WIDENING_IN_A_COMMENT } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 kind(s): model_call');
  });

  // -------------------------------------------------------------------------------------------------------------
  // VACUITY GUARDS. These do not test the rule; they test that the RED cases above cannot pass for the wrong
  // reason. Both floors crash the checker with exit 1 — the SAME code a violation uses — so any future test that
  // asserts only on the exit code is vacuous by construction.
  // -------------------------------------------------------------------------------------------------------------

  // ⚠️ THESE TWO CASES ORIGINALLY DOCUMENTED A DEFECT. They asserted `code === 1` and `out` containing `ENOENT`,
  // because both reads were bare: a tree missing either path died with a raw Node stack at exit 1 — the SAME code
  // as a real finding, on a check whose finding means the account rollup is silently recounting already-invoiced
  // periods. The suite recorded that as a known trap rather than fixing it.
  //
  // It is fixed now, so these pin the corrected contract instead: blindness is exit 2, names the target, and
  // carries none of Node's stack. Reverting the guard turns both red with `expected 1 to be 2`.
  test('a tree with no migrations directory is BLIND (exit 2), not a violation, and does not crash', () => {
    const r = run(makeTree({ omitMigrationsDir: true }));
    expect(r.code, 'blindness must not share an exit code with a billing finding').toBe(2);
    expect(r.out).toContain('CANNOT SEE ITS TARGET');
    expect(r.out).toContain('migrations');
    expect(r.out, 'a raw stack means the read is unguarded again').not.toContain('ENOENT');
    expect(r.out).not.toContain('usage-kind-predicate check FAILED');
  });

  test('a tree with no rollup repository file is BLIND (exit 2) too, and names that file', () => {
    const r = run(makeTree({ migrations: BASELINE, omitRollup: true }));
    expect(r.code).toBe(2);
    expect(r.out).toContain('CANNOT SEE ITS TARGET');
    expect(r.out).toContain('usage-rollup-repository.ts');
    expect(r.out).not.toContain('ENOENT');
  });

  test('VACUITY — an empty migrations directory reports blindness, so it can never stand in for a clean tree', () => {
    const r = run(makeTree({ migrations: {} }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not found in any migration');
  });

  test('VACUITY — a migration not named *.ts is invisible to the checker', () => {
    // A fixture that wrote the widening to `0057_widen.sql` would go green and "prove" the guard works.
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_widen.sql': WIDEN_TO_TWO_KINDS } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 kind(s): model_call');
  });

  // -------------------------------------------------------------------------------------------------------------
  // KNOWN BLIND SPOTS — each assertion below pins behaviour that is WRONG. They are here because the widening this
  // guard exists to catch would, written in this repository's own prevailing idiom, sail straight past it. Each
  // must be INVERTED (code 1, 'now admits') as part of fixing the checker; one still passing after a fix is the
  // signal that the fix was incomplete.
  // -------------------------------------------------------------------------------------------------------------

  test('BLIND SPOT (defect) — up widens, down restores: the DOWN function is the last definition and wins', () => {
    // Every migration in this repo ships `up` and `down` in one file and `down` restores the prior constraint
    // (see 0027_task_planning.ts). `admittedKinds` keeps the LAST match in file order, which is the down's
    // single-kind restore — so the most idiomatic possible widening reports "1 kind(s)" and passes.
    const HOUSE_STYLE_WIDENING = [
      "import { sql } from 'kysely';",
      'export async function up(db) {',
      '  await sql`alter table public.usage_events drop constraint if exists usage_events_kind_valid`.execute(db);',
      "  await sql`alter table public.usage_events add constraint usage_events_kind_valid check (kind in ('model_call', 'tool_call'))`.execute(db);",
      '}',
      'export async function down(db) {',
      '  await sql`alter table public.usage_events drop constraint if exists usage_events_kind_valid`.execute(db);',
      "  await sql`alter table public.usage_events add constraint usage_events_kind_valid check (kind in ('model_call'))`.execute(db);",
      '}',
      '',
    ].join('\n');
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_widen.ts': HOUSE_STYLE_WIDENING } }));
    expect(r.code).toBe(0); // WRONG. Should be 1.
    expect(r.out).toContain('1 kind(s): model_call');
  });

  test('BLIND SPOT (defect) — the `sql.join` enum idiom yields ZERO kinds, and zero passes the `<= 1` gate', () => {
    // Copied from 0027_task_planning.ts, which is how this repo writes a closed enum CHECK. `[^)]*` stops at the
    // first `)` and no quoted literals survive, so `kinds` is `[]` — and `kinds.length <= 1` returns ok.
    const SQL_JOIN_WIDENING = [
      "import { sql } from 'kysely';",
      "const USAGE_KINDS = ['model_call', 'tool_call', 'worker_run'];",
      'export async function up(db) {',
      '  await sql`alter table public.usage_events drop constraint if exists usage_events_kind_valid`.execute(db);',
      '  await sql`alter table public.usage_events add constraint usage_events_kind_valid check (kind in (${sql.join(USAGE_KINDS.map((k) => sql.lit(k)))}))`.execute(db);',
      '}',
      '',
    ].join('\n');
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_widen.ts': SQL_JOIN_WIDENING } }));
    expect(r.code).toBe(0); // WRONG. Three kinds are admitted.
    expect(r.out).toContain('0 kind(s)');
  });

  test('BLIND SPOT (defect) — a multi-line `addCheckConstraint` is not seen: the regex is single-line', () => {
    const MULTILINE_WIDENING = [
      "import { sql } from 'kysely';",
      'export async function up(db) {',
      '  await db.schema',
      "    .alterTable('usage_events')",
      '    .addCheckConstraint(',
      "      'usage_events_kind_valid',",
      "      sql`kind in ('model_call', 'tool_call')`,",
      '    )',
      '    .execute();',
      '}',
      '',
    ].join('\n');
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_widen.ts': MULTILINE_WIDENING } }));
    expect(r.code).toBe(0); // WRONG. Prettier alone can produce this line break.
    expect(r.out).toContain('1 kind(s): model_call');
  });

  test('BLIND SPOT (defect) — Kysely `.dropConstraint()` is not the raw `drop constraint` the regex wants', () => {
    const BUILDER_DROP = [
      'export async function up(db) {',
      "  await db.schema.alterTable('usage_events').dropConstraint('usage_events_kind_valid').execute();",
      '}',
      '',
    ].join('\n');
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_drop.ts': BUILDER_DROP } }));
    expect(r.code).toBe(0); // WRONG. `kind` is unconstrained after this migration.
    expect(r.out).toContain('1 kind(s): model_call');
  });

  test('BLIND SPOT (defect) — any `kind =` anywhere in the file satisfies the predicate check', () => {
    // `rollupFiltersKind`'s doc says it "Looks only at the two summing queries' text". It does not — it is handed
    // the WHOLE file. An unrelated local named `kind` clears the gate while all three sums stay unfiltered.
    const ROLLUP_WITH_DECOY = `${ROLLUP_UNFILTERED}const kind = 'model_call';\nexport { kind };\n`;
    const r = run(
      makeTree({ migrations: { ...BASELINE, '0057_widen.ts': WIDEN_TO_TWO_KINDS }, rollup: ROLLUP_WITH_DECOY }),
    );
    expect(r.code).toBe(0); // WRONG. Nothing filters anything.
    expect(r.out).toContain('rollup kind predicate present');
  });

  test('BLIND SPOT (defect) — filtering ONE of the three sums is accepted as filtering all of them', () => {
    const PARTIAL = ROLLUP_UNFILTERED.replace('::date', "::date\n        and kind = 'model_call'");
    const r = run(makeTree({ migrations: { ...BASELINE, '0057_widen.ts': WIDEN_TO_TWO_KINDS }, rollup: PARTIAL }));
    expect(r.code).toBe(0); // WRONG. `sumCompanyUsageForDay` and `sumCompanyCorrections` still count every kind.
    expect(r.out).toContain('rollup kind predicate present');
  });

  test('BLIND SPOT (defect) — the Kysely builder predicate form is NOT recognised, so a real fix stays red', () => {
    // `.where('kind', '=', 'model_call')` is how the rest of usage-rollup-repository.ts writes predicates
    // (lines 137-138). `\bkind\s*(?:=|in\b)` cannot match across the closing quote and comma.
    const BUILDER_FILTERED = [
      'export class UsageRollupReadRepository {',
      '  async sumCompanyUsage(periodStart) {',
      '    return this.#db',
      "      .selectFrom('usage_events')",
      "      .select(({ fn }) => fn.count('id').as('event_count'))",
      "      .where('kind', '=', 'model_call')",
      '      .execute();',
      '  }',
      '}',
      '',
    ].join('\n');
    const r = run(
      makeTree({ migrations: { ...BASELINE, '0057_widen.ts': WIDEN_TO_TWO_KINDS }, rollup: BUILDER_FILTERED }),
    );
    expect(r.code).toBe(1); // WRONG DIRECTION: the predicate IS there. A false alarm, not a false pass.
    expect(r.out).toContain('the rollup carries no kind predicate');
  });
});
