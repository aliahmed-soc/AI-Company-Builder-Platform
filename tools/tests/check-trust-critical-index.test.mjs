/**
 * ACBP-P7-007 — Permanent regression suite for tools/check-trust-critical-index.mjs (CDR-080 §6).
 *
 * The checker exists because a table of attributions is not evidence: ACBP-P7-002 found canon crediting
 * ACBP-P6-007 for a gate it never built. A checker that stops detecting that is worse than no checker, because
 * a green run then reads as a verified claim. So every failure mode gets a case here.
 *
 * Each case builds an ISOLATED temporary workspace under the OS temp dir (never the real source tree), runs the
 * checker against it via its scan-root argument, asserts the exit code and the expected message, and cleans up.
 *
 * Run: pnpm run test:boundaries   (or `pnpm test`, which includes it)
 */
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = join(REPO_ROOT, 'tools', 'check-trust-critical-index.mjs');

const CANON_PATH = 'docs/implementation/TEST-AND-VERIFICATION-STRATEGY.md';
const PROVING_FILE = 'packages/core/src/probe.test.ts';
const PROVING_TITLE = 'the probe control refuses and writes nothing';

/** Two-item canon list, including a wrapped item so continuation parsing stays covered. */
const canon = (items = 2) => {
  const lines = ['# Strategy', '', '## Trust-critical negative tests (mandatory)', ''];
  lines.push('1. Alpha cannot reach Bravo. *(P0-001)*');
  if (items >= 2) {
    lines.push('2. Charlie cannot execute after revocation. *(P0-002 — **built**;');
    lines.push('   evidence lives elsewhere.)*');
  }
  lines.push('', '## Verification discipline', '');
  return lines.join('\n');
};

const row = (over = {}) => ({
  number: 1,
  statement: 'Alpha cannot reach Bravo.',
  attributedTo: 'P0-001',
  builtBy: 'ACBP-P0-001',
  status: 'unmeasured',
  anchor: 'database_state',
  file: PROVING_FILE,
  testTitle: PROVING_TITLE,
  entryPoint: 'doThing',
  mutation: 'Delete the guard.',
  mutationRunId: '',
  doesNotProve: 'Nothing beyond the single path.',
  ...over,
});

const secondRow = (over = {}) =>
  row({
    number: 2,
    statement: 'Charlie cannot execute after revocation.',
    attributedTo: 'P0-002',
    builtBy: 'nobody',
    status: 'unprovable',
    anchor: 'none',
    file: '',
    testTitle: '',
    entryPoint: '',
    mutation: '',
    doesNotProve: 'No revocation entity exists.',
    ...over,
  });

