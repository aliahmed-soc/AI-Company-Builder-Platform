// Regression suite for `tools/check-migration-drain-loops.mjs`.
//
// The guard has run in `check:static` since it was written and has never been watched go RED. AGENTS.md §3:
// a guard you have not watched fail against the real defect is a hypothesis. The real defect is pinned first:
// a `migrateDown` drain loop whose numeric iteration cap is at or below the migration count, which is how
// ACBP-P6-009's migration 0051 and ACBP-P6-011's 0052 each broke an integration test on an unrelated PR.
//
// HOW THIS DRIVES THE CHECKER, and why it is not the house `check(root)` pattern. The checker has no
// `check(root)`: `ROOT` is `process.cwd()` captured at module scope, the filesystem walk lives inline in
// `main()`, and `main()` is invoked unconditionally with no `import.meta.url` guard. So every filesystem case
// here SPAWNS the script with `cwd` pointed at a throwaway tree, which is the only way to move its root today.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const SCRIPT = join(process.cwd(), 'tools', 'check-migration-drain-loops.mjs');
const SOURCE = readFileSync(SCRIPT, 'utf8');

// A plain `import` of the checker EXECUTES the repository-wide check as an import side effect, and its
// `process.exit(1)` would kill the vitest worker mid-run. Strip the entry-point call, then ASSERT the strip
// landed: if `main();` is ever renamed this must fail loudly rather than silently importing a self-running
// module. (The real fix is the `import.meta.url` main-guard every other tested checker here already has.)
const STRIPPED = SOURCE.replace(/^main\(\);[ \t]*$/m, '');
if (STRIPPED === SOURCE) {
  throw new Error('check-migration-drain-loops.mjs no longer ends in a bare `main();` — re-check how this suite loads it.');
}
const { blankNonCode, drainLoops, verdict } = await import(
  `data:text/javascript;base64,${Buffer.from(STRIPPED, 'utf8').toString('base64')}`
);

const DRAIN_FILE = 'packages/database/src/integration/drain.integration.test.ts';

// The `for` lands on line 3 of this source; the failure message quotes that line number.
const drainSource = (cap) => `import { migrateDown } from '../index.js';
test('migrations reverse fully', async () => {
  for (let i = 0; i < ${cap}; i++) {
    const down = await migrateDown(client);
    if ((down.results?.length ?? 0) === 0) break;
  }
});
`;

let root;

/**
 * THE FLOOR, and it is the whole reason a fixture here can pass for the wrong reason:
 *
 *  1. `<root>/packages/database/migrations` MUST EXIST — but for a different reason than when this was
 *     written. It USED TO BE that `main()` called `readdirSync` on it unguarded, so a missing directory was
 *     an uncaught ENOENT: exit 1 with a stack trace, red at the wrong thing, and a test asserting only
 *     `status === 1` would have accepted it. That is FIXED — a missing directory is now exit 2 with the
 *     checker's own diagnosis, and `describe('a missing target is blindness…')` at the bottom pins it.
 *     Fixtures still have to create the directory, because every OTHER case here wants the real code path.
 *  2. It MUST CONTAIN FILES MATCHING /^\d{4}_.*\.ts$/. With an empty directory `migrationCount` is 0 and
 *     `bound <= 0` is false for every positive cap, so the defect becomes UNREACHABLE and the checker
 *     reports success. `describe('the trap...')` below pins that so nobody rediscovers it by accident.
 *  3. The drain loop must be a `.ts` file (not `.d.ts`) under `<root>/packages` or `<root>/tests`, outside
 *     node_modules/dist/build, with a BRACED body. Every one of those is silently invisible to the walk.
 *
 * Migration fixtures are themselves walked (they sit under `packages`), so their bodies stay free of the
 * string `migrateDown` — otherwise a fixture would register as a drain loop of its own.
 */
