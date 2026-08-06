#!/usr/bin/env node
// ACBP-P7-013 — HTTP rate-limit coverage check (CDR-081 §2; NFR-010).
//
// WHY THIS EXISTS. CDR-008 §8 ruled a per-session request ceiling on 2026-07-18 and nothing implemented it for
// nineteen days, because nothing failed while it was missing. The same silence protects the NEXT route added
// without it: a handler that skips the limiter behaves perfectly in every test, in review, and in production
// right up to the moment somebody points a script at it.
//
// This repository has found that class of gap repeatedly and always the same way — ACBP-P7-002's company pause
// was "a label, not a control" with FIVE artefacts describing a gate no production path read, and ACBP-P6-010
// shipped a spend ceiling no caller passes. The countermeasure that has actually worked here is a STATIC guard
// in `check:static`: `check-stop-port.mjs`, `check-approval-port.mjs`, `check-reset-lists.mjs`,
// `check-migration-drain-loops.mjs`. This is that guard for the rate limit.
//
// ── WHAT IT CHECKS, AND WHY IT WALKS RATHER THAN GREPS ────────────────────────────────────────────────────────
//
// Every Next.js route handler that exports an HTTP method must REACH `verified-identity.ts`, which is where the
// per-session ceiling is consumed (CDR-081 §3.3). Reachability is computed by following the route's imports
// through `apps/web/src/server`, transitively.
//
// A name match would be the wrong test twice over: a route importing `companies-request` proves nothing if that
// module later stops resolving an identity, and a route reaching the limiter through a new intermediate module
// would be failed for using a name this file had not been told about. The walk asks the question that matters —
// *does this handler end up at the enforcement point* — instead of a proxy for it.
//
// No database, no network, no build: it runs in seconds on a laptop, which is the point.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const APP_DIR = join(ROOT, 'apps', 'web', 'src', 'app');
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');
/** The module that consumes the per-session bucket. Reaching it is what "rate limited" means here. */
const ENFORCEMENT_POINT = join(WEB_SRC, 'server', 'auth', 'verified-identity.ts');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Routes that are deliberately NOT session-rate-limited, each with the reason.
 *
 * An allowlist rather than a silent skip: a route that is exempt should be a decision somebody wrote down, and
 * an entry here that no longer matches a real file is itself an error (checked below), so this list cannot rot
 * into a set of stale excuses.
 */
const EXEMPT = new Map([
  [
    'apps/web/src/app/api/webhooks/clerk/route.ts',
    'CDR-081 §6.3 — authenticated by SIGNATURE, not by session, so there is no session key to meter. Throttling ' +
      'a signed sender risks dropping legitimate identity events, whose loss is a correctness problem ' +
      '(ACBP-P1-002) rather than a safety one.',
  ],
]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Route handlers: `route.ts` files that export at least one HTTP method. */
function routeHandlers() {
  return walk(APP_DIR)
    .filter((f) => /(^|[\\/])route\.tsx?$/.test(f))
    .map((file) => ({ file, src: readFileSync(file, 'utf8') }))
    .map((r) => ({ ...r, methods: HTTP_METHODS.filter((m) => new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(r.src)) }))
    .filter((r) => r.methods.length > 0);
}

/** Resolve one import specifier to a file inside apps/web/src, or null when it leaves the app. */
function resolveSpecifier(fromFile, spec) {
  let base;
  if (spec.startsWith('@/')) base = join(WEB_SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // a package import — outside apps/web, so not part of this walk
  // TypeScript ESM writes `.js` for a `.ts` source; try both, plus a directory index.
  for (const cand of [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Does `entry` reach the enforcement point through apps/web imports? */
function reachesEnforcement(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === ENFORCEMENT_POINT) return true;
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const next = resolveSpecifier(file, m[1]);
        if (next !== null && !seen.has(next)) stack.push(next);
      }
    }
  }
  return false;
}

const rel = (f) => relative(ROOT, f).split('\\').join('/');
const failures = [];

const handlers = routeHandlers();
if (handlers.length === 0) {
  console.error('✖ rate-limit coverage check FAILED — found ZERO route handlers, so this guard is measuring nothing.');
  console.error('  The walk or the app directory moved; a guard that silently checks an empty set is worse than none.');
  process.exit(1);
}

for (const { file, methods } of handlers) {
  const key = rel(file);
  if (EXEMPT.has(key)) continue;
  if (!reachesEnforcement(file)) {
    failures.push({ key, methods });
  }
}

// A stale exemption is a failure too: it reads as a considered decision about a route that no longer exists.
const handlerKeys = new Set(handlers.map((h) => rel(h.file)));
for (const key of EXEMPT.keys()) {
  if (!handlerKeys.has(key)) failures.push({ key, stale: true });
}

if (failures.length > 0) {
  console.error(`✖ rate-limit coverage check FAILED — ${failures.length} problem(s).`);
  console.error('  Every API route handler must reach the per-session ceiling in');
  console.error(`  ${rel(ENFORCEMENT_POINT)} (ACBP-P7-013; CDR-081; CDR-008 §8).`);
  console.error('  A handler that skips it is unbounded, and nothing else in the build will say so.');
  for (const f of failures) {
    if (f.stale) console.error(`  ${f.key}\n    EXEMPT entry names a route that does not exist — remove it or fix the path.`);
    else console.error(`  ${f.key}\n    exports ${f.methods.join(', ')} but never reaches the enforcement point.`);
  }
  console.error('  Fix by resolving the identity through @/server/auth/verified-identity (directly or via a');
  console.error('  request module), or add a deliberate entry to EXEMPT in this file WITH its reason.');
  process.exit(1);
}

console.log(`✔ rate-limit coverage check passed (${handlers.length - EXEMPT.size} route handler(s) reach the ceiling; ${EXEMPT.size} deliberately exempt).`);
