#!/usr/bin/env node
/**
 * ACBP-P1-002 — UTF-8 BOM guard (regression coverage).
 *
 * A UTF-8 byte-order mark (EF BB BF) at the start of a source/JSON file is invisible to Node, tsc, and
 * vitest (they strip it), so typecheck + unit tests pass — but bundlers (Next/Turbopack/webpack) do NOT
 * strip it from `package.json` and reject the file, which broke the live webhook route while every CI
 * gate was green. This check fails the build if any tracked text file begins with a BOM.
 *
 * Exit: 0 = clean, 1 = one or more BOM files (build failure), 2 = checker error.
 */
import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(process.argv[2] ?? process.env.ACBP_ENCODING_ROOT ?? REPO_ROOT);
const SCAN_DIRS = ['apps', 'packages', 'tools', '.github', 'docs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', '.turbo', 'coverage']);
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml']);

function hasBom(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(3);
    const n = readSync(fd, buf, 0, 3, 0);
    return n === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  } finally {
    closeSync(fd);
  }
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(name.slice(name.lastIndexOf('.')))) out.push(p);
  }
}

const files = [];
for (const d of SCAN_DIRS) {
  const abs = join(ROOT, d);
  try {
    if (statSync(abs).isDirectory()) walk(abs, files);
  } catch {
    /* dir absent — skip */
  }
}
// Root-level config files.
for (const name of readdirSync(ROOT)) {
  const p = join(ROOT, name);
  if (statSync(p).isFile() && EXTS.has(name.slice(name.lastIndexOf('.')))) files.push(p);
}

const offenders = files.filter(hasBom).map((f) => relative(ROOT, f).replace(/\\/g, '/'));

// ── POWERSHELL ESCAPE DAMAGE (added ACBP-P6-002, after the THIRD recurrence) ──────────────────────────────────
//
// In a PowerShell DOUBLE-QUOTED string the backtick is the escape character, so text pushed through one comes out
// mutilated in ways nothing else in this repo notices: `t` becomes a raw TAB, `r` a CR, `n` a newline, `a` a BEL.
// The damage lands INSIDE comments and string literals, so typecheck, lint and every test stay green — `tool_calls`
// shipped as `<TAB>ool_calls` in `two-tenant-harness.ts` under a green `check:static`, and a literal `` `n `` merged
// two comment lines into one 228-character run. Found by review, twice; by tooling, never. Now by tooling.
//
// TWO SIGNALS, both measured against this tree before being adopted, both currently zero:
//
//   1. A raw TAB in a source file. `t` eaten by a PowerShell escape leaves one, and this repo has NO legitimate
//      TABs in source (measured: 0 across 584 files), so there is no false-positive shape to tune around.
//   2. A LONE CR — a `\r` NOT part of a `\r\n`. Line-ending style is not the signal: 301 of 584 files are legitimately
//      CRLF in the working tree because git normalises on commit, so flagging CR outright produced 311 false hits.
//      A CR *mid-line* is different: it is `r` eaten out of a word. Adopting this found a FOURTH instance nobody
//      had noticed — `running` had lost its `r` in a JSDoc comment in `credit-service.integration.test.ts`.
//
// DELIBERATELY NOT CHECKED: a literal backtick followed by an escape letter. It reads like the strongest signal and
// is unusable — a template literal beginning with `a `, `t`, `n` or `r` is ordinary code, and the measurement
// returned 10 hits of which 10 were legitimate. A guard that cries wolf gets deleted, so this one only claims what
// it can prove. The residual mitigation for that variant is the editing rule below plus review.
const CODE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const mangled = [];
for (const file of files) {
  if (!CODE_EXTS.has(file.slice(file.lastIndexOf('.')))) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const problems = [];
  text.split(/\r\n|\n/).forEach((line, i) => {
    if (line.includes('\t')) problems.push(`${i + 1}: raw TAB — a PowerShell escape ate a "t"`);
    if (line.includes('\r')) problems.push(`${i + 1}: lone CR mid-line — a PowerShell escape ate an "r"`);
  });
  if (problems.length > 0) mangled.push({ rel, problems });
}

if (offenders.length === 0 && mangled.length === 0) {
  console.log(`✔ encoding check passed (no UTF-8 BOM, raw TAB or lone CR in ${files.length} scanned text files).`);
  process.exit(0);
}
if (offenders.length > 0) {
  console.error(`✖ encoding check FAILED — ${offenders.length} file(s) start with a UTF-8 BOM (strip it):\n`);
  for (const f of offenders) console.error(`  ${f}`);
  console.error(`\nBOMs are invisible to Node/tsc/vitest but break bundler package.json resolution (see ${basename(fileURLToPath(import.meta.url))}).`);
}
if (mangled.length > 0) {
  console.error(`\n✖ encoding check FAILED — ${mangled.length} source file(s) carry PowerShell escape damage:\n`);
  for (const m of mangled) {
    console.error(`  ${m.rel}`);
    for (const p of m.problems.slice(0, 6)) console.error(`    ${p}`);
    if (m.problems.length > 6) console.error(`    …and ${m.problems.length - 6} more`);
  }
  console.error('\nThis damage survives typecheck, lint and tests because it lands inside comments and literals.');
  console.error('NEVER put code containing a backtick through a PowerShell double-quoted string. Edit with a node');
  console.error('script or [System.IO.File]::WriteAllText, and re-read the region afterwards.');
}
process.exit(1);
