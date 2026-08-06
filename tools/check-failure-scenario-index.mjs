#!/usr/bin/env node
// ACBP static check — every failure-matrix row must name evidence that still exists (ACBP-P7-008; CDR-084 §3).
//
// WHY THIS EXISTS. `docs/architecture/FAILURE-AND-RECOVERY.md` is a sixteen-row table that CDR-059:14 calls
// "the specification", and ACBP-P7-008's acceptance criterion is "16-scenario matrix green". A previous ticket
// claimed this matrix and was caught overclaiming: CDR-059:92 records that *"both review passes independently
// found the header's 'all 16 rows' to be a scope overclaim"*.
//
// So the claim is made mechanical. It fails the build when:
//   • the matrix and the index disagree about which sixteen rows exist;
//   • an index `failure` has drifted from the matrix cell it pins;
//   • a cited file is gone, or the cited title is no longer attached to a LIVE `test(`/`it(` call — renaming,
//     deleting, SKIPPING or commenting out the test all break the build rather than the claim;
//   • a row claims `measured` without a hosted CI run id, or carries a run id while not `measured`;
//   • a row with evidence names no injection seam, no consequence, or anchor `none`;
//   • an `absent`/`unbuildable` row cites a file or test anyway;
//   • `doesNotProve` is blank — every row states the limit of its own evidence;
//   • the count of not-yet-`measured` rows exceeds MAX_UNPROVEN, or that ceiling is higher than on origin/main.
//
// WHAT IT CANNOT DO, said plainly because a green line is otherwise easy to over-read: it never contacts GitHub,
// so a run id is shape-checked and not resolved, and NOTHING cross-checks a row's `mutation` against its
// `testTitle`. ACBP-P7-007 marked a row `measured` on a run in which a different test went red and its checker
// passed it. Both gaps are CDR-080 §7.10 / §7.11 and apply equally here.
//
// A SEPARATE TOOL FROM check-trust-critical-index.mjs, deliberately: that one parses a numbered Markdown LIST
// under a heading, this one parses a TABLE with a different column structure. Forcing one parser to serve both
// would make a load-bearing gate fragile for a second document. What IS shared — how to cite a live test, the
// run-id rule, the ceiling comparison — lives in `tools/lib/test-citation.mjs` and is imported by both, because
// a copied guard is a guard that drifts.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveTestCallFor, norm, isRunId, checkCeiling } from './lib/test-citation.mjs';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const MATRIX = join(ROOT, 'docs', 'architecture', 'FAILURE-AND-RECOVERY.md');
const INDEX = join(ROOT, 'tools', 'failure-scenario-index.mjs');

/**
 * Parse the matrix table into `{ number, failure }`.
 *
 * Rows look like `| 1 | Model timeout | Gateway timeout class | … |`. The header and separator rows are skipped
 * because their first cell is not a number, which is also what makes this robust to columns being added.
 */
export function parseMatrix(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (!/^\d+$/.test(cells[0])) continue; // header, separator, or prose
    rows.push({ number: Number(cells[0]), failure: cells[1] });
  }
  return rows;
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();

