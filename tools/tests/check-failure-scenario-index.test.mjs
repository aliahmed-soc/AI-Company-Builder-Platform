/**
 * ACBP-P7-008 — regression suite for tools/check-failure-scenario-index.mjs (CDR-084 §3).
 *
 * The checker exists because a previous ticket claimed this same matrix and was caught overclaiming: CDR-059:92
 * records that *"both review passes independently found the header's 'all 16 rows' to be a scope overclaim"*. A
 * checker that stops detecting drift is worse than none, because a green run then reads as a verified claim.
 *
 * Each case runs the real checker against an ISOLATED temp workspace via its scan-root argument.
 */
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseMatrix } from '../check-failure-scenario-index.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = join(REPO_ROOT, 'tools', 'check-failure-scenario-index.mjs');
const MATRIX_PATH = 'docs/architecture/FAILURE-AND-RECOVERY.md';
const PROVING_FILE = 'packages/core/src/probe.test.ts';
const PROVING_TITLE = 'the probe injects a fault and the row refuses';

// ---- the matrix parser --------------------------------------------------------------------------------------

test('the parser reads numbered table rows and ignores the header, separator and prose', () => {
  const md = [
    '# Failure and Recovery',
    '',
    'Status: Proposed. Governs NFR-005.',
    '',
    '| # | Failure | Detection |',
    '|---|---|---|',
    '| 1 | Model timeout | Gateway timeout class |',
    '| 2 | Provider outage | Error-rate threshold |',
    '',
    'trailing | prose | with pipes',
  ].join('\n');
  expect(parseMatrix(md)).toEqual([
    { number: 1, failure: 'Model timeout' },
    { number: 2, failure: 'Provider outage' },
  ]);
});

test('a row whose first cell is not a number is not a row', () => {
  expect(parseMatrix('| n/a | Something |')).toEqual([]);
});

// ---- the end-to-end checker ---------------------------------------------------------------------------------

const matrix = (rows = 2) => {
  const lines = ['# Failure and Recovery', '', '| # | Failure | Detection |', '|---|---|---|'];
  lines.push('| 1 | Alpha fails | probe |');
  if (rows >= 2) lines.push('| 2 | Bravo fails | probe |');
  return lines.join('\n');
};

const row = (over = {}) => ({
  number: 1,
  failure: 'Alpha fails',
  consequence: 'the row refuses and writes nothing',
  status: 'unmeasured',
  anchor: 'database_state',
  injection: 'the storage dependency is made to throw',
  file: PROVING_FILE,
  testTitle: PROVING_TITLE,
  entryPoint: 'doThing',
  // Names `doThing`, which the fixture below writes into non-test source. A mutation that names nothing real is
  // now refused, so the DEFAULT row has to be a well-formed one or every case here would fail for that reason.
  mutation: 'Delete the guard inside `doThing`.',
  mutationRunId: '',
  doesNotProve: 'Nothing beyond the single path.',
  notes: 'probe',
  // The spread is load-bearing and was missing on the first run: without it every `row({...})` returned the
  // default, `secondRow()` silently became a duplicate of row 1, and 17 cases failed for a reason that had
  // nothing to do with the checker. Driving the checker by hand exited 0, which is what located the bug.
  ...over,
});

const secondRow = (over = {}) =>
  row({
    number: 2,
    failure: 'Bravo fails',
    consequence: '',
    status: 'unbuildable',
    anchor: 'none',
    injection: '',
    file: '',
    testTitle: '',
    entryPoint: '',
    mutation: '',
    doesNotProve: 'No subject exists.',
    ...over,
  });

