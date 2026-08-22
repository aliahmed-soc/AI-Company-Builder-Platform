#!/usr/bin/env node
// ACBP — schema-reset-list completeness check.
//
// WHY THIS EXISTS. Integration suites drop every table and re-run the migrations to start from a known schema. If a
// newly migrated table is missing from one of those drop lists, it SURVIVES the reset, the next `CREATE TABLE`
// collides, the migration batch aborts, and every suite after it runs against a database with no tables at all. The
// visible failure is then somewhere else entirely — "expected [...] to include 'users'" — which sends you looking in
// the wrong place.
//
// This happened twice on ACBP-P5-003a, by two different routes. The first time the table was simply never added. The
// second time a rebase silently dropped it from all 41 lists, because the incoming versions of those files had gained
// other tables and won every hunk. Neither route produced a conflict, a type error, or a lint warning; both produced
// a red CI run whose message pointed elsewhere.
//
// The guard is deliberately STATIC: no database, no migrations, no network. It runs in `check:static`, so the failure
// arrives in seconds on a laptop instead of minutes into a hosted CI run — and it names the exact files and tables.
//
// SOURCE OF TRUTH is `DatabaseSchema` in packages/database/src/schema.ts: Kysely is generic over that interface, so a
// table the product can query is a table registered there. Parsing migrations instead would mean modelling creates,
// drops and renames across the whole history to know what is live now.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCHEMA_FILE = join(ROOT, 'packages', 'database', 'src', 'schema.ts');

/**
 * Every table registered in `DatabaseSchema` — the set a reset list must be able to drop.
 *
 * Migration bookkeeping (`kysely_migration`, `kysely_migration_lock`, `_acbp_migration_probe`) needs no handling
 * here: it is never registered in `DatabaseSchema`, so it never lands in `required`. Most lists drop it anyway, and
 * they are free to.
 */
function migratedTables() {
  // ⚠️ GUARDED. This read was bare, so a tree without the schema died with a raw Node stack at exit 1 — the
    // SAME code this checker uses for a real finding. Found by `tools/tests/checker-hygiene.test.mjs`, which
    // asks every cwd-rooted checker the same question against an empty tree.
  if (!existsSync(SCHEMA_FILE)) {
    console.error(`\n\u2716 reset-list check CANNOT SEE ITS TARGET: ${relative(ROOT, SCHEMA_FILE)} does not exist.`);
    console.error('  The reset lists are derived from the schema. A missing schema is not agreement.\n');
    process.exit(2);
  }

  const src = readFileSync(SCHEMA_FILE, 'utf8');
  const start = src.indexOf('export interface DatabaseSchema {');
  if (start === -1) throw new Error('check-reset-lists: could not find `export interface DatabaseSchema` in schema.ts');
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error('check-reset-lists: DatabaseSchema interface is unterminated');
  const body = src.slice(start, end);
  const names = [];
  // `  table_name: SomeTable;` — comments and blank lines are skipped by the shape of the pattern.
  for (const line of body.split('\n')) {
    const m = /^\s{2}([a-z_][a-z0-9_]*)\s*:\s*[A-Za-z]/.exec(line);
    if (m) names.push(m[1]);
  }
  if (names.length === 0) throw new Error('check-reset-lists: parsed zero tables from DatabaseSchema — the parser is broken, not the lists');
  return names;
}

/** Walk for .ts files, skipping build output and dependencies. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next' || entry === '.git' || entry === 'coverage') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * A file participates if it names the migration lock table inside a quoted string — the marker every drop list
 * carries. `migrator.ts` mentions it only in prose, which is why the check requires the QUOTED form.
 */
function isResetListFile(src) {
  return /'kysely_migration_lock'|"kysely_migration_lock"/.test(src);
}

/**
 * The candidate table lists in a file: array literals made of quoted strings.
 *
 * SCOPING THE CHECK TO THE LISTS IS THE WHOLE POINT, and the first version of this guard got it wrong — it asked
 * whether the table name appeared ANYWHERE in the file. A file that drops nothing but merely asserts
 * `expect(names).toContain('task_runs')` satisfied that, which is exactly backwards: the assertion proves the table
 * exists, and the guard concluded the file could remove it. `database.integration.test.ts` was live in that state.
 *
 * The bracket pattern deliberately refuses to match across a nested `[`, so a list is a flat one — which every drop
 * list is. Spread forms like `[...ALL_TABLES, 'kysely_migration_lock']` are not candidates and do not need to be:
 * the array they spread is itself a candidate in the same file.
 */
