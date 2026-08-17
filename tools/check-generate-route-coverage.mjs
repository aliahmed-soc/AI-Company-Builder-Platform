#!/usr/bin/env node
// ACBP-API-008 slice 3b — the metered-route coverage check (CDR-092 §6, §7.5, §11).
//
// WHY THIS EXISTS, AND WHY IT IS NOT `check-rate-limit-coverage.mjs` AGAIN.
//
// Four routes in this application cause a PAID provider call. Each one is safe only because it passes through
// `resolveMeteredContext` — the per-company ceiling — before the use case is invoked, and each one is proven to
// refuse when that ceiling refuses by a behavioural test that asserts the metered method is never reached.
//
// Those tests are per-route, which means they cannot say anything at all about a FIFTH generate route added
// next year by someone who did not read them. This check is the part that can: it enumerates from the
// filesystem, so a new route joins the checked set the moment the file exists.
//
// ── WHY FILE-LEVEL REACHABILITY WOULD BE A CHECK THAT COULD NOT FAIL ─────────────────────────────────────────
//
// `check-rate-limit-coverage.mjs` walks imports and asks "does this handler reach `verified-identity.ts`". That
// question works there because the enforcement point is a DIFFERENT MODULE from the routes. Here it is not: the
// company ceiling and the metered call live in the same file, `companies-request.ts`, which EVERY companies
// route already imports. A transitive-import walk would therefore return true for a route that deliberately
// bypassed the ceiling — a green light that could not have come out any other way, which is the exact defect
// the standing rule at the top of AUTONOMOUS-RUN-LOG.md was written for.
//
// So the question is asked one level finer: which request-layer function does this route call, and does THAT
// function go through the metered path. Structural, not semantic — it proves the metered entry point is used,
// not that its result is obeyed. Obedience is proven behaviourally (CDR-092 §11), because a source check cannot
// distinguish a branch that refuses from a branch that logs and continues.
//
// EXIT CODES: 0 pass · 1 a real failure · 2 the check could not see what it is meant to check (a vanished
// directory is NOT agreement — the same rule as `check-cursor-rules-sync.mjs`).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// The default root only. Both paths this check reads are derived INSIDE `check(root)` from its argument, so the
// regression suite can point the whole check at a throwaway tree — a checker that could only ever read the real
// repository is one whose failure modes can never be exercised.
const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

/**
 * A route directory named one of these is a METERED route and must be covered.
 *
 * Naming, not an allowlist of paths: an allowlist is a list somebody has to remember to extend, and the whole
 * point of this check is to catch the route added by someone who did not know it existed. The cost is that a
 * metered route named something else escapes — which is why `EXPECTED_MINIMUM` below is a floor on the count
 * and the four known routes are named explicitly in `EXPECTED_ROUTES`.
 */
const METERED_DIR_NAMES = new Set(['generate', 'recommend']);

/** The four that exist today. A missing one fails: renaming a money route must never quietly shrink this set. */
const EXPECTED_ROUTES = [
  'apps/web/src/app/api/companies/[companyId]/strategy/generate/route.ts',
  'apps/web/src/app/api/companies/[companyId]/strategy/recommend/route.ts',
  'apps/web/src/app/api/companies/[companyId]/roadmap/generate/route.ts',
  'apps/web/src/app/api/companies/[companyId]/tasks/generate/route.ts',
];

/**
 * The floor. CDR-092 §7.5: "a checker that discovers zero generate routes and reports success is the exact
 * artefact the standing rule warns about". This is the assertion that makes an empty walk loud.
 */
const EXPECTED_MINIMUM = 4;

/** The helper every metered request function must go through, and what it must itself contain. */
const METERED_HELPER = 'resolveMeteredContext';
const HELPER_REQUIREMENTS = [
  { needle: "checkRequestLimit('company'", why: 'the per-company ceiling must actually be consumed' },
  { needle: "limit.kind === 'throttled'", why: 'a throttled ceiling must be recognised' },
  { needle: "limit.kind === 'unavailable'", why: 'an unreadable bucket must fail CLOSED, not fall through' },
];