function write(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * @param {{ rows?: object[], maxUnproven?: number, canonText?: string, omitProvingFile?: boolean }} opts
 */
function run(opts = {}) {
  const rows = opts.rows ?? [row(), secondRow()];
  const root = mkdtempSync(join(tmpdir(), 'acbp-tc-index-'));
  try {
    write(root, CANON_PATH, opts.canonText ?? canon());
    if (!opts.omitProvingFile) {
      write(root, PROVING_FILE, `import { test } from 'vitest';\ntest('${PROVING_TITLE}', () => {});\n`);
    }
    write(
      root,
      'tools/trust-critical-index.mjs',
      [
        `export const ANCHOR_CLASSES = Object.freeze(['database_state','recorded_row','return_value_only','pure_helper_only','none']);`,
        `export const STATUSES = Object.freeze(['measured','unmeasured','not_covered','unprovable']);`,
        `export const MAX_UNPROVEN = ${opts.maxUnproven ?? 2};`,
        `export const TRUST_CRITICAL_INDEX = Object.freeze(${JSON.stringify(rows)});`,
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

// ---- The control. Without this, every rejection below could pass for the wrong reason. ------------------
accepts('a well-formed index over a two-item canon list', {});

// ---- THE FAILURE THIS TOOL EXISTS FOR: a canon item with no evidence at all --------------------------------
rejects('a canon item with no index row', { rows: [row()] }, 'Canon item 2 has NO index row');
rejects('an index row matching no canon item', { rows: [row(), secondRow(), row({ number: 3 })] }, 'matches no canon item');
rejects('two rows sharing a number', { rows: [row(), row(), secondRow()] }, 'TWO rows numbered 1');

// ---- Drift between the claim and the code -----------------------------------------------------------------
rejects('the statement drifted from canon', { rows: [row({ statement: 'Alpha may reach Bravo sometimes.' }), secondRow()] }, 'statement drift');
rejects('the cited file no longer exists', { omitProvingFile: true }, 'cited file does not exist');
rejects(
  'the cited test was renamed',
  { rows: [row({ testTitle: 'a title nobody wrote' }), secondRow()] },
  'cited test title is NOT in',
);

// ---- Overclaiming ------------------------------------------------------------------------------------------
rejects(
  'claims measured without a hosted CI run id',
  { rows: [row({ status: 'measured' }), secondRow()] },
  'without a hosted CI run id',
);
rejects(
  'claims measured with a SHA rather than a run id',
  { rows: [row({ status: 'measured', mutationRunId: 'fe85082' }), secondRow()] },
  'without a hosted CI run id',
);
accepts('measured WITH a run id', { rows: [row({ status: 'measured', mutationRunId: '31074920228' }), secondRow()], maxUnproven: 1 });
rejects(
  'records a run id while still calling itself unmeasured',
  { rows: [row({ mutationRunId: '31074920228' }), secondRow()] },
  'but a run id is recorded',
);
rejects(
  'names no mutation, so nothing was ever tried',
  { rows: [row({ mutation: '   ' }), secondRow()] },
  'no mutation is described',
);

// ---- The ratchet -------------------------------------------------------------------------------------------
rejects('more unproven rows than the ratchet allows', { maxUnproven: 0 }, 'RATCHET');

// THE RATCHET MUST NOT PUNISH NEW COVERAGE. A first version of this counted unmeasured alone, so the moment a
// negative gained its first test (item 15, slice 3) the row moved not_covered -> unmeasured, the count ROSE, and
// the build failed FOR ADDING A TEST. Counting every not-yet-measured row makes the total flat across that move.
accepts('giving an uncovered negative its first test does NOT trip the ratchet', {
  rows: [
    row(),
    secondRow({ status: 'unmeasured', anchor: 'database_state', file: PROVING_FILE, testTitle: PROVING_TITLE, mutation: 'Delete the other guard.' }),
  ],
  maxUnproven: 2,
});

// ---- Vocabulary and honesty columns ------------------------------------------------------------------------
rejects('an anchor outside the closed vocabulary', { rows: [row({ anchor: 'looks_fine' }), secondRow()] }, 'is not one of');
rejects('a status outside the closed vocabulary', { rows: [row({ status: 'green' }), secondRow()] }, 'is not one of');
rejects('an empty doesNotProve', { rows: [row({ doesNotProve: '' }), secondRow()] }, 'doesNotProve is empty');
rejects(
  'evidence claimed with anchor "none"',
  { rows: [row({ anchor: 'none' }), secondRow()] },
  'cannot carry anchor "none"',
);
rejects(
  'a not-covered row that still cites a test',
  { rows: [row(), secondRow({ status: 'not_covered', file: PROVING_FILE, testTitle: PROVING_TITLE })] },
  'must not cite a file or test',
);
rejects(
  'a not-covered row claiming a real anchor',
  { rows: [row(), secondRow({ anchor: 'database_state' })] },
  'must carry anchor "none"',
);

// ---- The checker must notice when it can no longer see its own subject --------------------------------------
rejects('the canon heading was renamed away', { canonText: '# Strategy\n\n## Something else\n\n1. Alpha cannot reach Bravo. *(P0-001)*\n' }, 'Could not parse any items');