/**
 * Is this candidate list actually used to DROP tables?
 *
 * WHY THIS QUESTION IS THE RIGHT ONE (added ACBP-P6-003b, closing a hole this guard shipped with). The rule used to be
 * *"a file passes if ANY ONE of its lists can drop everything"*, and the comment justifying it was correct as far as
 * it went: files legitimately hold PARTIAL lists — `provisioning.integration.test.ts` has a 41-of-51 list that keeps
 * the seeded account and company on purpose, and `company.integration.test.ts` has a 50-of-51 one that deliberately
 * leaves `identity_webhook_receipts` alone. Demanding completeness of every list would fail both.
 *
 * But "any one list" means a file with THREE drop lists passes on the strength of one. That is exactly what happened:
 * `activity.integration.test.ts` has three, adding a table to one satisfied this check, and the suite then died with
 * `42P07 relation "approval_requests" already exists` — the very failure the header describes. 29 lists across 28
 * files were short in that state, and one file was never flagged at all.
 *
 * A COVERAGE THRESHOLD WAS THE OBVIOUS FIX AND IS WRONG. Measured against this tree, the candidates fall into 0–18%
 * and 80–100% with nothing between, which looks like a clean cut — until you notice the 80% and 98% lists are the two
 * legitimate partial ones above. The threshold would flag precisely the lists that are meant to be short.
 *
 * So the discriminator is USE, not size, and the header already says which use matters: the damage is a table that
 * *"SURVIVES the reset, so the next CREATE TABLE collides"*. Only `dropTable` can cause that. A short TRUNCATE list
 * leaks rows between tests — a real problem, but a different one, and not this guard's.
 */
function isDropList(code, listStart, listEnd, dropConstNames, dropCallPattern) {
  // Inline form: `for (const t of ['a', 'b']) … dropTable(t)`. The window is generous because the loop body may sit on
  // the next line, and narrow enough that an unrelated later drop cannot be mistaken for this list's use.
  const window = code.slice(listEnd, listEnd + 400);
  const hit = dropCallPattern.exec(window);
  // A DROP INSIDE AN ASSERTION IS NOT A DROP. `company.integration.test.ts` has a negative test — *"the restricted
  // role cannot tamper with company RLS … or drop policies"* — that loops over three tables asserting
  // `expect(…drop table…).rejects.toThrow()`. Proximity alone read that as a drop list and demanded it hold all 51
  // tables. That is the same inversion this file's header already records for the first version of the guard: an
  // assertion that something CANNOT happen was taken as evidence that it does. A real reset drops unconditionally.
  if (hit !== null && !/\bexpect\s*\(/.test(window.slice(0, hit.index))) return true;
  // Named form: `const ALL = [ … ]` used by `for (const t of ALL) … dropTable(t)`, or by `for (const t of [...ALL, …])`.
  //
  // THE SLICE ENDS AT THE OPENING BRACKET, not the closing one. Slicing to `listEnd` put a `]` in the tail, and the
  // backwards pattern requires no bracket between the `=` and the end of the slice — so every multi-line list read as
  // "not a drop list" and 23 files reported `<no dropTable list found>`. The check failed LOUDLY rather than passing,
  // which is the behaviour the no-readable-list branch was written for.
  const before = code.slice(Math.max(0, listStart - 4000), listStart);
  const assign = [...before.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/g)].pop();
  return assign !== undefined && dropConstNames.has(assign[1]);
}

/**
 * A pattern matching "this code drops a table" — `dropTable` itself, plus any LOCAL HELPER that wraps it.
 *
 * Four suites call `await drop(client, t)` instead of `dropTable` inline, so a literal search for `dropTable` read
 * them as not dropping and the check reported `<no dropTable list found>` for all four. Resolving exactly ONE hop is
 * enough for every shape in this repo and keeps the guard readable; a second hop would be a call graph, and a guard
 * nobody can follow is a guard nobody maintains.
 */
function dropCallPattern(code) {
  // WHAT COUNTS AS DROPPING is the EFFECT, not one API. Kysely's `dropTable` and a raw `drop table if exists …` do the
  // same thing to the schema, and `accounts.integration.test.ts` uses the raw form inside its helper — so a detector
  // that knew only `dropTable` reported four files as dropping nothing.
  const DROPS = /dropTable|drop\s+table/i;
  const helpers = new Set();
  // `const drop = async (…) => { … }` and `function drop(…) { … }`, when the body drops.
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\(/g)) {
    if (DROPS.test(code.slice(m.index, m.index + 300))) helpers.add(m[1]);
  }
  for (const m of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (DROPS.test(code.slice(m.index, m.index + 300))) helpers.add(m[1]);
  }
  const alternatives = ['dropTable', 'drop\\s+table', ...[...helpers].map((h) => `${h}\\s*\\(`)];
  return new RegExp(alternatives.join('|'), 'i');
}

