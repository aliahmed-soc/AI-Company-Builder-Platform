#!/usr/bin/env node
// ACBP static check — every tracked CSV must parse to a rectangle (ACBP-P7-007; CDR-080 §6).
//
// WHY THIS EXISTS. Twice now a hand-edited cell has silently shifted a row's columns, and both times the file
// still looked fine in a diff:
//
//   • ACBP-P6-011's backlog row landed one column LEFT of where it belonged.
//   • ACBP-P7-007 wrote `Partially covered - boundary only, no quarantine (MVP)` UNQUOTED into the
//     `Coverage status` column of BOTH traceability matrices. A real parser then read
//     `Partially covered - boundary only` as the coverage, ` no quarantine (MVP)` as the `Gap or question`, and
//     pushed the entire explanatory note into a phantom twelfth column that no header names.
//
// That second one is the sharper lesson: a traceability matrix is the artefact a reader consults to ask "is this
// requirement covered?", so a shifted row does not merely look untidy — it ANSWERS THAT QUESTION WRONG, and it
// answers it wrong in the exact file this repository treats as canon. Neither instance was caught by review;
// both were caught by parsing.
//
// The rule is deliberately narrow: every data row must have exactly as many fields as the header. It says
// nothing about what the values mean. Shape is the part a machine can own.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

/** RFC 4180-shaped parse: quoted fields may contain commas, newlines and doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** @returns {{row: number, id: string, got: number}[]} */
export function malformedRows(text) {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0] === ''));
  if (rows.length === 0) return [];
  const width = rows[0].length;
  const bad = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].length !== width) bad.push({ row: i + 1, id: rows[i][0] ?? '', got: rows[i].length, want: width });
  }
  return bad;
}

function trackedCsvFiles() {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '*.csv'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// Only run the check when invoked as a script. Without this guard, the regression suite's `import` of
// `malformedRows` executes the whole scan and calls `process.exit`, killing the test runner before a single case
// runs — which is exactly what it did the first time.
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!invokedDirectly) {
  // Exported helpers only; nothing else happens on import.
} else {
  main();
}

function main() {
const problems = [];
const files = trackedCsvFiles();

if (files === null) {
  // A check that cannot see its target must say so rather than pass — the rule check-approval-port and
  // check-stop-port already follow in this repository.
  console.error('✖ csv-shape check CANNOT SEE ITS TARGET: `git ls-files` failed, so no CSV was examined.');
  process.exit(2);
}

for (const rel of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue; // listed but absent from the working tree (e.g. a deletion staged elsewhere)
  }
  for (const bad of malformedRows(text)) {
    problems.push(
      `${rel}:${bad.row} — row "${bad.id}" has ${bad.got} fields, header has ${bad.want}. ` +
        'A value containing a comma must be quoted; otherwise every column after it shifts and the row answers the wrong question.',
    );
  }
}

// ── NEGATIVE SELF-TEST ───────────────────────────────────────────────────────────────────────────────────────
// A shape checker that stops detecting shifts is worse than none, because a clean run then reads as verified.
{
  const shifted = 'a,b,c\n1,2,3\n4,oops, five,6\n';
  const wellFormed = 'a,b,c\n1,2,3\n4,"oops, five",6\n';
  const multiline = 'a,b\n1,"two\nlines"\n';
  const ok =
    malformedRows(shifted).length === 1 &&
    malformedRows(shifted)[0].got === 4 &&
    malformedRows(wellFormed).length === 0 &&
    malformedRows(multiline).length === 0;
  if (!ok) {
    console.error('✖ csv-shape check FAILED ITS OWN SELF-TEST — the parser no longer distinguishes a shifted row.');
    console.error('  A clean result from this tool would be meaningless. Fix the parser before trusting a pass.');
    process.exit(2);
  }
}

if (problems.length > 0) {
  console.error('\n✖ csv-shape check: malformed row(s) — the columns have shifted:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} problem(s). See CDR-080 §6.\n`);
  process.exit(1);
}

console.log(
  `✔ csv-shape check passed (${files.length} tracked CSV file(s); every data row matches its header width). Parser self-test passed.`,
);
}
