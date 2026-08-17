// Regression suite for `tools/check-generate-route-coverage.mjs` (ACBP-API-008 slice 3b; CDR-092 §11).
//
// A guard that has never been watched to fail is not a guard. Each case below is one of the four probes that
// were run against the REAL repository before this checker was trusted — an unmetered fifth route, a renamed
// route, a metered function switched to the unmetered resolver, and a gutted helper — pinned here so they stay
// killed. `check()` takes a root, so every case builds a throwaway tree rather than mutating the repository.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, functionBody, requestFunctionsOf, isMeteredRoute, listRouteFiles } from '../check-generate-route-coverage.mjs';

const ROUTE_DIRS = [
  ['companies', '[companyId]', 'strategy', 'generate'],
  ['companies', '[companyId]', 'strategy', 'recommend'],
  ['companies', '[companyId]', 'roadmap', 'generate'],
  ['companies', '[companyId]', 'tasks', 'generate'],
];
const FN_FOR = {
  'strategy/generate': 'generateStrategyForRequest',
  'strategy/recommend': 'recommendStrategyForRequest',
  'roadmap/generate': 'generateRoadmapForRequest',
  'tasks/generate': 'generateTasksForRequest',
};

/** A request-layer function in the compliant shape. */
function meteredFunction(name) {
  return [
    `export async function ${name}(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {`,
    '  const runtime = await runtimeOf(deps);',
    '  const ctx = await resolveMeteredContext(deps, runtime, companyId);',
    "  if ('kind' in ctx) return ctx.result;",
    '  const call = await callMetered(() => runtime.doIt({ companyId }));',
    '  if (!call.ok) return call.refusal;',
    "  return { status: 'ok' };",
    '}',
    '',
  ].join('\n');
}

/** The compliant helper. */
function helper() {
  return [
    'async function resolveMeteredContext(deps, runtime, companyId) {',
    '  const ctx = await resolveActorWithAccount(deps, runtime);',
    "  if ('kind' in ctx) return ctx;",
    "  const limit = await runtime.checkRequestLimit('company', companyId);",
    "  if (limit.kind === 'throttled') return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds } };",
    "  if (limit.kind === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };",
    '  return ctx;',
    '}',
    '',
  ].join('\n');
}

function routeSource(fn) {
  return [`import { ${fn} } from '@/server/companies/companies-request';`, '', 'export async function POST(request: Request): Promise<Response> {', `  return respond(() => ${fn}('co'));`, '}', ''].join('\n');
}

let root;

/** Build a compliant tree. Every failing case below starts here and breaks exactly one thing. */
function buildRepo(overrides = {}) {
  const apiDir = join(root, 'apps', 'web', 'src', 'app', 'api');
  for (const parts of ROUTE_DIRS) {
    const dir = join(apiDir, ...parts);
    mkdirSync(dir, { recursive: true });
    const key = `${parts[2]}/${parts[3]}`;
    writeFileSync(join(dir, 'route.ts'), overrides.routes?.[key] ?? routeSource(FN_FOR[key]), 'utf8');
  }
  const serverDir = join(root, 'apps', 'web', 'src', 'server', 'companies');
  mkdirSync(serverDir, { recursive: true });
  const body = overrides.requestModule ?? [overrides.helper ?? helper(), ...Object.values(FN_FOR).map((n) => overrides.functions?.[n] ?? meteredFunction(n))].join('\n');
  writeFileSync(join(serverDir, 'companies-request.ts'), body, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acbp-genroute-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the comparator itself', () => {
  test('functionBody stops at the closing brace and does not run into the next function', () => {
    const src = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}', ''].join('\n');
    expect(functionBody(src, 'a')).toContain('return 1;');
    expect(functionBody(src, 'a')).not.toContain('return 2;');
  });

  test('functionBody returns null for a function that is not there — never an empty string', () => {
    // An empty string would be falsy AND would pass every `.includes()` check as false, producing failures with
    // a misleading cause. Null forces the caller to treat "not found" as its own answer.
    expect(functionBody('function a() {\n}\n', 'missing')).toBeNull();
  });

  test('functionBody does not match a name that merely starts the same', () => {
    const src = ['function generateTasksForRequestOld() {', "  const x = 'unmetered';", '}', ''].join('\n');
    expect(functionBody(src, 'generateTasksForRequest')).toBeNull();
  });

  test('requestFunctionsOf reads a mixed import clause and ignores other modules', () => {
    const src = ["import { alpha, type Beta, gamma as g } from '@/server/companies/companies-request';", "import { delta } from '@/server/other';", ''].join('\n');
    expect(requestFunctionsOf(src)).toEqual(['alpha', 'Beta', 'gamma']);
  });

  test('isMeteredRoute keys on the directory name, both ways', () => {
    expect(isMeteredRoute(join('a', 'strategy', 'generate', 'route.ts'))).toBe(true);
    expect(isMeteredRoute(join('a', 'strategy', 'recommend', 'route.ts'))).toBe(true);
    expect(isMeteredRoute(join('a', 'strategy', 'route.ts'))).toBe(false);
  });

  test('listRouteFiles finds nothing in a directory that is not there, rather than throwing', () => {
    expect(listRouteFiles(join(root, 'nope'))).toEqual([]);
  });
});

