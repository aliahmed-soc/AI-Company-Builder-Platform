// ACBP — tests for the schema-reset-list completeness check.
//
// A guard nobody tests is a guard that can stop working without anyone noticing — and this one's whole purpose is to
// catch a silent omission, so a silently-broken version of it would be worse than none. These run the REAL checker as
// a subprocess against fixture trees, asserting both that it passes on a complete tree and that it FAILS, with a
// useful message, on each shape of omission that actually occurred.
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, '..', 'check-reset-lists.mjs');

const SCHEMA = `import type { ColumnType } from 'kysely';
export interface UsersTable { id: ColumnType<string, string, never>; }
export interface WidgetsTable { id: ColumnType<string, string, never>; }
export interface DatabaseSchema {
  users: UsersTable;
  widgets: WidgetsTable;
}
`;

/** Build a throwaway repo shaped like the real one: a schema file plus however many reset lists the test needs. */
function makeTree(resetLists) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-reset-'));
  mkdirSync(join(root, 'packages', 'database', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'database', 'src', 'schema.ts'), SCHEMA);
  mkdirSync(join(root, 'packages', 'suite'), { recursive: true });
  resetLists.forEach((content, i) => writeFileSync(join(root, 'packages', 'suite', `s${i}.integration.test.ts`), content));
  cpSync(CHECKER, join(root, 'checker.mjs'));
  return root;
}

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'checker.mjs')], { cwd: root, encoding: 'utf8' });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const complete = `const t = ['users', 'widgets', 'kysely_migration', 'kysely_migration_lock'];`;

describe('check-reset-lists', () => {
  test('passes when every reset list drops every migrated table', () => {
    const root = makeTree([complete, complete]);
    try {
      const r = run(root);
      expect(r.code).toBe(0);
      expect(r.out).toContain('reset-list check passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('FAILS when one list omits a table — the ACBP-P5-003a regression', () => {
    const root = makeTree([complete, `const t = ['users', 'kysely_migration', 'kysely_migration_lock'];`]);
    try {
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain('widgets');
      // The message must name the FILE, or the failure sends you hunting.
      expect(r.out).toContain('s1.integration.test.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('FAILS when EVERY list omits a table — the rebase regression, where nothing conflicted', () => {
    const bare = `const t = ['users', 'kysely_migration', 'kysely_migration_lock'];`;
    const root = makeTree([bare, bare, bare]);
    try {
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain('3 list(s)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('FAILS LOUDLY if it can find no reset lists at all, rather than passing vacuously', () => {
    // If the marker ever changes, the checker must not quietly report success over zero files — that is the one
    // failure mode that would make every future omission invisible.
    const root = makeTree([]);
    try {
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain('found no reset lists');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not require bookkeeping tables, which are not product schema', () => {
    const root = makeTree([`const t = ['users', 'widgets', 'kysely_migration_lock'];`]);
    try {
      expect(run(root).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
