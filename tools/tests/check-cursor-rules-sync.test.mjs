/**
 * Regression suite for tools/check-cursor-rules-sync.mjs.
 *
 * The checker exists because `.cursor/rules/model-routing.mdc` requires its `tooling/cursor-rules/` copy to stay
 * byte-identical and nothing enforced it. Every way that invariant can break gets a case here — including the
 * differences a string comparison would forgive, which are the ones most likely to slip through review.
 */
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { firstByteDifference, positionOf } from '../check-cursor-rules-sync.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = join(REPO_ROOT, 'tools', 'check-cursor-rules-sync.mjs');

// ---- The unit the checker is built on ------------------------------------------------------------------------

test('identical buffers report no difference', () => {
  expect(firstByteDifference(Buffer.from('same'), Buffer.from('same'))).toBe(-1);
});

test('a single changed byte is located exactly', () => {
  expect(firstByteDifference(Buffer.from('alwaysApply: true'), Buffer.from('alwaysApply: fals'))).toBe(13);
});

test('a truncated copy is a difference at the point it ends', () => {
  expect(firstByteDifference(Buffer.from('abcdef'), Buffer.from('abc'))).toBe(3);
  expect(firstByteDifference(Buffer.from('abc'), Buffer.from('abcdef'))).toBe(3);
});

test('THE DIFFERENCES A STRING COMPARISON WOULD FORGIVE are caught', () => {
  // CRLF against LF: identical as text once normalised, not byte-identical.
  expect(firstByteDifference(Buffer.from('rule\r\ntext'), Buffer.from('rule\ntext'))).toBe(4);
  // A UTF-8 BOM on one side only.
  expect(firstByteDifference(Buffer.from('\uFEFF# Rule'), Buffer.from('# Rule'))).toBe(0);
  // Trailing whitespace, the classic hand-copy artefact.
  expect(firstByteDifference(Buffer.from('# Rule '), Buffer.from('# Rule'))).toBe(6);
});

test('a byte offset is reported as a line and column a reader can find', () => {
  const buf = Buffer.from('one\ntwo\nthree');
  expect(positionOf(buf, 0)).toEqual({ line: 1, column: 1 });
  expect(positionOf(buf, 4)).toEqual({ line: 2, column: 1 });
  expect(positionOf(buf, 9)).toEqual({ line: 3, column: 2 });
});

// ---- End to end, against isolated directory trees -----------------------------------------------------------

function inTempTree(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-cursor-rules-sync-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
    return run({ code: r.status, out: `${r.stdout}\n${r.stderr}` });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('an identical pair passes', () => {
  inTempTree(
    {
      '.cursor/rules/model-routing.mdc': '---\nalwaysApply: true\n---\n# Rule\n',
      'tooling/cursor-rules/model-routing.mdc': '---\nalwaysApply: true\n---\n# Rule\n',
    },
    ({ code, out }) => {
      expect(code, out).toBe(0);
      expect(out).toContain('cursor-rules-sync check passed');
      expect(out).toContain('1 rule file(s) byte-identical');
    },
  );
});

test('a diverged pair fails and names the file, byte offset and line', () => {
  inTempTree(
    {
      '.cursor/rules/model-routing.mdc': '---\nalwaysApply: true\n---\n# Rule\n',
      'tooling/cursor-rules/model-routing.mdc': '---\nalwaysApply: false\n---\n# Rule\n',
    },
    ({ code, out }) => {
      expect(code, out).toBe(1);
      expect(out).toContain('model-routing.mdc DIVERGED');
      expect(out).toMatch(/line 2/);
    },
  );
});

test('a line-ending-only divergence still fails — the requirement is byte identity', () => {
  inTempTree(
    {
      '.cursor/rules/model-routing.mdc': '# Rule\r\nbody\r\n',
      'tooling/cursor-rules/model-routing.mdc': '# Rule\nbody\n',
    },
    ({ code, out }) => {
      expect(code, out).toBe(1);
      expect(out).toContain('DIVERGED');
    },
  );
});

test('a Cursor rule with no portable copy fails', () => {
  inTempTree(
    {
      '.cursor/rules/model-routing.mdc': '# Rule\n',
      'tooling/cursor-rules/other.mdc': '# Rule\n',
    },
    ({ code, out }) => {
      expect(code, out).toBe(1);
      expect(out).toContain('has no portable copy');
    },
  );
});

test('an orphaned portable copy fails — it reads as authoritative and is not', () => {
  inTempTree(
    {
      '.cursor/rules/model-routing.mdc': '# Rule\n',
      'tooling/cursor-rules/model-routing.mdc': '# Rule\n',
      'tooling/cursor-rules/renamed-away.mdc': '# Stale\n',
    },
    ({ code, out }) => {
      expect(code, out).toBe(1);
      expect(out).toContain('is an orphan');
    },
  );
});

test('non-.mdc files in either directory are none of the checker’s business', () => {
  inTempTree(
    {
      '.cursor/rules/model-routing.mdc': '# Rule\n',
      '.cursor/rules/README.md': 'notes that need no copy\n',
      'tooling/cursor-rules/model-routing.mdc': '# Rule\n',
    },
    ({ code, out }) => {
      expect(code, out).toBe(0);
    },
  );
});

test('a missing directory is exit 2, not a pass — a blind check must not report clean', () => {
  inTempTree({ '.cursor/rules/model-routing.mdc': '# Rule\n' }, ({ code, out }) => {
    expect(code, out).toBe(2);
    expect(out).toMatch(/CANNOT SEE ITS TARGET/);
  });
});

test('an empty rule directory is exit 2 — more likely a wrong root than a real state', () => {
  inTempTree(
    {
      '.cursor/rules/notes.txt': 'no rules here\n',
      'tooling/cursor-rules/notes.txt': 'no rules here\n',
    },
    ({ code, out }) => {
      expect(code, out).toBe(2);
      expect(out).toMatch(/no \.mdc rule found/);
    },
  );
});

// ---- The repository itself ----------------------------------------------------------------------------------

test('THE REPOSITORY ITSELF is in sync — the case this checker was added to keep true', () => {
  const r = spawnSync(process.execPath, [CHECKER, REPO_ROOT], { encoding: 'utf8' });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
});