function build({ migrations = 5, files = { [DRAIN_FILE]: drainSource(1000) } } = {}) {
  const migDir = join(root, 'packages', 'database', 'migrations');
  mkdirSync(migDir, { recursive: true });
  for (let i = 1; i <= migrations; i += 1) {
    writeFileSync(
      join(migDir, `${String(i).padStart(4, '0')}_fixture.ts`),
      'export const up = async () => {};\nexport const down = async () => {};\n',
      'utf8',
    );
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
}

function run(cwd = root) {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acbp-drain-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the defect this checker exists to catch', () => {
  test('RED: a cap at the migration count is reported, with file, line, cap and count', () => {
    // ACBP-P6-009 exactly: the loop reverses one migration per call and runs out one short.
    build({ migrations: 5, files: { [DRAIN_FILE]: drainSource(5) } });
    const r = run();
    expect(r.status).toBe(1);
    // ASSERT THE MESSAGE, NOT THE CODE. The blind case below ALSO exits 1, so a status-only assertion
    // cannot tell "found the short loop" from "could not see any loop at all".
    expect(r.out).toContain('cannot reverse all 5 migrations');
    expect(r.out).toContain(`${DRAIN_FILE}:3 `);
    expect(r.out).toContain('iteration cap 5, migrations 5');
  });

  test('RED: a cap BELOW the count is reported too', () => {
    build({ migrations: 8, files: { [DRAIN_FILE]: drainSource(5) } });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('iteration cap 5, migrations 8');
  });

  test('RED: every short loop is named, not just the first — the second copy is what P6-011 missed', () => {
    build({
      migrations: 8,
      files: {
        [DRAIN_FILE]: drainSource(5),
        'packages/database/src/integration/user-mapping.integration.test.ts': drainSource(6),
      },
    });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('2 loop(s) cannot reverse all 8 migrations');
    expect(r.out).toContain('iteration cap 5, migrations 8');
    expect(r.out).toContain('iteration cap 6, migrations 8');
  });

  test('the off-by-one boundary: cap === count FAILS, cap === count + 1 passes', () => {
    build({ migrations: 5, files: { [DRAIN_FILE]: drainSource(5) } });
    expect(run().status).toBe(1);
    build({ migrations: 5, files: { [DRAIN_FILE]: drainSource(6) } });
    expect(run().status).toBe(0);
  });
});

describe('THE CONTROL — a clean tree must pass, or this suite proves nothing', () => {
  // Without this, a checker rewritten to `process.exit(1)` unconditionally would satisfy every RED case above.
  test('the repository convention (cap 1000) passes and says what it inspected', () => {
    build({ migrations: 5, files: { [DRAIN_FILE]: drainSource(1000) } });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('migration-drain-loop check passed (1 loop(s), 5 migrations)');
    expect(r.out).toContain('Self-test passed');
  });

  test('a clean tree still passes when the migration count grows underneath it', () => {
    build({ migrations: 200, files: { [DRAIN_FILE]: drainSource(1000) } });
    expect(run().status).toBe(0);
  });

  test('an unbounded drain loop is not coupled to the count and passes', () => {
    build({
      migrations: 5,
      files: {
        [DRAIN_FILE]: 'import { migrateDown } from "../index.js";\nfor (;;) { const d = await migrateDown(client); if (!d.results?.length) break; }\n',
      },
    });
    expect(run().status).toBe(0);
  });

  test('a for-loop that does NOT call migrateDown is left alone', () => {
    build({
      migrations: 5,
      files: {
        [DRAIN_FILE]: drainSource(1000),
        'packages/database/src/unrelated.ts': 'for (let d = 0; d < 3; d++) { cursor = cursor.next; }\n',
      },
    });
    expect(run().status).toBe(0);
  });
});

