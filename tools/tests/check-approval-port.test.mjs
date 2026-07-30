// ACBP — tests for the approval-port check (CDR-067 §2-G10; PM ruling 2026-07-30).
//
// The check exists BECAUSE a written-down obligation gets forgotten. A silently-broken version of it would be worse
// than none at all: it would report a clean tree forever while the bypass it guards sat open. So these run the REAL
// checker as a subprocess against fixture trees, and assert both directions — that the port is ALLOWED while no
// approval store exists, and that it FAILS, with an actionable message, the moment one does.
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, '..', 'check-approval-port.mjs');

const SCAFFOLD = `// core/approvals — module public index (scaffold). No implementation yet.\nexport {};\n`;
const REAL_MODULE = `export { createApproval } from './approval-service.js';\n`;

const GATES_WITH_PORT = `import type { GateAnswer, StopAnswer } from '@acbp/contracts';
export interface DispatcherOptions {
  readonly now?: Date;
}
export interface ToolGates {
  readonly approval?: () => Promise<GateAnswer> | GateAnswer;
  readonly stop?: () => Promise<StopAnswer> | StopAnswer;
}
export async function dispatchToolCall() {}
`;

const GATES_WITHOUT_PORT = `import type { StopAnswer } from '@acbp/contracts';
export interface DispatcherOptions {
  readonly now?: Date;
}
export interface ToolGates {
  readonly stop?: () => Promise<StopAnswer> | StopAnswer;
}
export async function dispatchToolCall() {}
`;

/** A throwaway repo shaped like the real one: an approvals index, a dispatcher, and zero or more migrations. */
function makeTree({ approvals, dispatcher, migrations = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-approval-port-'));
  mkdirSync(join(root, 'packages', 'core', 'src', 'approvals'), { recursive: true });
  mkdirSync(join(root, 'packages', 'core', 'src', 'tools'), { recursive: true });
  mkdirSync(join(root, 'packages', 'database', 'migrations'), { recursive: true });
  writeFileSync(join(root, 'packages', 'core', 'src', 'approvals', 'index.ts'), approvals);
  writeFileSync(join(root, 'packages', 'core', 'src', 'tools', 'dispatcher.ts'), dispatcher);
  for (const [name, content] of Object.entries(migrations)) writeFileSync(join(root, 'packages', 'database', 'migrations', name), content);
  cpSync(CHECKER, join(root, 'checker.mjs'));
  return root;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(root, 'checker.mjs')], { cwd: root, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('approval-port check', () => {
  test('PASSES while the port exists and no approval store does — that is the state P6-002 deliberately shipped', () => {
    const r = run(makeTree({ approvals: SCAFFOLD, dispatcher: GATES_WITH_PORT }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('port PRESENT');
    expect(r.out).toContain('Self-test passed');
  });

  test('FAILS when the approvals module stops being a scaffold while the port remains', () => {
    const r = run(makeTree({ approvals: REAL_MODULE, dispatcher: GATES_WITH_PORT }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('APPROVAL STORE EXISTS');
    // The message has to tell the next reader what to do, or it just blocks them.
    expect(r.out).toContain('THE FIX IS TO DELETE THE PORT');
    expect(r.out).toContain('ACCEPTANCE CONDITION of ACBP-P6-003');
  });

  test('FAILS when a migration creates an approvals table while the port remains — Kysely builder form', () => {
    const r = run(
      makeTree({
        approvals: SCAFFOLD,
        dispatcher: GATES_WITH_PORT,
        migrations: { '0047_approvals.ts': `await db.schema.createTable('approvals').addColumn('id', 'uuid').execute();\n` },
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('creates the "approvals" table');
  });

  test('FAILS on the raw-SQL form too, and on an approval_* table name', () => {
    const r = run(
      makeTree({
        approvals: SCAFFOLD,
        dispatcher: GATES_WITH_PORT,
        migrations: { '0047_grants.ts': "await sql`create table if not exists public.approval_grants (id uuid)`.execute(db);\n" },
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain('approval_grants');
  });

  test('PASSES once the port is GONE, even with a store present — the closed state', () => {
    const r = run(
      makeTree({
        approvals: REAL_MODULE,
        dispatcher: GATES_WITHOUT_PORT,
        migrations: { '0047_approvals.ts': `await db.schema.createTable('approvals').execute();\n` },
      }),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('port GONE');
  });

  test('exits 2 — distinctly from a violation — when it can no longer SEE its target', () => {
    // Renaming or removing `ToolGates` must not turn this check into a permanent pass. A guard that cannot find what
    // it guards has to say so, and say it differently from "all clear".
    const r = run(makeTree({ approvals: SCAFFOLD, dispatcher: `export interface Gates { readonly approval?: () => unknown }\n` }));
    expect(r.code).toBe(2);
    expect(r.out).toContain('CANNOT SEE ITS TARGET');
    expect(r.out).toContain('Fix this check rather than deleting it');
  });
});