async function main() {
  if (!existsSync(MATRIX)) {
    console.error(`✖ failure-scenario check CANNOT SEE ITS TARGET: ${MATRIX} is missing.`);
    console.error('  It pins the canon matrix; without it a clean result would be meaningless.');
    process.exit(2);
  }
  const { FAILURE_SCENARIO_INDEX, MAX_UNPROVEN, STATUSES, ANCHOR_CLASSES } = await import(
    pathToFileURL(INDEX).href
  );

  const matrix = parseMatrix(readFileSync(MATRIX, 'utf8'));
  const problems = [];

  if (matrix.length === 0) {
    problems.push(`Could not parse any rows from ${MATRIX}. The table shape changed.`);
  }

  // ── 1. The matrix and the index describe the same rows ─────────────────────────────────────────────────────
  const matrixNumbers = new Set(matrix.map((m) => m.number));
  const indexNumbers = new Set();
  for (const row of FAILURE_SCENARIO_INDEX) {
    if (indexNumbers.has(row.number)) problems.push(`Index has TWO rows numbered ${row.number}.`);
    indexNumbers.add(row.number);
  }
  for (const n of matrixNumbers) {
    if (!indexNumbers.has(n)) {
      problems.push(`Matrix row ${n} has NO index row. A scenario with no recorded evidence is what this check exists to catch.`);
    }
  }
  for (const n of indexNumbers) {
    if (!matrixNumbers.has(n)) problems.push(`Index row ${n} matches no matrix row — the table shrank or was renumbered.`);
  }

  // ── 2. Per-row integrity ───────────────────────────────────────────────────────────────────────────────────
  const byNumber = new Map(matrix.map((m) => [m.number, m]));
  let unproven = 0;
  let measured = 0;

  for (const row of FAILURE_SCENARIO_INDEX) {
    const at = `row ${row.number}`;
    const m = byNumber.get(row.number);

    if (m && norm(m.failure) !== norm(row.failure)) {
      problems.push(`${at}: failure drift.\n      matrix: ${norm(m.failure)}\n      index:  ${norm(row.failure)}`);
    }
    if (!STATUSES.includes(row.status)) problems.push(`${at}: status "${row.status}" is not one of ${STATUSES.join(' | ')}.`);
    if (!ANCHOR_CLASSES.includes(row.anchor)) problems.push(`${at}: anchor "${row.anchor}" is not one of ${ANCHOR_CLASSES.join(' | ')}.`);
    if (!norm(row.doesNotProve)) problems.push(`${at}: doesNotProve is empty. Every row states the limit of its own evidence.`);

    const hasEvidence = row.status === 'measured' || row.status === 'unmeasured';

    if (hasEvidence) {
      if (!row.file) problems.push(`${at}: status "${row.status}" but no file is named.`);
      else if (!existsSync(join(ROOT, row.file))) problems.push(`${at}: cited file does not exist — ${row.file}`);
      else if (!row.testTitle) problems.push(`${at}: status "${row.status}" but no test title is named.`);
      else {
        const call = liveTestCallFor(readFileSync(join(ROOT, row.file), 'utf8'), row.testTitle);
        if (call === 'absent') {
          problems.push(`${at}: the cited test title is NOT in ${row.file}.\n      "${row.testTitle}"\n      A renamed or deleted test must break the build, not the claim.`);
        } else if (call === 'not-a-test') {
          problems.push(`${at}: the cited title appears in ${row.file} but is NOT attached to a test(...) or it(...) call.\n      "${row.testTitle}"`);
        } else if (call === 'skipped') {
          problems.push(`${at}: the cited test in ${row.file} is SKIPPED (.skip/.todo/.fails). A skipped test is not evidence.`);
        }
      }
      if (row.anchor === 'none') problems.push(`${at}: status "${row.status}" cannot carry anchor "none".`);
      if (!norm(row.injection)) {
        problems.push(
          `${at}: no INJECTION seam is named. Constructing a failed input, or writing an already-failed row, is not injection — the fault must enter a dependency the production path calls (CDR-059:113).`,
        );
      }
      if (!norm(row.consequence)) {
        problems.push(`${at}: no CONSEQUENCE is named. Asserting only that something failed proves the least interesting cell of the row.`);
      }
      if (!norm(row.mutation)) problems.push(`${at}: no mutation is described. A control nobody tried to break is unmeasured by definition.`);
    } else {
      if (row.file || row.testTitle) problems.push(`${at}: status "${row.status}" must not cite a file or test — it claims there is none.`);
      if (row.anchor !== 'none') problems.push(`${at}: status "${row.status}" must carry anchor "none".`);
    }

    if (row.status === 'measured') {
      measured++;
      if (!isRunId(row.mutationRunId)) {
        problems.push(`${at}: claims "measured" without a hosted CI run id. A probe SHA is not enough — ACBP-P6-006's fe85082 is reachable from no ref today and only its run id survived.`);
      }
    } else if (row.mutationRunId) {
      problems.push(`${at}: status "${row.status}" but a run id is recorded. If the mutation went red, the row is "measured".`);
    }

    if (row.status !== 'measured') unproven++;
  }

  if (unproven > MAX_UNPROVEN) {
    problems.push(`${unproven} rows are not MEASURED but MAX_UNPROVEN is ${MAX_UNPROVEN}. A scenario that was measured and is no longer measured is a regression in the evidence.`);
  }

  const ceiling = checkCeiling({ cwd: ROOT, file: 'tools/failure-scenario-index.mjs', constant: 'MAX_UNPROVEN', value: MAX_UNPROVEN });
  const ceilingNote =
    ceiling.kind === 'unreadable'
      ? ' Ceiling baseline UNREADABLE (tools/failure-scenario-index.mjs not on origin/main or main) — the no-rise rule was NOT enforced on this run.'
      : ceiling.kind === 'ok'
        ? ceiling.note
        : '';
  if (ceiling.kind === 'rose') problems.push(ceiling.problem);

  // ── 3. Report ──────────────────────────────────────────────────────────────────────────────────────────────
  if (problems.length > 0) {
    console.error('\n✖ failure-scenario evidence index is out of step with the code:\n');
    for (const p of problems) console.error(`  ${p}\n`);
    console.error(`${problems.length} problem(s). See CDR-084 §3.\n`);
    process.exit(1);
  }

  // ── 4. NEGATIVE SELF-TEST ──────────────────────────────────────────────────────────────────────────────────
  // A parser that stops recognising the table becomes a checker that always passes — the "guard written but
  // never applied" failure one level up.
  {
    const probe = ['| # | Failure | Detection |', '|---|---|---|', '| 1 | Alpha fails | probe |', '| 2 | Beta fails | probe |', '', 'prose | not a row'].join('\n');
    const got = parseMatrix(probe);
    const ok = got.length === 2 && got[0].number === 1 && got[0].failure === 'Alpha fails' && got[1].failure === 'Beta fails';
    if (!ok) {
      console.error('✖ failure-scenario check FAILED ITS OWN SELF-TEST — the matrix parser no longer recognises the table.');
      console.error(`  got: ${JSON.stringify(got)}`);
      process.exit(2);
    }
  }

  const absent = FAILURE_SCENARIO_INDEX.filter((r) => r.status === 'absent' || r.status === 'unbuildable').length;
  const weak = FAILURE_SCENARIO_INDEX.filter((r) => r.anchor === 'return_value_only' || r.anchor === 'pure_helper_only').length;
  console.log(
    `✔ failure-scenario index: ${FAILURE_SCENARIO_INDEX.length} matrix rows pinned to live tests; ` +
      `${measured} MEASURED (run id recorded — shape-checked, not resolved), ${unproven - absent} unmeasured, ${absent} with no injectable subject; ` +
      `${unproven} unproven (ceiling ${MAX_UNPROVEN}).${ceilingNote} ` +
      `${weak} rest on a returned value or weaker. Matrix-parser self-test passed.`,
  );
}
