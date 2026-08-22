// ACBP — tests for the stop-port check (ACBP-P6-007; CDR-072 §0).
//
// AGENTS.md §3: "A guard you have not watched go RED against the real defect is a hypothesis, not a control."
// `tools/check-stop-port.mjs` ships in `check:static` and has never been watched fail. These tests drive the REAL
// checker as a subprocess against throwaway trees and assert BOTH directions, because a silently-broken version of
// this check is worse than no check: it would report a clean tree forever while the bypass it guards sat open.
//
// THE DEFECT UNDER TEST is a caller-injectable `stop` gate coexisting with a real stop engine — a caller passing
// `stop: () => ({ kind: 'clear' })` walks straight through a live emergency stop.
//
// TWO WAYS THIS SUITE COULD HAVE BEEN VACUOUS, both measured and both closed below:
//   1. The checker `readFileSync`s the dispatcher UNGUARDED (line 85). A tree with no `dispatcher.ts` exits 1 with
//      an ENOENT stack trace — the SAME exit code as a real violation. A test asserting only `code === 1` passes
//      while the checker detected nothing. Every RED case therefore asserts the banner AND asserts no crash.
//   2. Exit 2 ("CANNOT SEE ITS TARGET") is blindness, not a pass. It is asserted as its own outcome, never folded
//      into "did not exit 1".
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, '..', 'check-stop-port.mjs');
const REPO_ROOT = join(HERE, '..', '..');

// The checker exports nothing and takes no argv; its ROOT is `process.cwd()`, so `cwd` IS the root parameter.
const PORT_HOSTS = ['ToolGates', 'DispatcherOptions'];

const SCAFFOLD = '// core/stops — module public index (scaffold). No implementation yet.\nexport {};\n';
const REAL_MODULE = "export { activateStop, clearStop } from './stop-service.js';\n";

const KYSELY_MIGRATION = { '0050_emergency_stops.ts': "await db.schema.createTable('emergency_stops').addColumn('id', 'uuid').execute();\n" };
const RAW_SQL_MIGRATION = { '0050_held_work.ts': 'await sql`create table if not exists public.held_work (id uuid)`.execute(db);\n' };

/** A dispatcher shaped like the real one. Closing braces sit at column 0 — the checker's block regex ends at `\n}`. */
const dispatcherSource = ({ gates = '', options = '' } = {}) =>
  `import type { StopAnswer } from '@acbp/contracts';
export interface ToolGates {
${gates}  readonly _never?: never;
}
export interface DispatcherOptions {
  readonly correlationId?: string;
${options}  readonly now?: Date;
}
export async function dispatchToolCall() {}
`;

/**
 * A throwaway repo shaped like the real one.
 *
 * THE FLOOR IS ENFORCED BY THROWING, not by returning something unusable: a fixture that cannot produce the
 * identity under test must throw. Both floors below were measured against the real checker, not guessed.
 */
function makeTree({ stops = SCAFFOLD, dispatcher, migrations = {}, allowBlind = false }) {
  if (typeof dispatcher !== 'string' || dispatcher.trim() === '') {
    throw new Error(
      'FIXTURE FLOOR: packages/core/src/tools/dispatcher.ts must exist and be non-empty. The checker readFileSync()s ' +
        'it unguarded, so a missing file exits 1 with an ENOENT stack — indistinguishable BY EXIT CODE from a real ' +
        'violation, which would make a RED assertion vacuous.',
    );
  }
  if (!allowBlind) {
    for (const host of PORT_HOSTS) {
      if (!new RegExp(`export\\s+interface\\s+${host}\\s*\\{[\\s\\S]*?\\n\\}`).test(dispatcher)) {
        throw new Error(
          `FIXTURE FLOOR: \`export interface ${host}\` must be present with its closing brace at column 0. Missing ` +
            'either host makes the checker exit 2 (blind) instead of judging the port, so the fixture would pass or ' +
            'fail for the wrong reason.',
        );
      }
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'acbp-stop-port-'));
  mkdirSync(join(root, 'packages', 'core', 'src', 'stops'), { recursive: true });
  mkdirSync(join(root, 'packages', 'core', 'src', 'tools'), { recursive: true });
  mkdirSync(join(root, 'packages', 'database', 'migrations'), { recursive: true });
  writeFileSync(join(root, 'packages', 'core', 'src', 'stops', 'index.ts'), stops);
  writeFileSync(join(root, 'packages', 'core', 'src', 'tools', 'dispatcher.ts'), dispatcher);
  for (const [name, content] of Object.entries(migrations)) writeFileSync(join(root, 'packages', 'database', 'migrations', name), content);
  cpSync(CHECKER, join(root, 'checker.mjs'));
  return root;
}

function run(root, checker = join(root, 'checker.mjs')) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * Exit 1 has to be the CHECKER SPEAKING, not node dying and not the checker disqualifying itself.
 *
 * Measured against two deliberate mutants of the detector: narrowing STOP_FIELD back to `readonly stop?:` and
 * neutering it entirely BOTH surface as exit 2 ("FAILED ITS OWN SELF-TEST"). Asserting that string's absence turns
 * "expected 2 to be 1" into a message that names the cause.
 */
