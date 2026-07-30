#!/usr/bin/env node
// ACBP static check — the caller-injectable `approval` gate must be DELETED the moment an approval store exists.
//
// WHY THIS EXISTS. ACBP-P6-002 deleted `ToolGates.policy` for a stated reason: *a gate a caller may omit will
// eventually be omitted, and the omission would be invisible.* The same argument applies verbatim to `approval` —
// a caller can pass `{ gates: { approval: () => ({ kind: 'allow' }) } }` and satisfy an approval that policy
// DEMANDED, with no approval record existing anywhere. That was found by the adversarial review commissioned on
// P6-002's approval loosening, and it was deliberately LEFT OPEN (CDR-067 §2-G10), because with no approval store to
// consult, deleting the port would make every `require_approval` an unconditional deny and leave the
// approve-and-proceed path unexecuted by any test until P6-003/P6-004 — the same unreachable-path shape as the D1
// defect this repository has been bitten by repeatedly.
//
// LEAVING IT OPEN IS ONLY DEFENSIBLE WHILE IT IS UNREACHABLE. The moment an approval store lands, the port stops
// being a seam and becomes a bypass. A note in a CDR is what gets forgotten; this check shows up in a run.
//
// PM RULING 2026-07-30 (not the owner's): keep the port, and make the record load-bearing rather than written down.
// This file IS that ruling's teeth. Closing the port is an ACCEPTANCE CONDITION of ACBP-P6-003, not an optional
// extra — so when P6-003 adds the store and this check fires, the fix is to delete the port, never to delete this.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const APPROVALS_INDEX = join(ROOT, 'packages', 'core', 'src', 'approvals', 'index.ts');
const DISPATCHER = join(ROOT, 'packages', 'core', 'src', 'tools', 'dispatcher.ts');
const MIGRATIONS = join(ROOT, 'packages', 'database', 'migrations');

/** A scaffold exports nothing. `export {}` and comments only — anything else is a real module. */
function moduleIsScaffold(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/export\s*\{\s*\}\s*;?/g, '')
    .trim();
  return code === '';
}

