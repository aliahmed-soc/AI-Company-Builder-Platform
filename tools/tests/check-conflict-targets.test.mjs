// Regression suite for `tools/check-conflict-targets.mjs`.
//
// WHAT IT GUARDS. `ON CONFLICT ON CONSTRAINT <name>` accepts only a real table CONSTRAINT. Naming a unique INDEX
// raises `42704: constraint ... does not exist` AT RUNTIME, on the first row that reaches it. In this repository
// that first row was a credit reservation: no reservation could ever succeed and the money path was dead until a
// real database ran it. Nothing in typecheck, lint or a unit test could see it.
//
// ⚠️ TWO DEFECTS IN THE CHECKER ITSELF ARE PINNED HERE, both measured rather than reasoned about.
//
// 1. NO FLOOR. Run in a freshly-created empty directory it printed "✔ conflict-target check: 0 index name(s)
//    known (0 partial); no ON CONFLICT names one. Self-test passed." and exited 0 — a green tick over nothing,
//    with "Self-test passed" attached, which made a checker that had read zero files look doubly verified. Its
//    self-test proves the REGEXES still match; it says nothing about whether anything reached them.
//
// 2. ARGV IGNORED. `ROOT` was `process.cwd()` with no override, so a test written in the shape every sibling
//    checker test uses — `spawnSync(node, [CHECKER, root])` — would have measured the runner's own cwd and
//    reported a confident pass over a directory it never looked at.
//
// Both are fixed, and this suite fails if either returns.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECKER = join(process.cwd(), 'tools', 'check-conflict-targets.mjs');

let root;

/** `process.execPath`, never the string 'node' — this repository has a recorded Windows spawn failure from that. */
function run(at) {
  const r = spawnSync(process.execPath, [CHECKER, at], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function write(rel, body) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf8');
}

/**
 * Enough real index names to clear the checker's floor.
 *
 * The floor exists because a walk that finds nothing must not report success. Every fixture has to clear it or it
 * would fail for the wrong reason — and a test that passes for the wrong reason proves nothing.
 */
function seedFloor(extra = '') {
  const lines = Array.from(
    { length: 25 },
    (_, i) => `await sql\`create unique index widget_${String(i)}_uq on public.widgets_${String(i)} (slug)\`.execute(db);`,
  );
  write('packages/database/migrations/0001_seed.ts', `${lines.join('\n')}\n${extra}\n`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acbp-conflict-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('THE DEFECT IT EXISTS FOR — an ON CONFLICT naming a unique INDEX', () => {
  test('a Kysely .constraint() naming a PARTIAL unique index fails, and says it is partial', () => {
    // The real shape from ACBP D1: migration 0041 creates the partial index, credit-repository targeted it by name.
    seedFloor(
      "await sql`create unique index credit_transactions_reservation_key_uq on public.credit_transactions (account_id, idempotency_key) where kind = 'reservation'`.execute(db);",
    );
    write(
      'packages/database/src/credit-repository.ts',
      "export const reserve = (db) => db.insertInto('credit_transactions').onConflict((oc) => oc.constraint('credit_transactions_reservation_key_uq').doNothing());\n",
    );

    const r = run(root);

    expect(r.code).toBe(1);
    expect(r.out).toContain('credit_transactions_reservation_key_uq');
    expect(r.out).toMatch(/PARTIAL/i);
  });

  test('raw SQL `on conflict on constraint` naming a non-partial index fails too', () => {
    seedFloor();
    write('apps/web/src/app/api/widgets/route.ts', 'const q = `insert into widgets_0 ... on conflict on constraint widget_0_uq do nothing`;\n');

    const r = run(root);

    expect(r.code).toBe(1);
    expect(r.out).toContain('widget_0_uq');
  });

  test('the tests/ scan root is covered — dropping it would hide a whole tree', () => {
    seedFloor();
    write('tests/adversarial/insert.test.ts', "db.insertInto('widgets_0').onConflict((oc) => oc.constraint('widget_0_uq').doNothing());\n");

    expect(run(root).code).toBe(1);
  });
});

describe('CONTROL — it does not fire on the correct forms', () => {
  test('a populated, correct tree passes AND reports a real index count', () => {
    // Asserting the COUNT matters: exit 0 alone cannot distinguish a clean tree from a blind checker, which is
    // the exact defect this suite was written after finding.
    seedFloor();
    write(
      'packages/database/src/credit-repository.ts',
      "export const reserve = (db) => db.insertInto('credit_transactions').onConflict((oc) => oc.columns(['account_id','idempotency_key']).where('kind','=','reservation').doNothing());\n",
    );

    const r = run(root);

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2[5-9] index name\(s\) known/);
  });

  test('THE NEAR MISS: naming a real CONSTRAINT is legitimate and must not fail', () => {
    // This is what proves the checker discriminates on "is this name an INDEX", rather than flagging every
    // `.constraint(...)` call it can find.
    seedFloor();
    write('packages/database/migrations/0002_constraint.ts', "await db.schema.alterTable('accounts').addUniqueConstraint('accounts_email_uq', ['email']).execute();\n");
    write('packages/database/src/account-repository.ts', "db.insertInto('accounts').onConflict((oc) => oc.constraint('accounts_email_uq').doNothing());\n");

    expect(run(root).code).toBe(0);
  });
});

describe('IT REFUSES TO PASS VACUOUSLY — the defect found in the checker itself', () => {
  test('an EMPTY tree is exit 2, not a green tick', () => {
    // Measured before the fix: this printed "✔ … 0 index name(s) known … Self-test passed." and exited 0.
    const r = run(root);

    expect(r.code).toBe(2);
    expect(r.out).toMatch(/migrations directory is not there/);
    expect(r.out).not.toMatch(/✔/);
  });

  test('a migrations directory with almost nothing in it FAILS rather than passing every target', () => {
    write('packages/database/migrations/0001_tiny.ts', 'await sql`create unique index only_one_uq on public.t (a)`.execute(db);\n');

    const r = run(root);

    expect(r.code).toBe(1);
    expect(r.out).toMatch(/expected at least/);
    expect(r.out).toMatch(/NOT a clean tree/);
  });

  test('the ROOT ARGUMENT is honoured — it used to be ignored entirely', () => {
    // Driven from the runner's cwd with an explicit root. Before the fix the argument was dropped and the
    // checker measured its own cwd, so this fixture's violation would have been invisible.
    seedFloor();
    write('packages/database/src/x.ts', "oc.constraint('widget_3_uq')\n");

    const r = run(root);

    expect(r.code).toBe(1);
    expect(r.out).toContain('widget_3_uq');
  });
});
