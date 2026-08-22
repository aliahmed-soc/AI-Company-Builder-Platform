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
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOLS = join(process.cwd(), 'tools');

const CHECKERS = readdirSync(TOOLS)
  .filter((f) => /^check-.*\.mjs$/.test(f))
  .sort();

/** Does this checker's root come from `process.cwd()`? Only those can be steered by spawning elsewhere. */
function isCwdRooted(file) {
  const src = readFileSync(join(TOOLS, file), 'utf8');
  return /^const (?:ROOT|REPO_ROOT)\b[^;]*process\.cwd\(\)/m.test(src);
}

const CWD_ROOTED = CHECKERS.filter(isCwdRooted);
const ANCHORED = CHECKERS.filter((f) => !isCwdRooted(f));

/** `process.execPath`, never the string 'node' — this repository has a recorded Windows spawn failure from that. */
function runIn(file, cwd) {
  const r = spawnSync(process.execPath, [join(TOOLS, file)], { cwd, encoding: 'utf8', timeout: 120_000 });
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

describe('a cwd-rooted checker must never report success over an EMPTY tree', () => {
  // This is the whole rule: zero findings over zero files is not a clean tree, it is a blind checker. Exit 0
  // there means the checker cannot tell the difference, which is what `check-conflict-targets` did — it printed
  // a green tick reading "Self-test passed" while having read nothing at all.
  test.each(CWD_ROOTED)('%s', (file) => {
    const empty = mkdtempSync(join(tmpdir(), 'acbp-hygiene-'));
    try {
      const r = runIn(file, empty);
      expect(
        r.status,
        `${file} exited 0 over an empty directory — it reported success having scanned nothing.\n` +
          `Give it a floor (minimum files) or an exit-2 "cannot see my target" branch.\nIts output was:\n${r.out.slice(0, 400)}`,
      ).not.toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('blindness must not be reported with a raw Node stack', () => {
  // Exit 1 means "I found something" in every checker here. A crash also exits 1 — but a crash carries a Node
  // stack, and a real finding carries the checker's own message. Three checkers were crashing: on emergency
  // stop, on billing, and on migration reversal. A caller could not tell those apart.
  test.each(CWD_ROOTED)('%s reports its own diagnosis, not a Node stack', (file) => {
    const empty = mkdtempSync(join(tmpdir(), 'acbp-hygiene-crash-'));
    try {
      const r = runIn(file, empty);
      // ⚠️ THE DISCRIMINATOR IS A STACK FRAME, NOT THE WORD "ENOENT". The first version of this assertion
      // matched `\bENOENT\b` and flagged `check-cursor-rules-sync`, which exits 2 correctly and QUOTES ENOENT
      // in its own message as useful detail — "ENOENT — no rule file was compared". A checker's own diagnosis
      // may name the errno; what it never contains is `\n    at ` frames. Matching the word would have made
      // this suite punish a checker for being informative, which is how a guard earns deletion.
      expect(
        r.out,
        `${file} died with a raw Node stack over an empty tree instead of reporting that it could not see its ` +
          `target. Guard the read and exit 2.\n${r.out.slice(0, 400)}`,
      ).not.toMatch(/\n\s+at .+\(node:|\n\s+at node:/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('CONTROL — the anchored checkers are not broken, they are simply not steerable this way', () => {
  // Without this the suite could be read as "those three are exempt". They are not exempt; the question does not
  // apply, and the reason is checkable: they scan the real repository regardless of cwd, so they pass there.
  test.each(ANCHORED)('%s still passes when run from an unrelated directory', (file) => {
    const empty = mkdtempSync(join(tmpdir(), 'acbp-hygiene-anchored-'));
    try {
      const r = runIn(file, empty);
      expect(r.status, `${file} is anchored to import.meta.url, so cwd should not affect it`).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
