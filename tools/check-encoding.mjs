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
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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
if (offenders.length === 0) {
  console.log(`✔ encoding check passed (no UTF-8 BOM in ${files.length} scanned text files).`);
  process.exit(0);
}
console.error(`✖ encoding check FAILED — ${offenders.length} file(s) start with a UTF-8 BOM (strip it):\n`);
for (const f of offenders) console.error(`  ${f}`);
console.error(`\nBOMs are invisible to Node/tsc/vitest but break bundler package.json resolution (see ${basename(fileURLToPath(import.meta.url))}).`);
process.exit(1);
