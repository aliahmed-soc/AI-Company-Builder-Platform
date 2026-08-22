#!/usr/bin/env node
// ACBP — a loop that reverses migrations must be able to reverse ALL of them.
//
// WHY THIS EXISTS, and it is a recurrence rather than a hypothetical. Two integration tests drain the migration
// stack by calling `migrateDown` in a loop. `migrateDown` reverses exactly ONE migration, so the loop's iteration
// cap is silently coupled to the number of migration files — a number that grows on tickets that have nothing to
// do with either test.
//
// It has now failed twice, both times on an unrelated ticket:
//   * ACBP-P6-009's migration 0051 broke `database.integration.test.ts`'s "migrations reverse fully" (cap 50).
//   * ACBP-P6-011's migration 0052 broke `user-mapping.integration.test.ts`'s down/re-apply test (cap 50) — the
//     second copy, which the first fix did not sweep for.
//
// Both presented as an arithmetic assertion failure in a file the author had never opened, on a PR about
// something else. That is the expensive part: the diagnosis costs a full CI cycle and reads like a real defect in
// the ticket under review. This makes the coupling fail fast and name itself.
//
// DELIBERATELY STATIC: no database, no migrations run. It counts migration files and reads the test sources.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'packages', 'database', 'migrations');
const SEARCH_ROOTS = [join(ROOT, 'packages'), join(ROOT, 'tests')];
const CALL = 'migrateDown';

/**
 * Blank out comments and string/template contents, preserving length and newlines so offsets and line numbers
 * still line up with the original source.
 *
 * Needed because the surrounding PROSE names `migrateDown` and quotes iteration caps — this checker's own header
 * does both — and a detector that reads its own warning as a finding is worse than no detector.
 */
