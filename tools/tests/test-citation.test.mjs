/**
 * ACBP-P7-008 — regression suite for tools/lib/test-citation.mjs.
 *
 * These behaviours were EXTRACTED from `check-trust-critical-index.mjs` so that it and
 * `check-failure-scenario-index.mjs` cannot drift apart. Before the extraction they were covered only
 * indirectly, through one checker's end-to-end suite. That is not enough for shared code: a change here now
 * moves two gates at once, so each behaviour is pinned directly, at the unit.
 *
 * Every case below corresponds to a defect that actually happened. The comments say which.
 */
import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { liveTestCallFor, unescapeQuotes, norm, isRunId, readCeilingBaseline, checkCeiling } from '../lib/test-citation.mjs';

// ── liveTestCallFor ───────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 1: the original check was `src.includes(title)`. Running the real checker against these three fixtures
// printed "pinned to live tests" and exited 0 for all of them. Renaming a test broke the build; NEUTERING one
// did not — and neutering is the cheaper move for anyone chasing green.

test('a live test( call is LIVE', () => {
  expect(liveTestCallFor(`test('the claim', () => {});`, 'the claim')).toBe('live');
});

test('an it( call is LIVE too', () => {
  expect(liveTestCallFor(`it('the claim', () => {});`, 'the claim')).toBe('live');
});

test('DEFECT: test.skip is SKIPPED, not live — a skipped test is not evidence', () => {
  expect(liveTestCallFor(`test.skip('the claim', () => {});`, 'the claim')).toBe('skipped');
});

test('DEFECT: .todo and .fails are skipped too', () => {
  expect(liveTestCallFor(`test.todo('the claim');`, 'the claim')).toBe('skipped');
  expect(liveTestCallFor(`test.fails('the claim', () => {});`, 'the claim')).toBe('skipped');
});

test('DEFECT: a title surviving only in a COMMENT is not attached to a test', () => {
  expect(liveTestCallFor(`// the claim\ntest('something else', () => {});`, 'the claim')).toBe('not-a-test');
});

test('a title that is nowhere is ABSENT — distinct from present-but-unattached', () => {
  expect(liveTestCallFor(`test('other', () => {});`, 'the claim')).toBe('absent');
});

test('a LIVE duplicate beats a skipped one — the evidence exists somewhere', () => {
  const src = `test.skip('the claim', () => {});\ntest('the claim', () => {});`;
  expect(liveTestCallFor(src, 'the claim')).toBe('live');
});

test('.only and .concurrent still run, so they are LIVE', () => {
  expect(liveTestCallFor(`test.only('the claim', () => {});`, 'the claim')).toBe('live');
  expect(liveTestCallFor(`test.concurrent('the claim', () => {});`, 'the claim')).toBe('live');
});

// DEFECT 2: the fix for defect 1 scanned PRE-UNESCAPED source, and failed on the real index within a minute —
// canon item 14's title contains an apostrophe written `\'`, so unescaping first made the literal appear to end
// mid-title and a correct row reported as unattached.
test("DEFECT: a title containing an ESCAPED APOSTROPHE resolves", () => {
  const src = `test('the CALLER\\'S row is refused', () => {});`;
  expect(liveTestCallFor(src, "the CALLER'S row is refused")).toBe('live');
});

test('double-quoted and template-literal titles resolve', () => {
  expect(liveTestCallFor(`test("the claim", () => {});`, 'the claim')).toBe('live');
  expect(liveTestCallFor('test(`the claim`, () => {});', 'the claim')).toBe('live');
});

test('a title that is a PREFIX of a real one does not match — the comparison is exact', () => {
  expect(liveTestCallFor(`test('the claim goes further', () => {});`, 'the claim')).toBe('not-a-test');
});

test('an unterminated single-line literal is not mistaken for a title', () => {
  expect(liveTestCallFor(`test('the claim\nmore', () => {});`, 'the claim')).toBe('not-a-test');
});

// ── unescapeQuotes / norm ─────────────────────────────────────────────────────────────────────────────────────

test('unescapeQuotes removes backslashes before quote characters only', () => {
  expect(unescapeQuotes(String.raw`a\'b\"c\`d\ne`)).toBe(String.raw`a'b"c` + '`' + String.raw`d\ne`);
});

test('norm collapses whitespace so a REFLOWED canon line still matches', () => {
  expect(norm('  a   b \n  c ')).toBe('a b c');
});

// ── isRunId ───────────────────────────────────────────────────────────────────────────────────────────────────

test('a run id is all digits, six or more', () => {
  expect(isRunId('31113087854')).toBe(true);
  expect(isRunId('123456')).toBe(true);
});

test('a SHA is rejected because it is not entirely digits — not because of its length', () => {
  expect(isRunId('fe85082')).toBe(false);
  expect(isRunId('c17b2df')).toBe(false);
});

test('too short, empty, and non-strings are rejected', () => {
  expect(isRunId('12345')).toBe(false);
  expect(isRunId('')).toBe(false);
  expect(isRunId(undefined)).toBe(false);
  expect(isRunId('123456 ')).toBe(false);
});

test('DOCUMENTED LIMIT: a fabricated but well-formed id passes — this checks shape, never existence', () => {
  // Recorded as a test rather than only a comment, so nobody reads the gate as proof the run happened.
  // CDR-080 §7.10. `gh run view <id>` is what actually resolves it, and that is a human step.
  expect(isRunId('000000')).toBe(true);
});

// ── the ceiling ratchet ───────────────────────────────────────────────────────────────────────────────────────
// Before ACBP-P7-007's second review pass this was a plain integer whose docstring claimed "it may only ever go
// DOWN" while nothing enforced it. These cases pin the enforcement against a real git repository.

function inTempRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-ceiling-'));
  try {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'probe@example.test');
    git('config', 'user.name', 'probe');
    const write = (value) => writeFileSync(join(root, 'idx.mjs'), `export const MAX_UNPROVEN = ${value};\n`);
    write(18);
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');
    git('branch', '-M', 'main');
    return run({ root, write, git });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the baseline is read from main when origin/main is absent', () => {
  inTempRepo(({ root }) => {
    const b = readCeilingBaseline({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN' });
    expect(b).toEqual({ ref: 'main', value: 18 });
  });
});

test('an EQUAL ceiling is fine, and the note names the baseline', () => {
  inTempRepo(({ root }) => {
    const r = checkCeiling({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN', value: 18 });
    expect(r.kind).toBe('ok');
    expect(r.note).toContain('18');
    expect(r.note).toContain('main');
  });
});

test('a LOWER ceiling is fine — lowering it is the work', () => {
  inTempRepo(({ root }) => {
    expect(checkCeiling({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN', value: 17 }).kind).toBe('ok');
  });
});

test('THE RULE: a RAISED ceiling is refused, and the message says why', () => {
  inTempRepo(({ root }) => {
    const r = checkCeiling({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN', value: 19 });
    expect(r.kind).toBe('rose');
    expect(r.problem).toContain('rose from 18');
    expect(r.problem).toContain('19');
  });
});

test('an UNREADABLE baseline is reported as such — never silently as ok', () => {
  inTempRepo(({ root }) => {
    const r = checkCeiling({ cwd: root, file: 'not-on-main.mjs', constant: 'MAX_UNPROVEN', value: 999 });
    expect(r.kind).toBe('unreadable');
  });
});

test('a repository with no git history yields an unreadable baseline rather than throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'acbp-nogit-'));
  try {
    writeFileSync(join(root, 'idx.mjs'), 'export const MAX_UNPROVEN = 3;\n');
    expect(readCeilingBaseline({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN' })).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
