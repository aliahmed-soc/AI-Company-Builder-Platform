#!/usr/bin/env node
/**
 * ACBP-P0-012 — Workspace dependency-boundary checker.
 *
 * Enforces the STRUCTURAL subset of the 10 dependency rules in
 * docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md §"Required dependency rules".
 * See docs/implementation/DEPENDENCY-BOUNDARIES.md for the enforced/deferred split.
 *
 * Why a small custom checker (not dependency-cruiser / eslint-plugin-boundaries):
 * dependency-cruiser's bundled resolver could not resolve workspace modules in this
 * environment (it reported couldNotResolve for even same-directory relative imports),
 * so it could not enforce the rules. This checker does its own deterministic resolution
 * (no reliance on node module resolution), which the ticket explicitly permits.
 *
 * Exit code: 0 = clean, 1 = one or more violations (build failure), 2 = checker error.
 *
 * Scan root: defaults to the repository root. A different root may be supplied as the first
 * CLI argument or via ACBP_BOUNDARY_ROOT — used by the regression suite
 * (tools/tests/check-boundaries.test.mjs) to run against isolated temporary workspaces so
 * no invalid fixture is ever written into the real source tree.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(process.argv[2] ?? process.env.ACBP_BOUNDARY_ROOT ?? REPO_ROOT);
const SCAN_DIRS = ['apps', 'packages'];
const SRC_EXTS = ['.ts', '.tsx', '.mts', '.cts'];

/**
 * Blank out comments so commented-out or documented import-like text is never flagged,
 * while preserving line numbers (block comments -> spaces keeping newlines; whole-line
 * `//` comments -> empty line). Import specifiers never legitimately contain `//`, so this
 * cannot hide a real workspace/relative/@acbp import.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out
    .split('\n')
    .map((ln) => (/^\s*\/\//.test(ln) ? '' : ln))
    .join('\n');
  return out;
}

// ---- Layer model (from REPOSITORY-SCAFFOLD-SPEC.md per-package table) -------------------
// Allowed OUTward workspace destinations per source layer. Anything not listed is forbidden.
const ALLOWED = {
  contracts: [],
  domain: ['contracts'],
  core: ['domain', 'contracts', 'database', 'gateway', 'adapters', 'observability', 'config'],
  database: ['contracts', 'config', 'observability'],
  gateway: ['contracts', 'config', 'observability', 'adapters'],
  adapters: ['contracts', 'config', 'observability'],
  observability: ['contracts', 'config'],
  config: ['contracts'],
  'test-support': ['contracts', 'domain', 'core', 'database', 'gateway', 'adapters', 'observability', 'config'],
  web: ['core', 'contracts', 'config', 'observability'],
  worker: ['core', 'contracts', 'config', 'observability'],
};
const APP_LAYERS = new Set(['web', 'worker']);
const PROVIDER_SDK_RE = /^(@clerk(\/|$)|@infisical(\/|$)|@anthropic-ai(\/|$)|@aws-sdk(\/|$)|@stripe(\/|$)|openai(\/|$)|clerk(\/|$)|infisical(\/|$)|stripe(\/|$)|pg(\/|$)|render(\/|$))/;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|[/\\])__tests__[/\\]/;

const IMPORT_RE = /(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

const violations = [];
const edges = []; // { fromLayer, toLayer } for cycle detection (workspace-internal only)

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'build') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (SRC_EXTS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** Map a repo-relative path to { layer, pkg, isIndex, rel }. */
function classifyPath(relPath) {
  const parts = relPath.split(/[/\\]/);
  if (parts[0] === 'apps' && parts.length >= 2) {
    return { layer: parts[1], pkg: `apps/${parts[1]}`, rel: relPath, isIndex: relPath.replace(/\\/g, '/').endsWith(`apps/${parts[1]}/src/index.ts`) };
  }
  if (parts[0] === 'packages' && parts.length >= 2) {
    const pkg = parts[1];
    return { layer: pkg, pkg: `packages/${pkg}`, rel: relPath, isIndex: relPath.replace(/\\/g, '/').endsWith(`packages/${pkg}/src/index.ts`) };
  }
  return null; // outside apps/packages
}

/** Resolve a relative specifier from an importing file to a repo-relative file path (or null). */
function resolveRelative(fromFileAbs, spec) {
  const base = resolve(dirname(fromFileAbs), spec);
  const candidates = [base, ...SRC_EXTS.map((e) => base + e), ...SRC_EXTS.map((e) => join(base, 'index' + e)), base + '.js', join(base, 'index.js')];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return relative(ROOT, c);
  }
  // Return a best-effort repo-relative path even if the file is missing (for deep-import detection).
  return relative(ROOT, base);
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function addViolation(rule, fromFile, line, spec, detail) {
  violations.push({ rule, file: fromFile, line, spec, detail });
}