function expectDetectedNotCrashed(r) {
  expect(r.out).not.toContain('ENOENT');
  expect(r.out).not.toContain('node:fs');
  expect(r.out).not.toMatch(/^\s*at .*\(node:/m);
  expect(r.out).not.toContain('FAILED ITS OWN SELF-TEST');
}

// The four evasions the checker's own comment says were MEASURED against the approval port. Each is a fully
// working caller-injectable port; a guard matching only `readonly stop?:` declared all four GONE.
const EVASIONS = [
  ['readonly optional', '  readonly stop?: () => StopAnswer;\n'],
  ['bare optional (no readonly)', '  stop?: () => StopAnswer;\n'],
  ['REQUIRED, not optional', '  readonly stop: () => StopAnswer;\n'],
  ['quoted key', "  readonly 'stop'?: () => StopAnswer;\n"],
];

describe('stop-port check — RED: the real defect', () => {
  test.each(EVASIONS)('FAILS: a stop engine exists and `stop` is back on ToolGates — %s', (_label, line) => {
    const r = run(makeTree({ stops: REAL_MODULE, dispatcher: dispatcherSource({ gates: line }), migrations: KYSELY_MIGRATION }));
    expect(r.code).toBe(1);
    expectDetectedNotCrashed(r);
    expect(r.out).toContain('A STOP ENGINE EXISTS AND THE CALLER-INJECTABLE STOP PORT IS BACK');
    expect(r.out).toContain('declares a `stop` gate on ToolGates');
  });

  test.each(EVASIONS)('FAILS: the same port moved to DispatcherOptions — %s', (_label, line) => {
    const r = run(makeTree({ stops: SCAFFOLD, dispatcher: dispatcherSource({ options: line }), migrations: KYSELY_MIGRATION }));
    expect(r.code).toBe(1);
    expectDetectedNotCrashed(r);
    expect(r.out).toContain('A STOP ENGINE EXISTS AND THE CALLER-INJECTABLE STOP PORT IS BACK');
    expect(r.out).toContain('declares a `stop` gate on DispatcherOptions');
  });

  test('FAILS on the module-shaped store alone: stops/index.ts stops being a scaffold', () => {
    const r = run(makeTree({ stops: REAL_MODULE, dispatcher: dispatcherSource({ gates: EVASIONS[0][1] }) }));
    expect(r.code).toBe(1);
    expectDetectedNotCrashed(r);
    expect(r.out).toContain('packages/core/src/stops/index.ts exports a real module (no longer a scaffold)');
  });

  test('FAILS on the Kysely builder store form', () => {
    const r = run(makeTree({ stops: SCAFFOLD, dispatcher: dispatcherSource({ gates: EVASIONS[0][1] }), migrations: KYSELY_MIGRATION }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('creates the "emergency_stops" table');
  });

  test('FAILS on the raw-SQL store form, and on held_work as well as emergency_stops', () => {
    const r = run(makeTree({ stops: SCAFFOLD, dispatcher: dispatcherSource({ gates: EVASIONS[0][1] }), migrations: RAW_SQL_MIGRATION }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('creates the "held_work" table');
  });

  test('the failure message tells the next reader what to do — a guard that only blocks is a tax', () => {
    const r = run(makeTree({ stops: REAL_MODULE, dispatcher: dispatcherSource({ gates: EVASIONS[0][1] }), migrations: KYSELY_MIGRATION }));
    expect(r.out).toContain('THE FIX IS TO READ THE STORE');
    expect(r.out).toContain('CDR-072');
    expect(r.out).toContain('not to delete this check');
  });
});

describe('stop-port check — CONTROL: a clean tree passes', () => {
  // THE DIFFERENTIAL CONTROL. Byte-for-byte the RED tree with the one `stop` line removed. Without this, a checker
  // that rejected every input would satisfy the RED cases above.
  test('PASSES with the store landed and the port GONE — the closed state P6-007 requires', () => {
    const r = run(makeTree({ stops: REAL_MODULE, dispatcher: dispatcherSource(), migrations: KYSELY_MIGRATION }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('port GONE (closed as P6-007 requires)');
    expect(r.out).toContain('Self-test passed');
    // It passed while SEEING the store, not by seeing nothing.
    expect(r.out).toMatch(/[1-9]\d* store indicator/);
  });

  test('PASSES on a neighbouring field whose name merely contains "stop" — no false positive', () => {
    const r = run(makeTree({ stops: REAL_MODULE, dispatcher: dispatcherSource({ gates: '  readonly stopStore?: StopStore;\n' }), migrations: KYSELY_MIGRATION }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('port GONE');
  });

  test('PASSES with the port present while NO store exists — the state the port was legitimate in', () => {
    const r = run(makeTree({ stops: SCAFFOLD, dispatcher: dispatcherSource({ gates: EVASIONS[0][1] }) }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('port PRESENT (allowed: no stop engine yet)');
    expect(r.out).toContain('0 store indicator');
  });

  test('PASSES on the REAL repository, and for the right reason', () => {
    const r = run(REPO_ROOT, CHECKER);
    expect(r.code).toBe(0);
    expect(r.out).toContain('port GONE (closed as P6-007 requires)');
    // Green because the port is closed WITH an engine present — not because the checker saw no engine.
    expect(r.out).toMatch(/[1-9]\d* store indicator/);
  });
});

describe('stop-port check — exit 2 is blindness, never a pass', () => {
  // THE SURVIVING HOST MUST BE CLEAN. `stopPortDeclaration` returns on the FIRST host that matches, so a `stop`
  // left in a surviving ToolGates short-circuits the blindness branch and the run exits 1 instead of 2. Measured:
  // writing the port into the survivor makes the DispatcherOptions case pass for the wrong reason.
  test.each(PORT_HOSTS)('exits 2, distinctly from a violation, when %s has vanished', (host) => {
    const other = PORT_HOSTS.find((h) => h !== host);
    const src = `export interface ${other} {\n  readonly _never?: never;\n}\n`;
    const r = run(makeTree({ stops: REAL_MODULE, dispatcher: src, allowBlind: true }));
    expect(r.code).toBe(2);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('CANNOT SEE ITS TARGET');
    expect(r.out).toContain(`${host} interface not found`);
    expect(r.out).toContain('Fix this check rather than deleting it');
  });

  // The order matters and is worth pinning: a REAL violation outranks blindness, but only because ToolGates is
  // consulted first. If the port ever moves to DispatcherOptions-only while ToolGates is deleted, this is the
  // branch that decides whether the run reports a bypass or reports that it cannot see.
  test('a violation in ToolGates outranks a vanished DispatcherOptions — exit 1, not 2', () => {
    const src = 'export interface ToolGates {\n  readonly stop?: () => StopAnswer;\n}\n';
    const r = run(makeTree({ stops: REAL_MODULE, dispatcher: src, allowBlind: true }));
    expect(r.code).toBe(1);
    expectDetectedNotCrashed(r);
    expect(r.out).toContain('declares a `stop` gate on ToolGates');
  });
});

describe('stop-port check — the suite cannot go vacuous', () => {
  test('the fixture floor THROWS on a tree with no dispatcher.ts, rather than yielding a fake RED', () => {
    // Measured: that tree exits 1 with an ENOENT stack. Without this floor a RED case could "pass" having
    // detected nothing at all.
    expect(() => makeTree({ stops: REAL_MODULE, dispatcher: '' })).toThrow(/FIXTURE FLOOR/);
  });

  test('the fixture floor THROWS when a port host is missing, which would exit 2 rather than judge the port', () => {
    expect(() => makeTree({ dispatcher: 'export interface ToolGates {\n  readonly _never?: never;\n}\n' })).toThrow(/DispatcherOptions/);
  });

  test('the checker is blind to .sql migrations — this records that the blind spot is currently INERT', () => {
    // `stopTablesCreated()` filters /\.(ts|mts|mjs|js)$/. A .sql migration creating emergency_stops is invisible.
    // The day someone adds one, this goes RED and the checker must be widened rather than the test relaxed.
    const sql = readdirSync(join(REPO_ROOT, 'packages', 'database', 'migrations')).filter((n) => n.endsWith('.sql'));
    expect(sql).toEqual([]);
  });
});

describe('A MISSING DISPATCHER IS BLINDNESS (exit 2), NOT A FINDING (exit 1)', () => {
  // ⚠️ THIS WAS A REAL DEFECT, FOUND WHILE WRITING THIS SUITE AND FIXED IN THE SAME CHANGE.
  //
  // The checker already treated a vanished `ToolGates`/`DispatcherOptions` INTERFACE as exit 2 — "cannot see
  // what it guards". But the `readFileSync` of the dispatcher itself was BARE, so a tree without the file died
  // with a raw Node ENOENT stack and exit 1: the same code as a real violation, carrying none of this checker's
  // diagnosis. Anyone distinguishing "the port is back" from "the file moved" by exit code was told the wrong
  // thing, and the stack trace made it look like the checker had crashed rather than found something.
  test('a tree with a live stop engine but no dispatcher.ts exits 2 and names the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'acbp-stopport-nodispatch-'));
    mkdirSync(join(root, 'packages', 'core', 'src', 'stops'), { recursive: true });
    mkdirSync(join(root, 'packages', 'database', 'migrations'), { recursive: true });
    writeFileSync(join(root, 'packages', 'core', 'src', 'stops', 'index.ts'), REAL_MODULE, 'utf8');
    writeFileSync(
      join(root, 'packages', 'database', 'migrations', '0050_stops.ts'),
      "await db.schema.createTable('emergency_stops').execute();\n",
      'utf8',
    );

    let code = 0;
    let out = '';
    try {
      execFileSync(process.execPath, [CHECKER], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      code = err.status ?? -1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }

    expect(code, 'blindness must not share an exit code with a real violation').toBe(2);
    expect(out).toContain('CANNOT SEE ITS TARGET');
    expect(out).toContain('dispatcher.ts');
    // The bare read produced this. Its absence is the fix.
    expect(out, 'a raw ENOENT stack means the guard is unguarded again').not.toContain('ENOENT');
  });
});