function run(opts = {}) {
  const rows = opts.rows ?? [row(), secondRow()];
  const root = mkdtempSync(join(tmpdir(), 'acbp-failure-index-'));
  try {
    const write = (rel, content) => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };
    if (!opts.omitMatrix) write(MATRIX_PATH, opts.matrixText ?? matrix());
    if (!opts.omitProvingFile) {
      write(PROVING_FILE, opts.provingFileText ?? `import { test } from 'vitest';\ntest('${PROVING_TITLE}', () => {});\n`);
    }
    // NON-TEST source, so the mutation-names-real-code rule has a corpus. Without this the walk finds only the
    // proving file — which is a test file and therefore excluded — and the checker correctly refuses to run at
    // all, which would make every case below fail for a reason unrelated to what it is testing.
    if (!opts.omitSource) write('packages/core/src/thing.ts', 'export function doThing() { return 1; }\n');
    write(
      'tools/failure-scenario-index.mjs',
      [
        `export const ANCHOR_CLASSES = Object.freeze(['database_state','recorded_row','return_value_only','pure_helper_only','none']);`,
        `export const STATUSES = Object.freeze(['measured','unmeasured','absent','unbuildable']);`,
        `export const MAX_UNPROVEN = ${opts.maxUnproven ?? 2};`,
        `export const FAILURE_SCENARIO_INDEX = Object.freeze(${JSON.stringify(rows)});`,
      ].join('\n'),
    );
    const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rejects = (label, opts, expected) =>
  test(`rejects: ${label}`, () => {
    const { code, out } = run(opts);
    expect(code, `expected non-zero exit for ${label}\n${out}`).toBe(1);
    expect(out, `expected /${expected}/ for ${label}\n${out}`).toMatch(new RegExp(expected));
  });

const accepts = (label, opts) =>
  test(`accepts: ${label}`, () => {
    const { code, out } = run(opts);
    expect(code, `expected clean exit for ${label}\n${out}`).toBe(0);
  });

// The control. Without it every rejection below could pass for the wrong reason.
accepts('a well-formed index over a two-row matrix', {});

// ---- the failure this tool exists for: a scenario with no recorded evidence ---------------------------------
rejects('a matrix row with no index row', { rows: [row()] }, 'Matrix row 2 has NO index row');
rejects('an index row matching no matrix row', { rows: [row(), secondRow(), row({ number: 3 })] }, 'matches no matrix row');
rejects('two rows sharing a number', { rows: [row(), row(), secondRow()] }, 'TWO rows numbered 1');
rejects('the failure text drifted from the matrix', { rows: [row({ failure: 'Alpha sometimes fails' }), secondRow()] }, 'failure drift');

// ---- citing a test ------------------------------------------------------------------------------------------
rejects('the cited file does not exist', { omitProvingFile: true }, 'cited file does not exist');
rejects('the cited test was renamed', { rows: [row({ testTitle: 'nobody wrote this' }), secondRow()] }, 'cited test title is NOT in');
rejects(
  'the cited test is SKIPPED',
  { provingFileText: `import { test } from 'vitest';\ntest.skip('${PROVING_TITLE}', () => {});\n` },
  'is SKIPPED',
);
rejects(
  'the title survives only in a comment',
  { provingFileText: `import { test } from 'vitest';\n// ${PROVING_TITLE}\ntest('other', () => {});\n` },
  'NOT attached to a test',
);

// ---- the columns this checker adds over the trust-critical one ----------------------------------------------
rejects(
  'INJECTION is unnamed — constructing a failed input is not injection',
  { rows: [row({ injection: '   ' }), secondRow()] },
  'no INJECTION seam is named',
);
rejects(
  'CONSEQUENCE is unnamed — "it failed" proves the least interesting cell',
  { rows: [row({ consequence: '' }), secondRow()] },
  'no CONSEQUENCE is named',
);
rejects('no mutation is described', { rows: [row({ mutation: '' }), secondRow()] }, 'no mutation is described');
rejects('doesNotProve is blank', { rows: [row({ doesNotProve: '' }), secondRow()] }, 'doesNotProve is empty');

// ---- overclaiming -------------------------------------------------------------------------------------------
rejects('claims measured without a run id', { rows: [row({ status: 'measured' }), secondRow()] }, 'without a hosted CI run id');
rejects('claims measured with a SHA', { rows: [row({ status: 'measured', mutationRunId: 'fe85082' }), secondRow()] }, 'without a hosted CI run id');
accepts('measured WITH a run id', { rows: [row({ status: 'measured', mutationRunId: '31113087854' }), secondRow()], maxUnproven: 1 });
rejects('a run id while not measured', { rows: [row({ mutationRunId: '31113087854' }), secondRow()] }, 'but a run id is recorded');

// ---- vocabulary and the absent/unbuildable shape -------------------------------------------------------------
rejects('an anchor outside the closed set', { rows: [row({ anchor: 'looks_fine' }), secondRow()] }, 'is not one of');
rejects('a status outside the closed set', { rows: [row({ status: 'green' }), secondRow()] }, 'is not one of');
rejects('evidence claimed with anchor none', { rows: [row({ anchor: 'none' }), secondRow()] }, 'cannot carry anchor "none"');
rejects('an unbuildable row that still cites a test', { rows: [row(), secondRow({ file: PROVING_FILE, testTitle: PROVING_TITLE })] }, 'must not cite a file or test');
rejects('an absent row claiming a real anchor', { rows: [row(), secondRow({ status: 'absent', anchor: 'database_state' })] }, 'must carry anchor "none"');

// ---- the ceiling ---------------------------------------------------------------------------------------------
rejects('more unproven rows than the ceiling allows', { maxUnproven: 0 }, 'not MEASURED but MAX_UNPROVEN');

// ---- the checker must notice when it cannot see its own subject ----------------------------------------------
test('a missing matrix is an ERROR, not a pass', () => {
  const { code, out } = run({ omitMatrix: true });
  expect(code, out).toBe(2);
  expect(out).toMatch(/CANNOT SEE ITS TARGET/);
});

test('a matrix whose table shape changed is reported, not silently ignored', () => {
  const { code, out } = run({ matrixText: '# Failure and Recovery\n\nno table here at all\n' });
  expect(code, out).toBe(1);
  expect(out).toMatch(/Could not parse any rows/);
});

// ---- and the repository itself --------------------------------------------------------------------------------
test('THE REPOSITORY ITSELF passes — the case that proves the real index is in step', () => {
  const r = spawnSync(process.execPath, [CHECKER, REPO_ROOT], { encoding: 'utf8' });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
});

// ── the mutation must be an EDIT, not a wish (ACBP-P7-008 slice 6) ────────────────────────────────────────────
// Auditing this column before running the probe, TEN of the fourteen evidence-bearing rows named no code at all
// — "widen the heartbeat grace to infinity", "skip the stop check at the step boundary". Nobody can apply one of
// those without re-deriving the author's intent, and re-derivation is where a probe quietly reddens a different
// test than the row it is filed under.

rejects(
  'a mutation that names no code at all',
  { rows: [row({ mutation: 'Widen the grace to infinity so nothing is ever reclaimed.' }), secondRow()] },
  'names NO code',
);

rejects(
  'a mutation naming a symbol that exists only in the TEST file',
  { rows: [row({ mutation: 'Delete the assertion in `theProbeHelper`.' }), secondRow()] },
  'none of which exists in non-test source',
);

rejects(
  'a mutation naming a symbol that was renamed away',
  { rows: [row({ mutation: 'Delete the guard inside `doThingRenamed`.' }), secondRow()] },
  'none of which exists in non-test source',
);

accepts('a mutation naming a source FILE rather than a function', {
  rows: [row({ mutation: 'Change the early return in `thing.ts`.' }), secondRow()],
});

// A guard that cannot see its corpus must say so, not pass. Exit 2 is "check is broken", distinct from exit 1
// "the index is wrong" — the distinction ACBP-P7-007 added after a scanner reported clean over zero files.
test('rejects: the source walk finding NO files is exit 2, not a clean run', () => {
  const { code, out } = run({ omitSource: true });
  expect(code, out).toBe(2);
  expect(out).toMatch(/CANNOT SEE ITS TARGET/);
});