// ACBP — coverage for `tools/check-encoding.mjs`.
//
// WHY THIS FILE EXISTS AT ALL. The checker had four signals and no tests: it was trusted because it had caught
// real damage, which is not the same as knowing it still fires. Signal 4 (raw NUL) was added on 2026-08-11 after
// a byte sweep found NULs in two tracked text files, and the standing rule in this repository is that a guard
// ships with the coverage that proves it can fail. So the guard is exercised here by CONSTRUCTION — build a tree
// that should trip it, and assert it does — rather than by trusting the message it prints.
//
// NO LITERAL CONTROL CHARACTER APPEARS IN THIS FILE. Every one is written with `String.fromCharCode`, because a
// literal would (a) make `check-encoding` fail on this test and (b) make `check-secrets` skip it — which is the
// precise pair of failures signal 4 exists to prevent.
import { describe, test, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CHECKER = join(REPO, 'tools', 'check-encoding.mjs');

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const BEL = String.fromCharCode(7);

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** Build a throwaway tree the checker will scan, and run it against that root. */
function runOn(files) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-encoding-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('check-encoding — signal 4, raw NUL', () => {
  test('a clean tree passes, so a later failure means the tree changed and not the checker', () => {
    const r = runOn({ 'packages/a/src/ok.ts': 'export const a = 1;\n', 'docs/ok.md': '# fine\n' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('encoding check passed');
  });

  test('A RAW NUL FAILS THE BUILD AND NAMES THE FILE — the rule this test was written for', () => {
    const r = runOn({ 'packages/a/src/bad.ts': `export const s = '${NUL}';\n` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('packages/a/src/bad.ts');
    expect(r.out).toContain('raw NUL');
  });

  test('the SAME file without the NUL passes — so the NUL is what failed it, not the file', () => {
    // The mutation control. Without this, a checker that rejected every file would pass the test above.
    const r = runOn({ 'packages/a/src/bad.ts': "export const s = 'x';\n" });
    expect(r.status).toBe(0);
  });

  test('a NUL in MARKDOWN fails too — the byte removes any file from the secret scan, not just code', () => {
    // docs/agent/EXECUTION-LOG.md is exactly how this was found: prose, not source.
    const r = runOn({ 'docs/note.md': `a doc that meant to print an escape${NUL}\n` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('raw NUL');
  });

  test('the message tells the reader WHY, naming the scanner that skips the file', () => {
    // A guard that says only "invalid byte" gets argued with. This one has to say what it costs.
    const r = runOn({ 'packages/a/src/bad.ts': `const s = '${NUL}';\n` });
    expect(r.out).toContain('check-secrets');
  });
});

describe('check-encoding — the older signals still fire', () => {
  test('a raw TAB in source still fails (signal 1)', () => {
    const r = runOn({ 'packages/a/src/t.ts': `const a =${TAB}1;\n` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('raw TAB');
  });

  test('a raw BEL still fails (signal 3)', () => {
    const r = runOn({ 'packages/a/src/b.ts': `// ${BEL}lready_reserved\n` });
    expect(r.status).toBe(1);
    expect(r.out).toContain('BEL');
  });
});

describe('check-encoding — the checker is not blind to itself', () => {
  test('its own source carries no raw NUL', () => {
    // THIS IS NOT HYPOTHETICAL. Adding signal 4 introduced a NUL into the very comment explaining signal 4, and
    // the new rule caught its own author on the first run. The same defect had already recurred three times
    // elsewhere in this repository, so it is pinned here rather than trusted to reviewer attention.
    expect(readFileSync(CHECKER, 'utf8')).not.toContain(NUL);
  });

  test('no tracked tool source carries a raw NUL, since one would hide that file from the secret scan', () => {
    const listed = spawnSync('git', ['-C', REPO, 'ls-files', 'tools'], { encoding: 'utf8' }).stdout ?? '';
    const offenders = listed
      .split('\n')
      .filter((f) => f.endsWith('.mjs') || f.endsWith('.ts'))
      .filter((f) => {
        try {
          return readFileSync(join(REPO, f), 'utf8').includes(NUL);
        } catch {
          return false;
        }
      });
    expect(offenders).toEqual([]);
  });
});
