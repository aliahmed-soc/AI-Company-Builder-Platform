#!/usr/bin/env node
// ACBP static check — the caller-injectable `stop` gate must stay DELETED now that a stop engine exists.
//
// WHY THIS EXISTS. The `stop` port outlived `policy` (ACBP-P6-002) and `approval` (ACBP-P6-003c) for one stated
// reason, written in the dispatcher itself: the engine did not exist, so *"with no stop mechanism in existence, no
// stop CAN be in force"* made its `clear` default simply TRUE. Migration 0050 and the P6-007 controller ended that
// sentence. With a real engine behind it, a caller passing `stop: () => ({ kind: 'clear' })` walks straight through
// a live emergency stop — on the one control whose entire purpose is to be un-bypassable, and whose failure mode
// (CDR-072 §0) is an operator who believes the platform is halted when it is not.
//
// A NOTE IN A CDR IS WHAT GETS FORGOTTEN; this check shows up in a run. If it fires, the fix is to consult the stop
// store inside `dispatchToolCall`, never to delete this file.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const STOPS_INDEX = join(ROOT, 'packages', 'core', 'src', 'stops', 'index.ts');
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

/** Does any migration CREATE a stop table? Renames and drops do not count as landing a store. */
function stopTablesCreated() {
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
    for (const m of src.matchAll(/createTable\(\s*['"`]((?:emergency_stops?|held_work)(?:_[a-z0-9_]+)?)['"`]/g)) found.push({ file: relative(ROOT, full), table: m[1] });
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?((?:emergency_stops?|held_work)(?:_[a-z0-9_]+)?)\b/gi)) found.push({ file: relative(ROOT, full), table: m[1] });
  }
  return found;
}

/**
 * Does an injectable `stop` port still exist?
 *
 * THE PATTERN IS DELIBERATELY LOOSE, for the reason `check-approval-port.mjs` records from measurement: a guard
 * matching only `readonly stop?:` declared four fully functional re-introductions GONE — dropping `readonly`,
 * making the field REQUIRED, quoting the key, or moving the port to `DispatcherOptions`. A checker that stops
 * matching becomes a checker that always passes, which is worse than none because people trust it.
 */
const STOP_FIELD = /^\s*(?:readonly\s+)?['"`]?stop['"`]?\s*\??\s*:/m;

/** Both places a gate port could live. Missing either one is an error, not a pass — see the exit-2 branch. */
const PORT_HOSTS = ['ToolGates', 'DispatcherOptions'];

function stopPortDeclaration(source) {
  for (const host of PORT_HOSTS) {
    const block = source.match(new RegExp(`export\\s+interface\\s+${host}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (block === null) {
      return { error: `${host} interface not found in the dispatcher — this check can no longer see what it guards.` };
    }
    const hit = (block[1] ?? '').match(STOP_FIELD);
    if (hit !== null) {
      return { present: true, host, line: source.slice(0, (block.index ?? 0) + (hit.index ?? 0)).split('\n').length };
    }
  }
  return { present: false };
}

const storeLanded = [];
if (existsSync(STOPS_INDEX) && !moduleIsScaffold(readFileSync(STOPS_INDEX, 'utf8'))) {
  storeLanded.push({ what: 'packages/core/src/stops/index.ts exports a real module (no longer a scaffold)' });
}
for (const t of stopTablesCreated()) {
  storeLanded.push({ what: `${t.file} creates the "${t.table}" table` });
}

const dispatcherSource = readFileSync(DISPATCHER, 'utf8');
const port = stopPortDeclaration(dispatcherSource);

if (port.error !== undefined) {
  console.error(`\n✖ stop-port check CANNOT SEE ITS TARGET: ${port.error}`);
  console.error('  Fix this check rather than deleting it — it guards an acceptance condition of ACBP-P6-007.\n');
  process.exit(2);
}

if (storeLanded.length > 0 && port.present) {
  console.error('\n✖ A STOP ENGINE EXISTS AND THE CALLER-INJECTABLE STOP PORT IS BACK.\n');
  for (const s of storeLanded) console.error(`  store evidence: ${s.what}`);
  console.error(`\n  packages/core/src/tools/dispatcher.ts:${port.line} declares a \`stop\` gate on ${port.host}.`);
  console.error('\n  While no engine existed, this port was TRUE by construction: no stop could be in force, so the');
  console.error('  `clear` default was simply correct. It is now a BYPASS — a caller supplies its own answer and');
  console.error('  walks through a live emergency stop, with no stop record consulted.');
  console.error('\n  CDR-072 §0: a stop that silently fails to halt is worse than no stop, because the operator');
  console.error('  believes it worked and stops watching. THE FIX IS TO READ THE STORE inside `dispatchToolCall`,');
  console.error('  the way `policy` and `approval` already are — not to delete this check.\n');
  process.exit(1);
}

// ── NEGATIVE SELF-TEST ────────────────────────────────────────────────────────────────────────────────────────
// A checker that stops matching becomes a checker that always passes. Prove both detectors still fire on synthetic
// inputs before reporting a clean tree — otherwise THIS fails rather than the tree going quietly green.
{
  const scaffoldOk =
    moduleIsScaffold('// comment only\nexport {};\n') === true &&
    moduleIsScaffold('/* block */\nexport {};\n') === true &&
    moduleIsScaffold(`export { activateStop } from './stop-service.js';\n`) === false;

  // BOTH HOSTS APPEAR IN EVERY PROBE, because a missing host is an ERROR (exit 2), not a pass.
  const dispatcherOptions = (extra = '') => `export interface DispatcherOptions {\n  readonly now?: Date;\n${extra}}\n`;
  const toolGates = (extra = '') => `export interface ToolGates {\n${extra}  readonly _never?: never;\n}\n`;

  // The same four evasions measured for the approval port. Each is a working caller-injectable port.
  const evasions = [
    '  readonly stop?: () => StopAnswer;\n',
    '  stop?: () => StopAnswer;\n',
    '  readonly stop: () => StopAnswer;\n',
    `  readonly 'stop'?: () => StopAnswer;\n`,
  ];
  const portOk =
    evasions.every((e) => stopPortDeclaration(`${toolGates(e)}${dispatcherOptions()}`).present === true) &&
    evasions.every((e) => stopPortDeclaration(`${toolGates()}${dispatcherOptions(e)}`).present === true) &&
    // A genuinely closed port still reads as closed — this is not a detector that fires on everything.
    stopPortDeclaration(`${toolGates()}${dispatcherOptions()}`).present === false &&
    // A NEIGHBOURING field whose name merely contains "stop" is not a false positive.
    stopPortDeclaration(`${toolGates('  readonly stopStore?: StopStore;\n')}${dispatcherOptions()}`).present === false &&
    // A vanished host is an ERROR rather than a quiet pass.
    stopPortDeclaration(toolGates()).error !== undefined;

  const tableRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?((?:emergency_stops?|held_work)(?:_[a-z0-9_]+)?)\b/gi;
  const kyselyRe = /createTable\(\s*['"`]((?:emergency_stops?|held_work)(?:_[a-z0-9_]+)?)['"`]/g;
  const tableOk =
    [...'create table emergency_stops ('.matchAll(tableRe)][0]?.[1] === 'emergency_stops' && [...`createTable('held_work')`.matchAll(kyselyRe)][0]?.[1] === 'held_work';

  if (!(scaffoldOk && portOk && tableOk)) {
    console.error('✖ stop-port check FAILED ITS OWN SELF-TEST — a detector no longer recognises a known shape.');
    console.error(`  scaffold=${scaffoldOk} port=${portOk} table=${tableOk}. A clean result would be meaningless.`);
    process.exit(2);
  }
}

const state = port.present ? 'port PRESENT (allowed: no stop engine yet)' : 'port GONE (closed as P6-007 requires)';
console.log(`✔ stop-port check: ${state}; ${storeLanded.length} store indicator(s). Self-test passed.`);