/** Does any migration CREATE an approvals table? Renames and drops do not count as landing a store. */
function approvalTablesCreated() {
  const found = [];
  let files;
  try {
    files = readdirSync(MIGRATIONS).filter((n) => /\.(ts|mts|mjs|js)$/.test(n));
  } catch {
    return found;
  }
  for (const name of files) {
    const full = join(MIGRATIONS, name);
    if (!statSync(full).isFile()) continue;
    const src = readFileSync(full, 'utf8');
    // Kysely builder (`createTable('approvals')`) and raw SQL (`create table approvals`), including `approval_*`.
    for (const m of src.matchAll(/createTable\(\s*['"`](approvals?(?:_[a-z0-9_]+)?)['"`]/g)) found.push({ file: relative(ROOT, full), table: m[1] });
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(approvals?(?:_[a-z0-9_]+)?)\b/gi)) found.push({ file: relative(ROOT, full), table: m[1] });
  }
  return found;
}

/**
 * Does an injectable `approval` port still exist?
 *
 * THE PATTERN IS DELIBERATELY LOOSE, and the reason is measurement rather than taste. The original guard matched
 * only `readonly approval?:` — the single shape the port happened to have — and a review pass probed it against
 * real fixture trees: dropping `readonly`, making the field REQUIRED instead of optional, quoting the key, or
 * moving the port to `DispatcherOptions` each produced a fully functional caller-injectable port that the guard
 * declared GONE. Four ways to reintroduce the exact thing it exists to prevent, all silent.
 *
 * A checker that stops matching becomes a checker that always passes, which is worse than no checker because
 * people trust it. So: `readonly` optional, `?` optional, the key optionally quoted, and BOTH declaration sites
 * scanned. Over-matching here costs a false alarm someone must think about; under-matching costs the guarantee.
 */
const APPROVAL_FIELD = /^\s*(?:readonly\s+)?['"`]?approval['"`]?\s*\??\s*:/m;

/** Both places a gate port could live. Missing either one is an error, not a pass — see the exit-2 branch. */
const PORT_HOSTS = ['ToolGates', 'DispatcherOptions'];

function approvalPortDeclaration(source) {
  for (const host of PORT_HOSTS) {
    const block = source.match(new RegExp(`export\\s+interface\\s+${host}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (block === null) {
      return { error: `${host} interface not found in the dispatcher — this check can no longer see what it guards.` };
    }
    const hit = (block[1] ?? '').match(APPROVAL_FIELD);
    if (hit !== null) {
      return { present: true, host, line: source.slice(0, (block.index ?? 0) + (hit.index ?? 0)).split('\n').length };
    }
  }
  return { present: false };
}

const storeLanded = [];
if (existsSync(APPROVALS_INDEX) && !moduleIsScaffold(readFileSync(APPROVALS_INDEX, 'utf8'))) {
  storeLanded.push({ what: 'packages/core/src/approvals/index.ts exports a real module (no longer a scaffold)' });
}
for (const t of approvalTablesCreated()) {
  storeLanded.push({ what: `${t.file} creates the "${t.table}" table` });
}

const dispatcherSource = readFileSync(DISPATCHER, 'utf8');
const port = approvalPortDeclaration(dispatcherSource);

if (port.error !== undefined) {
  console.error(`\n✖ approval-port check CANNOT SEE ITS TARGET: ${port.error}`);
  console.error('  Fix this check rather than deleting it — it guards an acceptance condition of ACBP-P6-003.\n');
  process.exit(2);
}

if (storeLanded.length > 0 && port.present) {
  console.error('\n✖ AN APPROVAL STORE EXISTS AND THE CALLER-INJECTABLE APPROVAL PORT IS STILL THERE.\n');
  for (const s of storeLanded) console.error(`  store evidence: ${s.what}`);
  console.error(`\n  packages/core/src/tools/dispatcher.ts:${port.line} still declares \`readonly approval?: ...\` on ToolGates.`);
  console.error('\n  While no store existed, this port was a seam and the only way to execute the approve-and-proceed');
  console.error('  path (CDR-067 §2-G10). Now it is a BYPASS: a caller can satisfy an approval that policy DEMANDED');
  console.error('  by passing its own lambda, and no approval record is consulted.');
  console.error('\n  THE FIX IS TO DELETE THE PORT, not to delete this check. Consult the approval store inside');
  console.error('  `dispatchToolCall` — the way the `policy` port was replaced by an internal engine call in');
  console.error('  ACBP-P6-002 — so that neither the answer nor the requirement riding it can be supplied by a');
  console.error('  caller. Closing it is an ACCEPTANCE CONDITION of ACBP-P6-003.\n');
  process.exit(1);
}

// ── NEGATIVE SELF-TEST ────────────────────────────────────────────────────────────────────────────────────────
// A checker that stops matching becomes a checker that always passes, which is the exact "guard written but never
// applied" failure this repo keeps finding. Prove both detectors still fire on synthetic inputs before reporting a
// clean tree — otherwise THIS fails rather than the tree going quietly green.
{
  const scaffoldOk =
    moduleIsScaffold('// comment only\nexport {};\n') === true &&
    moduleIsScaffold('/* block */\nexport {};\n') === true &&
    moduleIsScaffold(`export { createApproval } from './approval-service.js';\n`) === false;
  // BOTH HOSTS APPEAR IN EVERY PROBE, because a missing host is an ERROR (exit 2), not a pass — the probes have to
  // be shaped like the file they stand in for.
  const dispatcherOptions = (extra = '') => `export interface DispatcherOptions {\n  readonly now?: Date;\n${extra}}\n`;
  const toolGates = (extra = '') => `export interface ToolGates {\n${extra}  readonly stop?: () => StopAnswer;\n}\n`;

  // THE FOUR EVASIONS A REVIEW PASS MEASURED against real fixture trees. Each one was a fully functional
  // caller-injectable port that the original `readonly approval?:` pattern declared GONE. They are probes now, so
  // the guard cannot silently lose them again.
  const evasions = [
    '  readonly approval?: () => GateAnswer;\n', // the original shape
    '  approval?: () => GateAnswer;\n', // no `readonly`
    '  readonly approval: () => GateAnswer;\n', // REQUIRED, not optional
    `  readonly 'approval'?: () => GateAnswer;\n`, // quoted key
  ];
  const portOk =
    // Every evasion is caught on ToolGates…
    evasions.every((e) => approvalPortDeclaration(`${toolGates(e)}${dispatcherOptions()}`).present === true) &&
    // …and on DispatcherOptions, which the original pattern never looked at.
    evasions.every((e) => approvalPortDeclaration(`${toolGates()}${dispatcherOptions(e)}`).present === true) &&
    // …while a genuinely closed port still reads as closed, so this is not a detector that fires on everything.
    approvalPortDeclaration(`${toolGates()}${dispatcherOptions()}`).present === false &&
    // …and a NEIGHBOURING field whose name merely contains "approval" is not a false positive.
    approvalPortDeclaration(`${toolGates('  readonly approvalStore?: ApprovalStore;\n')}${dispatcherOptions()}`).present === false &&
    // …and a vanished host is an ERROR rather than a quiet pass.
    approvalPortDeclaration(toolGates()).error !== undefined;
  const tableRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(approvals?(?:_[a-z0-9_]+)?)\b/gi;
  const kyselyRe = /createTable\(\s*['"`](approvals?(?:_[a-z0-9_]+)?)['"`]/g;
  const tableOk =
    [...'create table approvals ('.matchAll(tableRe)][0]?.[1] === 'approvals' && [...`createTable('approval_grants')`.matchAll(kyselyRe)][0]?.[1] === 'approval_grants';
  if (!(scaffoldOk && portOk && tableOk)) {
    console.error('✖ approval-port check FAILED ITS OWN SELF-TEST — a detector no longer recognises a known shape.');
    console.error(`  scaffold=${scaffoldOk} port=${portOk} table=${tableOk}. A clean result would be meaningless.`);
    process.exit(2);
  }
}

const state = port.present ? 'port PRESENT (allowed: no approval store yet)' : 'port GONE (closed as P6-003 requires)';
console.log(`✔ approval-port check: ${state}; ${storeLanded.length} store indicator(s). Self-test passed.`);