describe('a vanished target is not agreement', () => {
  test('seeing NO drain loop anywhere FAILS, with a message distinct from a real finding', () => {
    build({ migrations: 5, files: {} });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('no `migrateDown` loop found anywhere');
    expect(r.out).toContain('this check can no longer see what it guards');
    expect(r.out).not.toContain('iteration cap');
  });

  test('deleting the loop to silence the checker does not silence it', () => {
    build({ migrations: 5, files: { [DRAIN_FILE]: drainSource(5) } });
    expect(run().out).toContain('iteration cap 5');
    build({ migrations: 5, files: { [DRAIN_FILE]: 'export {};\n' } });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('Do not delete this check');
  });

  test('a missing migrations directory is not a pass', () => {
    mkdirSync(join(root, 'packages'), { recursive: true });
    expect(run().status).not.toBe(0);
  });
});

describe('the trap that would make every RED case above vacuous', () => {
  test('ZERO migration files makes a short cap PASS — a fixture that skips the floor tests nothing', () => {
    // Pinned deliberately. `bound <= 0` is false for every positive cap, so with an empty migrations
    // directory the defect cannot be expressed and `check:static` goes green on a cap of 5.
    mkdirSync(join(root, 'packages', 'database', 'migrations'), { recursive: true });
    mkdirSync(dirname(join(root, DRAIN_FILE)), { recursive: true });
    writeFileSync(join(root, DRAIN_FILE), drainSource(5), 'utf8');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('0 migrations');
  });

  test('files not matching NNNN_*.ts are not migrations and do not raise the count', () => {
    build({ migrations: 0, files: { [DRAIN_FILE]: drainSource(5) } });
    writeFileSync(join(root, 'packages', 'database', 'migrations', 'helpers.ts'), 'export const x = 1;\n', 'utf8');
    writeFileSync(join(root, 'packages', 'database', 'migrations', '007_short.ts'), 'export const x = 1;\n', 'utf8');
    expect(run().out).toContain('0 migrations');
  });
});

describe('what the walk cannot see (pinned so a future fixture is not built on sand)', () => {
  const short = 'for (let i = 0; i < 5; i++) { const d = await migrateDown(client); }\n';

  test('a .d.ts declaration file is skipped', () => {
    build({ migrations: 5, files: { 'packages/database/src/drain.d.ts': short } });
    expect(run().out).toContain('no `migrateDown` loop found anywhere');
  });

  test('node_modules is skipped', () => {
    build({ migrations: 5, files: { 'packages/database/node_modules/dep/drain.ts': short } });
    expect(run().out).toContain('no `migrateDown` loop found anywhere');
  });

  test('a root-level tests/ directory IS a search root', () => {
    build({ migrations: 5, files: { 'tests/adversarial/drain.test.ts': short } });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.out).toContain('iteration cap 5, migrations 5');
  });

  test('KNOWN GAP: a braceless loop body is invisible, so this real defect goes UNCAUGHT', () => {
    // `drainLoops` requires `{` after the header. `for (...) await migrateDown(c);` is coupled to the
    // migration count in exactly the same way and is not reported. Pinned as current behaviour, not as
    // approval — if the parser is widened, this test is the one that should be rewritten.
    build({
      migrations: 5,
      files: { [DRAIN_FILE]: 'import { migrateDown } from "../index.js";\nfor (let i = 0; i < 5; i++) await migrateDown(client);\n' },
    });
    expect(run().out).toContain('no `migrateDown` loop found anywhere');
  });

  test('KNOWN GAP: a decrementing loop has no `<` bound, so it PASSES while still being coupled', () => {
    build({
      migrations: 5,
      files: { [DRAIN_FILE]: 'import { migrateDown } from "../index.js";\nfor (let i = 5; i > 0; i--) { const d = await migrateDown(client); }\n' },
    });
    expect(run().status).toBe(0);
  });
});

