// A PROPERTY OF EVERY CHECKER, tested once here instead of nineteen times by hand.
//
// ⚠️ WHY THIS EXISTS. A sweep on 2026-08-22 asked `AGENTS.md` §3's question — does the guard actually RUN on the
// path that matters? — of all nineteen checkers in `tools/`. SIX were blind, and three of those six shared one
// defect: an unguarded `readFileSync`/`readdirSync` died with a raw Node stack at **exit 1**, which is the code
// those same checkers use for "I found something". So blindness and a real finding were indistinguishable — on
// emergency stop, on billing, and on migration reversal.
//
// Six instances of one class is the point at which the class gets a guard rather than six more fixes. This is
// that guard, and it is deliberately BEHAVIOURAL: it runs each checker against a hostile tree rather than reading
// it. Reading never found one of the six. Running against a hostile fixture found all of them.
//
// ⚠️ WHAT IT CANNOT ASK, AND WHY. Not every checker is steerable by `cwd`. `check-boundaries`, `check-encoding`
// and `check-secrets` anchor their root to `import.meta.url` (the tool's own location), so running them from an
// empty directory does not move what they scan — they correctly scan the real repository and pass. An earlier
// version of this probe reported all three as vacuous, which was the probe's error, not theirs. So the suite
// SPLITS the population on how each resolves its root and only asks the empty-tree question of those it applies
// to. Mis-attributing a hole is the same class of error as having one.
import { describe, test, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOLS = join(process.cwd(), 'tools');

/**
 * Every tool the STATIC GATE actually runs, derived from `check:static` — not from a filename glob.
 *
 * ⚠️ THIS USED TO GLOB `check-*.mjs`, WHICH IS A NAMING CONVENTION, AND KEYING A GUARD ON A NAMING CONVENTION IS
 * THE DEFECT THIS REPOSITORY KEEPS FINDING. `check-generate-route-coverage.mjs` swept for `*ForRequest` handlers
 * and a one-word rename made two paid routes invisible to it. `check-rate-limit-coverage.mjs` matched
 * `export function GET` and could not see three other ways a route is exported.
 *
 * The glob here had the same shape and the same result: `tools/render-scenario-evidence.mjs` runs in
 * `check:static` and was NOT covered, purely because it is not spelled `check-`. It happens to handle a missing
 * source correctly (exit 2) — but that was luck, not coverage, and the next tool added under a different name
 * would have been invisible too.
 *
 * Reading the gate answers the question that matters: *what does the build actually run?*
 */
function gateTools() {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const chain = pkg.scripts['check:static'] ?? '';
  const names = [...chain.matchAll(/pnpm run ([a-z0-9:-]+)/g)].map((m) => m[1]);
  const files = [];
  for (const n of names) {
    const m = (pkg.scripts[n] ?? '').match(/node (tools\/[A-Za-z0-9_\-/.]+\.mjs)/);
    if (m) files.push(m[1].replace(/^tools\//, ''));
  }
  return [...new Set(files)].sort();
}

const CHECKERS = gateTools();

/** Does this checker's root come from `process.cwd()`? Only those can be steered by spawning elsewhere. */
function isCwdRooted(file) {
  const src = readFileSync(join(TOOLS, file), 'utf8');
  return /^const (?:ROOT|REPO_ROOT)\b[^;]*process\.cwd\(\)/m.test(src);
}

const CWD_ROOTED = CHECKERS.filter(isCwdRooted);
const ANCHORED = CHECKERS.filter((f) => !isCwdRooted(f));

/**
 * Per-test budget for the spawning cases, and the spawn budget INSIDE it.
 *
 * ⚠️ THE FIRST VERSION HAD THESE INVERTED and it cost a red gate. `testTimeout` is 10s repo-wide; the spawn
 * carried `timeout: 120_000`. So a slow checker blew the TEST budget first and vitest printed
 * `Error: Test timed out in 10000ms` with no output from the checker at all — a bare timeout where the
 * diagnosis should have been. This repository has the rule written down: a helper's wait budget must be
 * strictly under its test timeout, or the timeout is the only thing you ever learn.
 *
 * They are now ordered SPAWN < TEST, so a checker that hangs is reported as a hanging checker.
 */
const TEST_BUDGET_MS = 60_000;
const SPAWN_BUDGET_MS = 45_000;

/** `process.execPath`, never the string 'node' — this repository has a recorded Windows spawn failure from that. */
function runIn(file, cwd) {
  const r = spawnSync(process.execPath, [join(TOOLS, file)], { cwd, encoding: 'utf8', timeout: SPAWN_BUDGET_MS });
  // A killed spawn returns status null; say so rather than letting `null` flow into an exit-code assertion and
  // read as some other failure.
  if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal !== null)) {
    return { status: 'TIMED_OUT', out: `spawn exceeded ${String(SPAWN_BUDGET_MS)}ms and was killed (signal ${String(r.signal)})` };
  }
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('the population is split correctly, or every verdict below is about the wrong set', () => {
  test('there are checkers in BOTH groups — a split that collapsed would silently skip everything', () => {
    expect(CHECKERS.length).toBeGreaterThanOrEqual(15);
    expect(CWD_ROOTED.length).toBeGreaterThan(0);
    expect(ANCHORED.length).toBeGreaterThan(0);
    // Pins the three known non-cwd checkers by name. If one starts using cwd, it joins the real test below and
    // this line is what tells you the population moved rather than the rule changing under you.
    expect(ANCHORED.sort()).toEqual(['check-boundaries.mjs', 'check-encoding.mjs', 'check-secrets.mjs']);
  });
});

describe('a cwd-rooted checker, asked the same two questions against an EMPTY tree', () => {
  // ONE spawn per checker, both assertions from the same output.
  //
  // ⚠️ THIS USED TO BE TWO BLOCKS AND THEREFORE TWO SPAWNS EACH. With ~40 sequential spawns (`fileParallelism`
  // is off repo-wide) three of which walk 900-1200 real files, a checker measured at 530ms standalone took 23
  // SECONDS inside the suite and blew the per-test budget. The second spawn never added information: both
  // properties are visible in one process's exit code and output.
  test.each(CWD_ROOTED)('%s', (file) => {
    const empty = mkdtempSync(join(tmpdir(), 'acbp-hygiene-'));
    let r;
    try {
      r = runIn(file, empty);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    expect(r.status, `${file} hung rather than answering: ${r.out}`).not.toBe('TIMED_OUT');

    // (1) Zero findings over zero files is not a clean tree, it is a blind checker. This is what
    // `check-conflict-targets` did — a green tick reading "Self-test passed" over nothing at all.
    expect(
      r.status,
      `${file} exited 0 over an empty directory — it reported success having scanned nothing.\n` +
        `Give it a floor (minimum files) or an exit-2 "cannot see my target" branch.\nIts output was:\n${r.out.slice(0, 400)}`,
    ).not.toBe(0);

    // (2) Exit 1 means "I found something" in every checker here, and a crash exits 1 too — but a crash carries
    // a Node stack and a real finding carries the checker's own message.
    //
    // THE DISCRIMINATOR IS A STACK FRAME, NOT THE WORD "ENOENT". An earlier version matched `\bENOENT\b` and
    // flagged `check-cursor-rules-sync`, which exits 2 correctly and QUOTES ENOENT as useful detail. A
    // diagnosis may name the errno; what it never contains is `\n    at ` frames.
    expect(
      r.out,
      `${file} died with a raw Node stack over an empty tree instead of reporting that it could not see its ` +
        `target. Guard the read and exit 2.\n${r.out.slice(0, 400)}`,
    ).not.toMatch(/\n\s+at .+\(node:|\n\s+at node:/);
  }, TEST_BUDGET_MS);
});

describe('CONTROL — the anchored tools are not exempt, the question simply does not apply', () => {
  // ⚠️ THIS NO LONGER RE-RUNS THEM, DELIBERATELY. It used to spawn all three against a temp cwd to prove they
  // still pass — three full walks of 900-1200 files, ~50s added to every static-gate run, to prove something
  // `check:static` proves a few lines earlier by running each of them on the real repository. Duplicating the
  // gate's own work inside the gate is cost without evidence.
  //
  // What is asserted instead is the REASON the empty-tree question does not apply to them: their root is the
  // tool's own location, so cwd cannot move what they scan. If one ever switches to `process.cwd()` it joins
  // CWD_ROOTED above and gets the real behavioural test.
  test.each(ANCHORED)('%s anchors its root to import.meta.url, so cwd cannot move it', (file) => {
    const src = readFileSync(join(TOOLS, file), 'utf8');
    expect(src, `${file} is in the anchored group but does not derive its root from import.meta.url`).toMatch(
      /^const (?:ROOT|REPO_ROOT)\b[^;]*import\.meta\.url/m,
    );
  });

  test('the gate itself is the behavioural proof for these three', () => {
    // Named so the reasoning above is checkable rather than asserted: check:static runs each of them.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const chain = pkg.scripts['check:static'] ?? '';
    const names = [...chain.matchAll(/pnpm run ([a-z0-9:-]+)/g)].map((m) => m[1]);
    const run = names.map((n) => (pkg.scripts[n] ?? '').match(/node tools\/([A-Za-z0-9_\-/.]+\.mjs)/)?.[1]).filter(Boolean);
    for (const a of ANCHORED) expect(run, `${a} is not run by check:static, so nothing proves it passes`).toContain(a);
  });
});