/** The non-metered resolver. Its presence inside a metered function means the ceiling was skipped. */
const UNMETERED_HELPER = 'resolveActorWithAccount';

export function listRouteFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listRouteFiles(full, out);
    else if (entry === 'route.ts' || entry === 'route.tsx') out.push(full);
  }
  return out;
}

/** Is this route file inside a directory the naming convention marks as metered? */
export function isMeteredRoute(file) {
  return METERED_DIR_NAMES.has(basename(dirname(file)));
}

/**
 * The request-layer functions a route imports from `companies-request`.
 *
 * Deliberately scoped to that module: a route importing a same-named function from anywhere else has not been
 * checked, and would be reported as uncovered rather than assumed fine.
 */
export function requestFunctionsOf(source) {
  const names = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*companies-request['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name !== '') names.push(name);
    }
  }
  return names;
}

/**
 * The source text of one exported function, from its signature to the closing brace in column 0.
 *
 * Brace-column matching rather than a parser: this repository is prettier-formatted with a 100% consistent
 * top-level function shape, and a real parser would be a dependency and a second thing to keep working. It
 * returns null when the function is not found, and the caller treats null as a FAILURE — never as "fine".
 */
export function functionBody(source, name) {
  // `export` is OPTIONAL: the metered helper is deliberately module-private, and requiring the keyword would
  // have made this check fail for the one function it most needs to read.
  const start = source.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, 'm'));
  if (start === -1) return null;
  const rest = source.slice(start);
  const end = rest.search(/^\}/m);
  return end === -1 ? null : rest.slice(0, end + 1);
}

/** Self-test: the extractor must actually extract, or every verdict below is vacuous. */
function selfTest() {
  const sample = ['export async function alpha(x) {', "  const ctx = await resolveMeteredContext(a, b, c);", '  return ctx;', '}', '', 'export function beta() {', '  return 1;', '}', ''].join('\n');
  const alpha = functionBody(sample, 'alpha');
  const problems = [];
  if (alpha === null || !alpha.includes(METERED_HELPER)) problems.push('functionBody did not extract a body containing its own text');
  if (alpha !== null && alpha.includes('beta')) problems.push('functionBody ran past the closing brace into the next function');
  if (functionBody(sample, 'gamma') !== null) problems.push('functionBody invented a body for a function that does not exist');
  if (requestFunctionsOf("import { a, type B, c as d } from '@/server/companies/companies-request';").join(',') !== 'a,B,c') {
    problems.push('requestFunctionsOf did not parse a mixed import clause');
  }
  if (isMeteredRoute(join('x', 'strategy', 'generate', 'route.ts')) !== true) problems.push('isMeteredRoute missed a generate directory');
  if (isMeteredRoute(join('x', 'strategy', 'route.ts')) !== false) problems.push('isMeteredRoute claimed a plain route was metered');
  return problems;
}