/** Const names that reach a drop call, whether iterated directly or spread into another array first. */
function dropListConstNames(code, dropCalls) {
  const names = new Set();
  // `for (const t of NAME)` / `for (const t of [...NAME, …])` whose body drops.
  for (const m of code.matchAll(/for\s*\([^)]*\bof\s*(?:\[\s*\.\.\.\s*)?([A-Za-z_$][\w$]*)/g)) {
    if (dropCalls.test(code.slice(m.index, m.index + 400))) names.add(m[1]);
  }
  return names;
}

function tableLists(src, required) {
  const lists = [];
  // Comments are stripped first: the real lists are written one table per line WITH explanatory comments between
  // them, so a "quoted strings and commas only" test fails on every one of them otherwise. Stripping can at worst
  // eat a closing bracket and make a list unreadable — which this check reports loudly rather than passing.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
  const dropCalls = dropCallPattern(code);
  const dropConstNames = dropListConstNames(code, dropCalls);
  for (const match of code.matchAll(/\[([^[\]]*)\]/g)) {
    const body = match[1];
    // Only quoted strings, commas and whitespace — anything else (an identifier, a call, a spread) means it is not a
    // plain list. A candidate must also name at least one real table, which is what separates a drop list from an
    // array of statuses or column names. No size threshold: "best candidate wins" makes one unnecessary.
    if (!/^[\s,]*(?:(?:'[^']*'|"[^"]*")[\s,]*)+$/.test(body)) continue;
    const members = [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
    if (!members.some((t) => required.includes(t))) continue;
    const start = match.index ?? 0;
    lists.push({ members, drops: isDropList(code, start, start + match[0].length, dropConstNames, dropCalls) });
  }
  return lists;
}

function main() {
  const required = migratedTables();
  const files = [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'tools')]
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((d) => walk(d));

  const problems = [];
  let checked = 0;
  let dropListsChecked = 0;
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (!isResetListFile(src)) continue;
    checked += 1;
    const lists = tableLists(src, required);
    if (lists.length === 0) {
      // Participates but has no readable list. Fail loudly: a list assembled some other way is a list this check
      // cannot vouch for, and silently passing it would be the same false negative in a new shape.
      problems.push({ file: relative(ROOT, file).replace(/\\/g, '/'), missing: ['<no readable table list found>'] });
      continue;
    }
    // EVERY DROP LIST must be complete — not merely the best one in the file. Lists that are not used to drop are
    // left alone, because a short TRUNCATE list is a different bug (see `isDropList`).
    const dropLists = lists.filter((l) => l.drops);
    if (dropLists.length === 0) {
      // Participates in the marker but nothing here drops. Fail loudly for the same reason the no-readable-list case
      // does: a reset assembled some other way is one this check cannot vouch for.
      problems.push({ file: relative(ROOT, file).replace(/\\/g, '/'), missing: ['<no dropTable list found>'] });
      continue;
    }
    dropListsChecked += dropLists.length;
    for (const [index, list] of dropLists.entries()) {
      const missing = required.filter((t) => !list.members.includes(t));
      if (missing.length > 0) {
        problems.push({ file: `${relative(ROOT, file).replace(/\\/g, '/')} (drop list ${index + 1} of ${dropLists.length})`, missing });
      }
    }
  }

  if (checked === 0) {
    console.error('✖ reset-list check FAILED — found no reset lists at all. The marker changed; fix this check, do not delete it.');
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(`✖ reset-list check FAILED — ${problems.length} list(s) do not drop every migrated table.`);
    console.error('  A table missing here SURVIVES the reset, so the next CREATE TABLE collides and the whole');
    console.error('  migration batch aborts — every later suite then runs against an empty database.');
    for (const p of problems) console.error(`  ${p.file}\n    missing: ${p.missing.join(', ')}`);
    process.exit(1);
  }
  // The count is of LISTS, not files, and saying so is the point: the old message said "42 reset lists" when it had
  // in fact checked one list per file and ignored the rest.
  console.log(`✔ reset-list check passed (${dropListsChecked} drop list(s) across ${checked} file(s), each dropping all ${required.length} migrated tables).`);
}

main();
