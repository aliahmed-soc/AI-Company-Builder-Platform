/**
 * ACBP-P7-008 — regression suite for tools/check-duplicate-exports.mjs (CDR-084 §4).
 *
 * The checker exists because two classes named `FakeModelProvider` coexisted — one that injects five kinds of
 * failure, one that cannot fail at all — and an investigation found the wrong one and concluded the
 * fault-injection rig did not exist. That false finding reached a CDR and a pull request.
 *
 * A checker that stops detecting the collision is worse than none, because a green line then reads as proof
 * that the trap is gone. Every failure mode gets a case, and so does every shape that must NOT be flagged.
 */
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { crossPackageDuplicates, exportedClassesByName } from '../check-duplicate-exports.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = join(REPO_ROOT, 'tools', 'check-duplicate-exports.mjs');

// ---- the unit -----------------------------------------------------------------------------------------------

test('THE REAL DEFECT: one name, two packages, is flagged', () => {
  const dupes = crossPackageDuplicates(
    new Map([['FakeModelProvider', [{ pkg: 'adapters', file: 'a.ts' }, { pkg: 'test-support', file: 'b.ts' }]]]),
  );
  expect(dupes).toHaveLength(1);
  expect(dupes[0].name).toBe('FakeModelProvider');
});

test('the same name TWICE IN ONE PACKAGE is not the defect — two import paths are', () => {
  const dupes = crossPackageDuplicates(
    new Map([['Thing', [{ pkg: 'core', file: 'a.ts' }, { pkg: 'core', file: 'b.ts' }]]]),
  );
  expect(dupes).toHaveLength(0);
});

test('a unique name is not flagged', () => {
  expect(crossPackageDuplicates(new Map([['Thing', [{ pkg: 'core', file: 'a.ts' }]]]))).toHaveLength(0);
});

test('duplicates are reported in a stable order, so the output does not churn', () => {
  const two = new Map([
    ['Zebra', [{ pkg: 'a', file: 'a.ts' }, { pkg: 'b', file: 'b.ts' }]],
    ['Alpha', [{ pkg: 'a', file: 'a.ts' }, { pkg: 'b', file: 'b.ts' }]],
  ]);
  expect(crossPackageDuplicates(two).map((d) => d.name)).toEqual(['Alpha', 'Zebra']);
});

// ---- discovery ----------------------------------------------------------------------------------------------

function inTempPackages(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-dupe-exports-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('`export abstract class` counts too — an abstract duplicate is the same trap', () => {
  inTempPackages(
    {
      'packages/a/src/x.ts': 'export abstract class Shared {}\n',
      'packages/b/src/y.ts': 'export class Shared {}\n',
    },
    (root) => {
      const dupes = crossPackageDuplicates(exportedClassesByName(join(root, 'packages')));
      expect(dupes.map((d) => d.name)).toEqual(['Shared']);
    },
  );
});

test('TEST FILES ARE EXCLUDED — a class inside a .test.ts cannot be imported under the wrong name', () => {
  inTempPackages(
    {
      'packages/a/src/x.ts': 'export class Local {}\n',
      'packages/b/src/y.test.ts': 'export class Local {}\n',
    },
    (root) => {
      expect(crossPackageDuplicates(exportedClassesByName(join(root, 'packages')))).toHaveLength(0);
    },
  );
});

test('a barrel RE-EXPORT is not a second definition', () => {
  inTempPackages(
    {
      'packages/a/src/x.ts': 'export class Once {}\n',
      'packages/b/src/index.ts': "export { Once } from '@acbp/a';\n",
    },
    (root) => {
      expect(crossPackageDuplicates(exportedClassesByName(join(root, 'packages')))).toHaveLength(0);
    },
  );
});

test('a non-exported class is not a duplicate — it cannot be imported at all', () => {
  inTempPackages(
    {
      'packages/a/src/x.ts': 'export class Shared {}\n',
      'packages/b/src/y.ts': 'class Shared {}\nexport const use = new Shared();\n',
    },
    (root) => {
      expect(crossPackageDuplicates(exportedClassesByName(join(root, 'packages')))).toHaveLength(0);
    },
  );
});

// ---- end to end ---------------------------------------------------------------------------------------------

test('the checker exits 1 and names both packages and files', () => {
  inTempPackages(
    {
      'packages/adapters/src/fake.ts': 'export class FakeModelProvider {}\n',
      'packages/test-support/src/fakes.ts': 'export class FakeModelProvider {}\n',
    },
    (root) => {
      const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(r.status, out).toBe(1);
      expect(out).toContain('FakeModelProvider');
      expect(out).toContain('adapters');
      expect(out).toContain('test-support');
      expect(out).toContain('src/fakes.ts');
    },
  );
});

test('the checker passes a clean tree', () => {
  inTempPackages(
    {
      'packages/a/src/x.ts': 'export class Alpha {}\n',
      'packages/b/src/y.ts': 'export class Beta {}\n',
    },
    (root) => {
      const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('duplicate-export check passed');
    },
  );
});

test('a tree with NO exported classes is an error, not a pass — a blind check must not report clean', () => {
  inTempPackages({ 'packages/a/src/x.ts': 'export const nothing = 1;\n' }, (root) => {
    const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(2);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/CANNOT SEE ITS TARGET/);
  });
});

test('THE REPOSITORY ITSELF is clean — the case that proves the rename actually landed', () => {
  const r = spawnSync(process.execPath, [CHECKER, REPO_ROOT], { encoding: 'utf8' });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
});

test('…and the trap it was built for is gone: no FakeModelProvider outside @acbp/adapters', () => {
  const byName = exportedClassesByName(join(REPO_ROOT, 'packages'));
  const hits = byName.get('FakeModelProvider') ?? [];
  expect(hits.map((h) => h.pkg)).toEqual(['adapters']);
});