export function check(root = ROOT) {
  const appDir = join(root, 'apps', 'web', 'src', 'app', 'api');
  const requestModule = join(root, 'apps', 'web', 'src', 'server', 'companies', 'companies-request.ts');
  const rel = (f) => relative(root, f).split('\\').join('/');
  const blind = [];
  if (!existsSync(appDir)) blind.push(`the route directory is not there: ${rel(appDir)}`);
  if (!existsSync(requestModule)) blind.push(`the request module is not there: ${rel(requestModule)}`);
  if (blind.length > 0) return { code: 2, blind, failures: [], covered: [] };

  const failures = [];
  const requestSource = readFileSync(requestModule, 'utf8');

  // The helper itself, first. Everything below leans on it, so a checker that verified the routes reach a
  // helper that no longer enforces anything would be measuring a pipe with nothing in it.
  const helperBody = functionBody(requestSource, METERED_HELPER);
  if (helperBody === null) {
    failures.push(`${METERED_HELPER} is not a top-level function in ${rel(requestModule)} — every metered route depends on it.`);
  } else {
    for (const { needle, why } of HELPER_REQUIREMENTS) {
      if (!helperBody.includes(needle)) failures.push(`${METERED_HELPER} no longer contains \`${needle}\` — ${why}.`);
    }
  }

  const routes = listRouteFiles(appDir).filter(isMeteredRoute);
  const covered = [];
  for (const file of routes) {
    const key = rel(file);
    const src = readFileSync(file, 'utf8');
    if (!/export\s+(async\s+)?function\s+POST\b/.test(src)) {
      failures.push(`${key}\n    is in a metered directory but exports no POST handler — is it a route at all?`);
      continue;
    }
    const imported = requestFunctionsOf(src).filter((n) => n.endsWith('ForRequest'));
    if (imported.length === 0) {
      failures.push(`${key}\n    calls no *ForRequest function from companies-request, so nothing here goes through the company ceiling.`);
      continue;
    }
    for (const name of imported) {
      const body = functionBody(requestSource, name);
      if (body === null) {
        failures.push(`${key}\n    imports ${name}, which is not an exported function in ${rel(requestModule)}.`);
        continue;
      }
      if (!body.includes(`${METERED_HELPER}(`)) {
        failures.push(`${key}\n    ${name} does not call ${METERED_HELPER} — a paid call with no per-company ceiling in front of it.`);
      }
      if (body.includes(`${UNMETERED_HELPER}(`)) {
        failures.push(`${key}\n    ${name} calls ${UNMETERED_HELPER}, the UNMETERED resolver — the company ceiling is being skipped.`);
      }
      if (!body.includes('callMetered(')) {
        failures.push(`${key}\n    ${name} does not invoke the use case through callMetered, so an unconfigured gateway becomes an anonymous 500.`);
      }
      covered.push(`${key} → ${name}`);
    }
  }

  // The floor. An empty or shrunken walk is a FAILURE, never a pass: this is the assertion that stops a rename
  // from silently converting the whole check into one that cannot fail.
  if (routes.length < EXPECTED_MINIMUM) {
    failures.push(
      `discovered ${routes.length} metered route(s), expected at least ${EXPECTED_MINIMUM}.\n` +
        `    Either a money route was deleted, or the walk stopped finding them — and a check that finds nothing\n` +
        `    must never report success (CDR-092 §7.5).`,
    );
  }
  const found = new Set(routes.map(rel));
  for (const expected of EXPECTED_ROUTES) {
    if (!found.has(expected)) failures.push(`the known metered route ${expected} was not discovered — deleted, renamed, or moved out of the walk.`);
  }

  return { code: failures.length > 0 ? 1 : 0, blind: [], failures, covered };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selfProblems = selfTest();
  if (selfProblems.length > 0) {
    console.error('✖ generate-route coverage check FAILED ITS OWN SELF-TEST — its verdicts below would mean nothing.');
    for (const p of selfProblems) console.error(`  ${p}`);
    process.exit(1);
  }
  const { code, blind, failures, covered } = check();
  if (code === 2) {
    console.error('✖ generate-route coverage check COULD NOT RUN — it cannot see what it is meant to check.');
    for (const b of blind) console.error(`  ${b}`);
    console.error('  Exiting 2 rather than 0: a missing target is not evidence that everything is fine.');
    process.exit(2);
  }
  if (code === 1) {
    console.error(`✖ generate-route coverage check FAILED — ${failures.length} problem(s).`);
    console.error('  Every route that causes a PAID provider call must reach the per-company ceiling through');
    console.error('  resolveMeteredContext before the use case runs (ACBP-API-008; CDR-092 §2, §6.2).');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`✔ generate-route coverage check passed (${covered.length} metered handler(s) reach the company ceiling). Self-test passed.`);
  for (const c of covered) console.log(`    ${c}`);
}