describe('the extractors, which must not read prose as code', () => {
  test('a commented-out call is not a drain loop', () => {
    expect(drainLoops('for (let i = 0; i < 50; i++) {\n  // await migrateDown(client);\n}')).toHaveLength(0);
    expect(drainLoops('for (let i = 0; i < 50; i++) {\n  /* await migrateDown(client); */\n}')).toHaveLength(0);
  });

  test('the call named inside a string or template is not a drain loop', () => {
    expect(drainLoops("for (let i = 0; i < 50; i++) {\n  log('migrateDown is slow');\n}")).toHaveLength(0);
    expect(drainLoops('for (let i = 0; i < 50; i++) {\n  log(`migrateDown ${i}`);\n}')).toHaveLength(0);
  });

  test('blanking preserves line numbers so the reported line is the real one', () => {
    expect(blankNonCode('// a\n/* b\n c */\nfor').split('\n')).toHaveLength(4);
    expect(drainLoops('// migrateDown\n\nfor (let i = 0; i < 5; i++) {\n  await migrateDown(c);\n}')[0].line).toBe(3);
  });

  test('a compound header still yields its numeric cap', () => {
    expect(drainLoops('for (let i = 0; i < 50 && (await n()) > 0; i++) {\n  await migrateDown(c);\n}')[0].bound).toBe(50);
  });

  test('verdict: empty input is a FAILURE, not a vacuous pass', () => {
    const v = verdict([], 56);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('can no longer see what it guards');
  });

  test('verdict uses <=, not <, against the count', () => {
    expect(verdict([{ line: 1, bound: 56 }], 56).ok).toBe(false);
    expect(verdict([{ line: 1, bound: 57 }], 56).ok).toBe(true);
    expect(verdict([{ line: 1, bound: null }], 56).ok).toBe(true);
  });
});

describe('the repository itself', () => {
  test('passes its own check, and the floor proves it inspected something', () => {
    const r = run(process.cwd());
    expect(r.status).toBe(0);
    const m = /passed \((\d+) loop\(s\), (\d+) migrations\)/.exec(r.out);
    expect(m).not.toBeNull();
    // If either number collapses, the check has stopped checking while still printing a tick.
    expect(Number(m[1])).toBeGreaterThanOrEqual(3);
    expect(Number(m[2])).toBeGreaterThanOrEqual(50);
  });

  test('the two integration drain loops still carry the 1000 convention', () => {
    for (const f of [
      'packages/database/src/integration/database.integration.test.ts',
      'packages/database/src/integration/user-mapping.integration.test.ts',
    ]) {
      const loops = drainLoops(readFileSync(join(process.cwd(), f), 'utf8'));
      expect(loops.length, `${f} lost its migrateDown drain loop`).toBeGreaterThanOrEqual(1);
      expect(loops.some((l) => l.bound === 1000), `${f} no longer caps at 1000`).toBe(true);
    }
  });
});

describe('a missing target is blindness (exit 2), not a finding (exit 1)', () => {
  // ⚠️ THIS PATH WAS UNTESTED, AND UNTIL THIS CHANGE IT WAS ALSO BROKEN. `main()` read the migrations
  // directory unguarded, so a tree without it died with a raw Node readdir stack at exit 1 — the SAME code
  // as "a drain loop is too short to reverse every migration". On a check whose entire subject is that
  // count, blindness and a finding were indistinguishable.
  //
  // The suite documented the problem in a comment and asserted only exit 0 and exit 1. A comment is not a
  // control; this is.
  test('a tree with no migrations directory exits 2, names the target, and does not crash', () => {
    // `root` is created empty by `beforeEach` and `build()` is deliberately NOT called, so there is no
    // migrations directory. Uses the suite's own `run()` helper rather than a second spawn of its own — the
    // first draft of this test spawned `[CHECKER]`, a name this file does not define, and got status -1 from
    // a process that never started. A test that fails for a reason unrelated to its subject proves nothing.
    const r = run();

    expect(r.status, 'blindness must not share an exit code with a finding').toBe(2);
    expect(r.out).toContain('CANNOT SEE ITS TARGET');
    expect(r.out).toContain('migrations');
    expect(r.out, 'a raw stack means the read is unguarded again').not.toContain('ENOENT');
  });
});