export function blankNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += i < n ? '  ' : '';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += ' ';
      i += 1;
      while (i < n) {
        if (src[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (src[i] === c) {
          out += ' ';
          i += 1;
          break;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function matchDelimiter(src, start, open, close) {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/**
 * Every `for` loop whose BODY calls `migrateDown`, with the numeric upper bound from its header.
 *
 * `bound` is null when the loop has no numeric literal cap (`for (;;)`, or a named constant) — those are not
 * coupled to the migration count and are left alone. A loop whose body cannot be delimited is SKIPPED rather than
 * reported: this check should fail the build on a definite finding, never on a parse it could not complete.
 */
export function drainLoops(source) {
  const code = blankNonCode(source);
  const found = [];
  const re = /\bfor\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const parenAt = m.index + m[0].length - 1;
    const headerEnd = matchDelimiter(code, parenAt, '(', ')');
    if (headerEnd < 0) continue;
    let i = headerEnd + 1;
    while (i < code.length && /\s/.test(code[i])) i += 1;
    if (code[i] !== '{') continue;
    const bodyEnd = matchDelimiter(code, i, '{', '}');
    if (bodyEnd < 0) continue;
    const body = code.slice(i, bodyEnd);
    if (!body.includes(CALL)) continue;
    const bound = /<=?\s*(\d+)/.exec(code.slice(parenAt + 1, headerEnd));
    found.push({ line: lineOf(code, m.index), bound: bound ? Number(bound[1]) : null });
  }
  return found;
}

/** The decision, split out so the self-test can drive it without touching the filesystem. */
export function verdict(loops, migrationCount) {
  if (loops.length === 0) {
    return { ok: false, reason: `no \`${CALL}\` loop found anywhere — this check can no longer see what it guards` };
  }
  // STRICTLY GREATER THAN, not >=. Draining a stack of N takes N reversals plus one more call that returns
  // nothing, and a loop that also re-checks a condition first needs the headroom. An exactly-N cap is the
  // off-by-one this whole class is made of.
  const short = loops.filter((l) => l.bound !== null && l.bound <= migrationCount);
  return short.length === 0 ? { ok: true } : { ok: false, short };
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) yield p;
  }
}

function selfTest() {
  const loop = (cap) => `for (let i = 0; i < ${cap}; i++) {\n  const d = await ${CALL}(client);\n}`;
  const cases = [
    ['a cap below the migration count FAILS', verdict(drainLoops(loop(50)), 52).ok === false],
    ['a generous cap passes', verdict(drainLoops(loop(1000)), 52).ok === true],
    ['a cap exactly equal to the count FAILS (off-by-one)', verdict(drainLoops(loop(52)), 52).ok === false],
    ['an unbounded loop passes', verdict(drainLoops(`for (;;) {\n  await ${CALL}(client);\n}`), 52).ok === true],
    ['a compound header still yields its cap', drainLoops(`for (let i = 0; i < 50 && (await n()) > 0; i++) {\n  await ${CALL}(c);\n}`)[0]?.bound === 50],
    ['a loop without the call is ignored', drainLoops('for (let d = 0; d < 8; d++) {\n  cursor = cursor.next;\n}').length === 0],
    ['a commented-out call is not a drain loop', drainLoops(`for (let i = 0; i < 50; i++) {\n  // await ${CALL}(client);\n}`).length === 0],
    ['the call named inside a string is not a drain loop', drainLoops(`for (let i = 0; i < 50; i++) {\n  log('${CALL} is slow');\n}`).length === 0],
    ['seeing nothing at all FAILS', verdict([], 52).ok === false],
    ['blanking preserves line numbers', blankNonCode('// a\n// b\nfor').split('\n').length === 3],
  ];
  const failed = cases.filter(([, pass]) => !pass).map(([name]) => name);
  if (failed.length > 0) {
    console.error(`✖ migration-drain-loop SELF-TEST FAILED: ${failed.join('; ')}`);
    // EXIT 2, not 1. "This check cannot be trusted" is a different fact from "a loop is too short to reverse
    // every migration", and the five sibling checkers all say so with 2. This one said 1.
    console.error('  A clean result would be meaningless. Fix the detectors before trusting a pass.');
    process.exit(2);
  }
}

function main() {
  selfTest();
  // ⚠️ GUARDED. This read was bare, so a tree without the migrations directory died with a raw Node readdir
  // stack at exit 1 — the SAME code as "a drain loop is too short to reverse them all". Blindness must not
  // share an exit code with a finding, least of all on a check whose entire subject is that count.
  if (!existsSync(MIGRATIONS)) {
    console.error(`\n\u2716 migration-drain-loop check CANNOT SEE ITS TARGET: ${relative(ROOT, MIGRATIONS)} does not exist.`);
    console.error('  The migration count is what every loop bound is measured against. A missing directory is');
    console.error('  not agreement — if the migrations moved, move this check with them.\n');
    process.exit(2);
  }

  const migrationCount = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.ts$/.test(f)).length;

  const loops = [];
  for (const root of SEARCH_ROOTS) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(CALL)) continue;
      for (const l of drainLoops(source)) loops.push({ ...l, file: file.slice(ROOT.length + 1).replace(/\\/g, '/') });
    }
  }

  const result = verdict(loops, migrationCount);
  if (!result.ok) {
    if (result.reason) {
      console.error(`✖ migration-drain-loop check FAILED — ${result.reason}.`);
      console.error('  Do not delete this check: restore its ability to find the loop instead.');
      process.exit(1);
    }
    console.error(`✖ migration-drain-loop check FAILED — ${result.short.length} loop(s) cannot reverse all ${migrationCount} migrations:`);
    for (const l of result.short) console.error(`    ${l.file}:${l.line} — iteration cap ${l.bound}, migrations ${migrationCount}`);
    console.error(`  \`${CALL}\` reverses ONE migration per call, so a cap at or below the migration count stops`);
    console.error('  part-way and the test fails on whichever unrelated ticket happened to add the migration.');
    console.error('  Raise the cap well clear of the count (1000 is the convention here) and assert WHY the loop');
    console.error('  ended, so "ran out of iterations" is distinguishable from "finished".');
    process.exit(1);
  }
  console.log(`✔ migration-drain-loop check passed (${loops.length} loop(s), ${migrationCount} migrations). Self-test passed.`);
}

main();