for (const d of SCAN_DIRS) {
  const abs = join(ROOT, d);
  if (!existsSync(abs)) continue;
  for (const fileAbs of walk(abs)) {
    const fileRel = relative(ROOT, fileAbs).replace(/\\/g, '/');
    const src = classifyPath(fileRel);
    if (!src) continue;
    const fromLayer = src.layer;
    const fromIsTest = TEST_FILE_RE.test(fileRel);
    const content = stripComments(readFileSync(fileAbs, 'utf8'));
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(content)) !== null) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!spec) continue;
      const line = lineOf(content, m.index);

      // --- Classify the target ---
      let target; // { layer, deep, external, kind } — assigned in every branch below
      if (spec.startsWith('@acbp/')) {
        const rest = spec.slice('@acbp/'.length);
        const pkg = rest.split('/')[0];
        const deep = rest.includes('/'); // @acbp/x/anything => deep import past the public index
        target = { layer: pkg, deep, external: false, kind: 'alias' };
      } else if (spec.startsWith('.')) {
        const targetRel = resolveRelative(fileAbs, spec).replace(/\\/g, '/');
        const tc = classifyPath(targetRel);
        if (!tc) { continue; } // resolves outside apps/packages (e.g., repo root) — ignore here
        const samePkg = tc.pkg === src.pkg;
        const deep = !samePkg && !tc.isIndex; // cross-package relative import not landing on the public index
        target = { layer: tc.layer, deep, external: false, kind: 'relative', samePkg };
      } else {
        target = { layer: null, deep: false, external: true, kind: 'external', spec };
      }

      // --- External-import rules ---
      if (target.external) {
        if (fromLayer === 'domain') {
          addViolation('domain-no-npm', fileRel, line, spec, 'domain is pure: no external/SDK imports (rule 1)');
        } else if (fromLayer === 'core' && PROVIDER_SDK_RE.test(spec)) {
          addViolation('core-no-provider-sdk', fileRel, line, spec, 'core must not import provider SDKs directly (rule 2)');
        }
        continue;
      }

      // --- Intra-package imports are always allowed (module-index discipline within core is a convention) ---
      if (target.kind === 'relative' && target.samePkg) continue;

      // --- Deep cross-package import (rule 10) ---
      if (target.deep) {
        addViolation('no-cross-package-deep-import', fileRel, line, spec, `import ${target.layer} via its public index, not a deep path (rule 10)`);
        // fall through to also check direction below
      }

      // --- Record edge for cycle detection ---
      edges.push({ from: fromLayer, to: target.layer });

      // --- Importing an application entry point is forbidden for everything ---
      if (APP_LAYERS.has(target.layer) && src.pkg.startsWith('packages/')) {
        addViolation('packages-no-import-apps', fileRel, line, spec, 'packages must not import application entry points');
        continue;
      }

      // --- test-support may only be imported by test files (or test-support itself) ---
      if (target.layer === 'test-support') {
        if (fromIsTest || fromLayer === 'test-support') continue; // allowed for tests
        addViolation('no-prod-to-test-support', fileRel, line, spec, 'test-support must not become a production dependency (rule 9)');
        continue;
      }

      // --- Layer-direction allow-list ---
      const allowed = ALLOWED[fromLayer] ?? [];
      if (target.layer !== fromLayer && !allowed.includes(target.layer)) {
        addViolation(`${fromLayer}-no-outward`, fileRel, line, spec, `${fromLayer} may not import ${target.layer} (allowed: ${allowed.join(', ') || 'none'})`);
      }
    }
  }
}

// ---- Package-level circular-dependency detection --------------------------------------
const graph = new Map();
for (const e of edges) {
  if (e.from === e.to) continue;
  if (!graph.has(e.from)) graph.set(e.from, new Set());
  graph.get(e.from).add(e.to);
}
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map();
const cycles = [];
function dfs(node, stack) {
  color.set(node, GRAY);
  stack.push(node);
  for (const nxt of graph.get(node) ?? []) {
    const c = color.get(nxt) ?? WHITE;
    if (c === GRAY) { cycles.push([...stack.slice(stack.indexOf(nxt)), nxt].join(' -> ')); }
    else if (c === WHITE) { dfs(nxt, stack); }
  }
  stack.pop();
  color.set(node, BLACK);
}
for (const n of graph.keys()) { if ((color.get(n) ?? WHITE) === WHITE) dfs(n, []); }
for (const c of [...new Set(cycles)]) {
  violations.push({ rule: 'no-circular', file: '(workspace graph)', line: 0, spec: c, detail: 'circular package dependency' });
}

// ---- Report ---------------------------------------------------------------------------
violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
if (violations.length === 0) {
  console.log(`✔ dependency-boundary check passed (scanned apps/ + packages/; 0 violations).`);
  process.exit(0);
}
console.error(`✖ dependency-boundary check FAILED — ${violations.length} violation(s):\n`);
for (const v of violations) {
  console.error(`  [${v.rule}] ${v.file}:${v.line}  import "${v.spec}"\n      ${v.detail}`);
}
process.exit(1);
