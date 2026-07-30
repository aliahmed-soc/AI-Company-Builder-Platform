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

/**
 * A reset list is a list that is USED TO DROP (ACBP-P6-003b). The fixtures therefore include the drop loop, which is
 * also more faithful than the bare arrays they replace: an array of table names that nothing drops is not a reset
 * list, and the checker now says so rather than counting it.
 */
const dropLoop = (tables) => `for (const x of [${tables.map((t) => `'${t}'`).join(', ')}]) { await db.schema.dropTable(x).ifExists().execute(); }`;
const complete = dropLoop(['users', 'widgets', 'kysely_migration', 'kysely_migration_lock']);
const short = dropLoop(['users', 'kysely_migration', 'kysely_migration_lock']);

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
    const root = makeTree([complete, short]);
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
    const root = makeTree([short, short, short]);
    try {
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain('3 list(s)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('FAILS when a file has TWO drop lists and only ONE is complete — the ACBP-P6-003b regression', () => {
    // THE HOLE THIS GUARD SHIPPED WITH. The rule was "a file passes if ANY ONE of its lists can drop everything", so
    // `activity.integration.test.ts` — which has three drop lists — passed on the strength of one while two stayed
    // short. The suite then died with `42P07 relation "approval_requests" already exists`, exactly the failure the
    // checker's own header describes. 29 lists across 28 files were short in that state.
    const root = makeTree([`${complete}\n${short}`]);
    try {
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain('widgets');
      // The message must say WHICH list, not just which file, or the reader fixes the one that was already fine.
      expect(r.out).toContain('drop list');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('IGNORES a partial list that nothing drops — a truncate list is allowed to be short', () => {
    // Files legitimately hold partial lists: `provisioning.integration.test.ts` keeps its seeded account and company
    // across tests on purpose. A short TRUNCATE list leaks rows between tests, which is a real problem and a DIFFERENT
    // one — it cannot cause the CREATE TABLE collision this guard exists to prevent, and failing it here would make
    // the guard cry wolf on correct code.
    const truncateOnly = `await sql\`truncate table users\`.execute(db);\nconst keep = ['users', 'kysely_migration_lock'];`;
    const root = makeTree([`${complete}\n${truncateOnly}`]);
    try {
      const r = run(root);
      expect(r.code).toBe(0);
      expect(r.out).toContain('reset-list check passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('IGNORES a drop inside an ASSERTION — a negative test is not a reset list', () => {
    // `company.integration.test.ts` asserts that the restricted role CANNOT drop tables, looping over three of them
    // inside `expect(...).rejects.toThrow()`. Proximity alone read that as a drop list and demanded all 51 tables —
    // the same inversion the header records for the first version of this guard, where an assertion that a table
    // EXISTS was taken as evidence that the file could remove it.
    const negative = `for (const x of ['users', 'kysely_migration_lock']) { await expect(db.run(\`drop table \${x}\`)).rejects.toThrow(); }`;
    const root = makeTree([`${complete}\n${negative}`]);
    try {
      const r = run(root);
      expect(r.code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('counts LISTS, not files, so the pass message cannot overstate what was checked', () => {
    const root = makeTree([`${complete}\n${complete}`, complete]);
    try {
      const r = run(root);
      expect(r.code).toBe(0);
      // Three drop lists across two files. The old message said "2 reset lists" for this shape.
      expect(r.out).toContain('3 drop list(s) across 2 file(s)');
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

  test('FAILS when the table is only MENTIONED elsewhere in the file, not dropped — the ACBP-P5-003b false negative', () => {
    // The first version of this checker asked whether the name appeared anywhere in the file. A suite that drops
    // nothing but merely asserts `expect(names).toContain('widgets')` satisfied it — exactly backwards, since that
    // assertion proves the table EXISTS and the checker concluded the file could remove it.
    // `database.integration.test.ts` was live in precisely this state: its drop list omitted `task_runs` while a
    // `toContain('task_runs')` two hundred lines away kept the guard quiet.
    const decoy = `${short}\nexpect(names).toContain('widgets');`;
    const root = makeTree([decoy]);
    try {
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.out).toContain('widgets');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reads a list written one table per line WITH comments between them, as the real ones are', () => {
    const commented = `const t = [\n  // global config, not tenant data\n  'users',\n  // the widget store\n  'widgets',\n  'kysely_migration_lock',\n];\nfor (const x of t) { await db.schema.dropTable(x).execute(); }`;
    const root = makeTree([commented]);
    try {
      expect(run(root).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores an unrelated array of non-table strings rather than treating it as a broken list', () => {
    const withNoise = `const states = ['queued', 'running', 'succeeded'];\n${complete}`;
    const root = makeTree([withNoise]);
    try {
      expect(run(root).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not require bookkeeping tables, which are not product schema', () => {
    const root = makeTree([dropLoop(['users', 'widgets', 'kysely_migration_lock'])]);
    try {
      expect(run(root).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