describe('a compliant repository', () => {
  test('passes, and names every handler it checked', () => {
    buildRepo();
    const r = check(root);
    expect(r.failures).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.covered).toHaveLength(4);
  });
});

describe('the four probes that were run against the real repository', () => {
  test('PROBE 1 — an unmetered FIFTH generate route fails', () => {
    // The case the per-route behavioural tests structurally cannot catch: a new route nobody wrote a test for.
    buildRepo();
    const dir = join(root, 'apps', 'web', 'src', 'app', 'api', 'companies', '[companyId]', 'understanding', 'generate');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'route.ts'), routeSource('getStrategyForRequest'), 'utf8');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('understanding/generate/route.ts');
  });

  test('PROBE 2 — a metered function switched to the UNMETERED resolver fails, and says which', () => {
    const bypassed = meteredFunction('generateStrategyForRequest').replace('resolveMeteredContext(deps, runtime, companyId)', 'resolveActorWithAccount(deps, runtime)');
    buildRepo({ functions: { generateStrategyForRequest: bypassed } });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('the company ceiling is being skipped');
  });

  test('PROBE 3 — a renamed route fails on BOTH the floor and the known-route list', () => {
    buildRepo();
    const strategy = join(root, 'apps', 'web', 'src', 'app', 'api', 'companies', '[companyId]', 'strategy');
    renameSync(join(strategy, 'generate'), join(strategy, 'generate-hidden'));
    const r = check(root);
    expect(r.code).toBe(1);
    const text = r.failures.join('\n');
    expect(text).toContain('discovered 3 metered route(s), expected at least 4');
    expect(text).toContain('strategy/generate/route.ts was not discovered');
  });

  test('PROBE 4 — a gutted helper fails even though every route still calls it', () => {
    // The subtle one. Every route reaches `resolveMeteredContext`; the helper simply stopped enforcing anything.
    // A reachability-only check would report success here, which is why the helper's contents are checked too.
    const gutted = helper().replace("checkRequestLimit('company', companyId)", "checkRequestLimit('account', companyId)").replace(/\s+if \(limit\.kind === 'throttled'\).*\n/, '\n');
    buildRepo({ helper: gutted });
    const r = check(root);
    expect(r.code).toBe(1);
    const text = r.failures.join('\n');
    expect(text).toContain("no longer contains `checkRequestLimit('company'");
    expect(text).toContain("no longer contains `limit.kind === 'throttled'");
  });
});

describe('the ways this check could quietly stop checking', () => {
  test('a missing app directory exits 2, NOT 0 — a vanished target is not agreement', () => {
    buildRepo();
    rmSync(join(root, 'apps', 'web', 'src', 'app'), { recursive: true, force: true });
    const r = check(root);
    expect(r.code).toBe(2);
    expect(r.blind.join('\n')).toContain('route directory');
  });

  test('a missing request module exits 2 as well', () => {
    buildRepo();
    rmSync(join(root, 'apps', 'web', 'src', 'server'), { recursive: true, force: true });
    expect(check(root).code).toBe(2);
  });

  test('an EMPTY api directory fails rather than passing on zero routes', () => {
    // The precise artefact CDR-092 §7.5 forbade: "a checker that discovers zero generate routes and reports
    // success". Without the floor this returns 0 findings and a clean bill of health.
    mkdirSync(join(root, 'apps', 'web', 'src', 'app', 'api'), { recursive: true });
    mkdirSync(join(root, 'apps', 'web', 'src', 'server', 'companies'), { recursive: true });
    writeFileSync(join(root, 'apps', 'web', 'src', 'server', 'companies', 'companies-request.ts'), helper(), 'utf8');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('discovered 0 metered route(s)');
  });

  test('a metered route with no POST handler fails rather than being skipped', () => {
    buildRepo({ routes: { 'tasks/generate': "import { generateTasksForRequest } from '@/server/companies/companies-request';\n" } });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('exports no POST handler');
  });

  test('a route importing a *ForRequest function that does not exist in the request module fails', () => {
    // Names the checker cannot resolve are a FAILURE, never a skip: an unresolvable name is exactly what a
    // half-finished rename looks like, and "I could not find it" must not read as "it was fine".
    buildRepo({ routes: { 'roadmap/generate': routeSource('generateRoadmapV2ForRequest') } });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('which is not an exported function');
  });

  test('a route whose import does not match the *ForRequest convention is reported, not silently ignored', () => {
    // The filter that finds request functions keys on the name. A route that imports something else has not been
    // checked, so it must fail rather than fall through the filter into an empty, passing set.
    buildRepo({ routes: { 'roadmap/generate': routeSource('generateRoadmapTypo') } });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('calls no *ForRequest function');
  });

  test('dropping callMetered fails — an unconfigured gateway would become an anonymous 500', () => {
    const noCatch = meteredFunction('generateTasksForRequest').replace('await callMetered(() => runtime.doIt({ companyId }))', 'await runtime.doIt({ companyId })');
    buildRepo({ functions: { generateTasksForRequest: noCatch } });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('does not invoke the use case through callMetered');
  });
});

describe('the repository itself', () => {
  test('passes its own check', () => {
    // Runs against the real tree. If this is the only case that ever runs, the suite above is what makes its
    // green mean something.
    const r = check(process.cwd());
    expect(r.blind).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(r.covered.length).toBeGreaterThanOrEqual(4);
  });
});
