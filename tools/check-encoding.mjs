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
//   3. A control character that PowerShell's backtick escapes can PRODUCE and this repo never writes on purpose:
//      BEL (`` `a ``), BACKSPACE (`` `b ``), VERTICAL TAB (`` `v ``), FORM FEED (`` `f ``) and ESC (`` `e ``).
//      Added ACBP-P6-005 after a FIFTH recurrence, which signals 1 and 2 could not see: `` `f `` in
//      `` `findRequestForUpdate` `` ate the "f" and left a form feed, and lint's `no-irregular-whitespace` caught it
//      only because it landed in a `.ts` file — a form feed in a `.md` or `.sql` would have merged silently.
//
//      THE SET IS DEFINED BY THE THREAT, NOT TUNED AGAINST THE TREE. PowerShell's full escape list also produces NUL
//      (`` `0 ``), TAB, CR and LF. TAB and CR are signals 1 and 2; LF is indistinguishable from a real newline; and
//      NUL is DELIBERATELY EXCLUDED because this repo genuinely writes it — `object-key.test.ts` and
//      `untrusted.test.ts` both embed raw NUL as control-character-rejection fixtures, so guarding it would produce
//      two false positives on day one and get the whole checker deleted. Measured across 601 tracked source files:
//      the five guarded characters appear exactly ONCE, and that one was real damage — a BEL in
//      `credit-service.ts` where `` `a `` had eaten the "a" out of `already_reserved`, sitting undetected in a
//      comment explaining a refusal path. Found by this signal, not by review.
//
// DELIBERATELY NOT CHECKED: a literal backtick followed by an escape letter. It reads like the strongest signal and
// is unusable — a template literal beginning with `a `, `t`, `n` or `r` is ordinary code, and the measurement
// returned 10 hits of which 10 were legitimate. A guard that cries wolf gets deleted, so this one only claims what
// it can prove. The residual mitigation for that variant is the editing rule below plus review.
const CODE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
// BEL, BACKSPACE, VERTICAL TAB, FORM FEED, ESC — see signal 3 above. NUL is excluded on purpose (real fixtures use
// it); TAB and CR have their own signals; LF cannot be told from a newline.
// WRITTEN AS `\uXXXX` ESCAPES, NOT LITERALS, AND IT HAS TO BE: this checker scans `tools/`, so spelling its own
// signal literally would make it fail on itself — which is how the literals below were first written, and caught.
const ESCAPE_PRODUCTS = [
  ['\u0007', 'BEL', 'a'],
  ['\u0008', 'BACKSPACE', 'b'],
  ['\u000b', 'VERTICAL TAB', 'v'],
  ['\u000c', 'FORM FEED', 'f'],
  ['\u001b', 'ESC', 'e'],
];
const mangled = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  // Signal 3 applies to EVERY scanned text file: a form feed in a Markdown doc is the same damage as one in a `.ts`,
  // and only the `.ts` case has a linter behind it. Signals 1 and 2 stay code-only, where they were measured.
  const isCode = CODE_EXTS.has(file.slice(file.lastIndexOf('.')));
  const problems = [];
  text.split(/\r\n|\n/).forEach((line, i) => {
    if (isCode && line.includes('\t')) problems.push(`${i + 1}: raw TAB — a PowerShell escape ate a "t"`);
    if (isCode && line.includes('\r')) problems.push(`${i + 1}: lone CR mid-line — a PowerShell escape ate an "r"`);
    for (const [ch, name, letter] of ESCAPE_PRODUCTS) {
      if (line.includes(ch)) problems.push(`${i + 1}: raw ${name} — a PowerShell escape ate ${'aeiou'.includes(letter) ? 'an' : 'a'} "${letter}"`);
    }
  });
  if (problems.length > 0) mangled.push({ rel, problems });
}

if (offenders.length === 0 && mangled.length === 0) {
  console.log(`✔ encoding check passed (no UTF-8 BOM, raw TAB, lone CR or PowerShell escape product in ${files.length} scanned text files).`);
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
