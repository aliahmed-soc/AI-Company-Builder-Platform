#!/usr/bin/env node
// ACBP — resolve every recorded mutation run and check it reddened THAT row's test (CDR-080 §7.11).
//
// THE GAP THIS CLOSES. Both evidence indexes carry a `mutationRunId`, and both say in their own headers that the
// id is SHAPE-CHECKED AND NEVER RESOLVED — nothing confirms the run happened, that it failed, or that it failed
// the test named in the same row. ACBP-P7-007 marked its row 19 `measured` on run 31113087854, in which a
// DIFFERENT test in the same file went red. Two human reviews caught it; the checker could not.
//
// This tool performs that check: for each `measured` row, pull the run's failed-test list via `gh` and assert the
// row's own verbatim `testTitle` is among the failures.
//
// WHY IT IS NOT IN `check:static`, which is a decision and not an oversight. The two index checkers deliberately
// never contact GitHub, so they run offline, unauthenticated, and identically on every machine and in CI. Adding
// a network call and a token requirement to the build would make the entire gate unrunnable whenever GitHub is
// unreachable or `gh` is unauthenticated — and a gate that cannot run is a gate someone deletes. So this is
// opt-in (`pnpm run verify:mutation-runs`) and the static gate keeps working when the network does not.
//
// WHAT A CLEAN RESULT DOES NOT MEAN:
//   • It reads the log GitHub serves TODAY. A re-run replaces it, so a row confirmed now may become
//     unconfirmable later without anything in this repository changing.
//   • It cannot tell whether the edit DESCRIBED in the row is the edit that produced the run. It proves the named
//     test failed in the named run — not why.
// Both limits are the honest residue after the mechanical part is automated.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { failedTestTitles, verifyMeasuredRow } from './lib/run-evidence.mjs';

const ROOT = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : process.cwd();

const INDEXES = [
  { label: 'scenario', file: 'tools/failure-scenario-index.mjs', exportName: 'FAILURE_SCENARIO_INDEX', tag: (n) => `scenario ${n}` },
  { label: 'trust-critical', file: 'tools/trust-critical-index.mjs', exportName: 'TRUST_CRITICAL_INDEX', tag: (n) => `trust-critical #${n}` },
];

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();

async function main() {
  // A GUARD THAT CANNOT SEE ITS TARGET MUST SAY SO. Exit 2 ("cannot check") is distinct from exit 1 ("a row is
  // wrong"), because reporting clean over an absent `gh` is the all-zero-rows-read-as-clean failure this
  // repository has fixed twice.
  const probe = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) {
    console.error('✖ verify-mutation-runs CANNOT RUN: `gh` is missing or not authenticated.');
    console.error('  This tool resolves hosted CI runs, so it needs GitHub access. That is why it is NOT part of');
    console.error('  check:static — the static gate must keep working offline. Run `gh auth login`, or skip this.');
    process.exit(2);
  }

  const rows = [];
  for (const idx of INDEXES) {
    const mod = await import(pathToFileURL(resolve(ROOT, idx.file)).href);
    for (const row of mod[idx.exportName]) {
      if (row.status === 'measured') rows.push({ who: idx.tag(row.number), runId: row.mutationRunId, testTitle: row.testTitle });
    }
  }

  if (rows.length === 0) {
    console.error('✖ verify-mutation-runs found NO measured rows in either index.');
    console.error('  Either every measurement was withdrawn, or this tool is reading the wrong files. Both are');
    console.error('  worth a human look, so this is exit 2 rather than a clean run over an empty set.');
    process.exit(2);
  }

  // One fetch per RUN, not per row: a single mutation can measure rows in both indexes (run 31129056434 bought
  // scenario 9 and trust-critical #7 together), and re-fetching would only invite the two to disagree.
  const logs = new Map();
  for (const runId of new Set(rows.map((r) => r.runId))) {
    const res = spawnSync('gh', ['run', 'view', runId, '--log-failed'], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    logs.set(runId, res.status === 0 ? failedTestTitles(res.stdout) : null);
  }

  const problems = [];
  for (const row of rows) {
    const failed = logs.get(row.runId);
    if (failed === null) {
      problems.push(`${row.who}: run ${row.runId} COULD NOT BE READ. A recorded id that no longer resolves is not evidence.`);
      continue;
    }
    const v = verifyMeasuredRow({ testTitle: row.testTitle, failedTitles: failed });
    if (v.kind === 'confirmed') {
      console.log(`✔ ${row.who.padEnd(20)} run ${row.runId}  CONFIRMED  "${row.testTitle}"`);
      continue;
    }
    if (v.kind === 'no-failures') {
      problems.push(`${row.who}: run ${row.runId} reports NO failed tests at all, so it cannot have measured anything.\n      claimed: "${row.testTitle}"`);
      continue;
    }
    problems.push(
      `${row.who}: run ${row.runId} went red, but NOT on this row's test — the ACBP-P7-007 row-19 defect.\n` +
        `      claimed: "${row.testTitle}"\n` +
        `      actually failed:\n${v.failedTitles.map((t) => `        - ${t}`).join('\n')}`,
    );
  }

  if (problems.length > 0) {
    console.error('\n✖ recorded measurements do not match their runs:\n');
    for (const p of problems) console.error(`  ${p}\n`);
    console.error(`${problems.length} problem(s). See CDR-080 §7.11.\n`);
    process.exit(1);
  }

  console.log(
    `\n✔ ${rows.length} measured row(s) across ${new Set(rows.map((r) => r.runId)).size} hosted run(s): each row's OWN test is among that run's failures.` +
      '\n  NOT PROVED: that the edit described in the row is what produced the run, and this reads the log GitHub' +
      '\n  serves today — a re-run replaces it. See CDR-080 §7.11.',
  );
}
