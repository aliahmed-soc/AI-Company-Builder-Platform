// Regression suite for `tools/check-generate-route-coverage.mjs` (ACBP-API-008 slice 3b; CDR-092 §11).
//
// A guard that has never been watched to fail is not a guard. Each case below is one of the four probes that
// were run against the REAL repository before this checker was trusted — an unmetered fifth route, a renamed
// route, a metered function switched to the unmetered resolver, and a gutted helper — pinned here so they stay
// killed. `check()` takes a root, so every case builds a throwaway tree rather than mutating the repository.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, functionBody, requestFunctionsOf, isMeteredRoute, listRouteFiles } from '../check-generate-route-coverage.mjs';

const SCRIPT = join(process.cwd(), 'tools', 'check-generate-route-coverage.mjs');

/**
 * The metered routes the fixture models, mirroring the real repository's SIX.
 *
 * ⚠️ THE TWO INTERVIEW ROWS ARE NOT DECORATION. They are the reason the fixture is keyed on an explicit `key`
 * rather than on path segments: their directories nest two levels deeper than the generate routes, and they reach
 * the ceiling through a DIFFERENT helper. A fixture that modelled only the generate shape would let a checker
 * regression that broke the member-level helper pass every case here.
 */
const ROUTE_DEFS = [
  { parts: ['companies', '[companyId]', 'strategy', 'generate'], key: 'strategy/generate', fn: 'generateStrategyForRequest', helper: 'resolveMeteredContext' },
  { parts: ['companies', '[companyId]', 'strategy', 'recommend'], key: 'strategy/recommend', fn: 'recommendStrategyForRequest', helper: 'resolveMeteredContext' },
  { parts: ['companies', '[companyId]', 'roadmap', 'generate'], key: 'roadmap/generate', fn: 'generateRoadmapForRequest', helper: 'resolveMeteredContext' },
  { parts: ['companies', '[companyId]', 'tasks', 'generate'], key: 'tasks/generate', fn: 'generateTasksForRequest', helper: 'resolveMeteredContext' },
  { parts: ['companies', '[companyId]', 'interview', 'questions', '[questionId]', 'evaluate'], key: 'interview/evaluate', fn: 'evaluateAnswerForRequest', helper: 'resolveMeteredParticipateSession' },
  { parts: ['companies', '[companyId]', 'interview', 'questions', '[questionId]', 'assumption'], key: 'interview/assumption', fn: 'suggestAssumptionForRequest', helper: 'resolveMeteredParticipateSession' },
];

/** A request-layer function in the compliant shape, through whichever ceiling its posture uses. */
function meteredFunction(name, helperName = 'resolveMeteredContext') {
  const call = helperName === 'resolveMeteredContext' ? `${helperName}(deps, runtime, companyId)` : `${helperName}(companyId, deps)`;
  return [
    `export async function ${name}(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {`,
    '  const runtime = await runtimeOf(deps);',
    `  const ctx = await ${call};`,
    "  if ('kind' in ctx) return ctx.result;",
    '  const call = await callMetered(() => runtime.doIt({ companyId }));',
    '  if (!call.ok) return call.refusal;',
    "  return { status: 'ok' };",
    '}',
    '',
  ].join('\n');
}

/**
 * The MEMBER-level ceiling, always present and deliberately NOT overridable.
 *
 * The gutting cases below replace `helper()` to prove the checker notices a broken ceiling. If they replaced this
 * one too, each of those cases would fail for two reasons at once and a regression in either helper would be
 * indistinguishable from a regression in the other.
 */
function participateHelper() {
  return [
    'async function resolveMeteredParticipateSession(companyId, deps) {',
    '  const runtime = await runtimeOf(deps);',
    '  const ctx = await resolveActorWithAccount(deps, runtime);',
    "  if ('kind' in ctx) return ctx;",
    '  const authz = await runtime.authorizeMeteredParticipate({ userId: ctx.userId, companyId, action: to });',
    "  if (authz === 'forbidden') return { kind: 'result', result: { status: 'forbidden' } };",
    "  const limit = await runtime.checkRequestLimit('company', companyId);",
    "  if (limit.kind === 'throttled') return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds } };",
    "  if (limit.kind === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };",
    '  return ctx;',
    '}',
    '',
  ].join('\n');
}

/** The compliant OWNER-ONLY helper. */
function helper() {
  return [
    'async function resolveMeteredContext(deps, runtime, companyId, action) {',
    '  const ctx = await resolveActorWithAccount(deps, runtime);',
    "  if ('kind' in ctx) return ctx;",
    '  const authz = await runtime.authorizeMeteredGenerate({ userId: ctx.userId, accountId: ctx.accountId, companyId, action });',
    "  if (authz === 'forbidden') return { kind: 'result', result: { status: 'forbidden' } };",
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
  for (const def of ROUTE_DEFS) {
    const dir = join(apiDir, ...def.parts);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'route.ts'), overrides.routes?.[def.key] ?? routeSource(def.fn), 'utf8');
  }
  const serverDir = join(root, 'apps', 'web', 'src', 'server', 'companies');
  mkdirSync(serverDir, { recursive: true });
  const body =
    overrides.requestModule ??
    [
      overrides.helper ?? helper(),
      participateHelper(),
      ...ROUTE_DEFS.map((d) => overrides.functions?.[d.fn] ?? meteredFunction(d.fn, d.helper)),
      overrides.extraFunctions ?? '',
    ].join('\n');
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
    expect(r.covered).toHaveLength(6);
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
    expect(text).toContain('discovered 5 metered route(s), expected at least 6');
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

/**
 * An adversarial review of this checker built throwaway trees and found SIX shapes that passed while the company
 * ceiling was not enforced. Four of them are below (the other two are the same defect as the first two). They are
 * pinned here for the same reason as the original four probes: a hole that has been closed without a test is a
 * hole that reopens.
 */
describe('the six bypasses an adversarial review actually demonstrated', () => {
  test('BYPASS 1 — the ceiling COMMENTED OUT fails, though all three marker strings survive as comment text', () => {
    // The most likely way this guard ever dies: a TODO, not a deletion. Every needle is still present in the
    // file, so a substring check over raw source reports success while nothing is enforced.
    const commented = [
      'async function resolveMeteredContext(deps, runtime, companyId) {',
      '  const ctx = await resolveActorWithAccount(deps, runtime);',
      "  if ('kind' in ctx) return ctx;",
      '  // TODO(perf): re-enable once bucket contention is fixed.',
      "  // const limit = await runtime.checkRequestLimit('company', companyId);",
      "  // if (limit.kind === 'throttled') return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: 1 } };",
      "  // if (limit.kind === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };",
      '  return ctx;',
      '}',
      '',
    ].join('\n');
    buildRepo({ helper: commented });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain("no longer contains `checkRequestLimit('company'");
  });

  test('BYPASS 2 — a metered call commented out of a request function fails too', () => {
    const commented = meteredFunction('generateStrategyForRequest')
      .replace('  const ctx = await resolveMeteredContext(deps, runtime, companyId);', '  // const ctx = await resolveMeteredContext(deps, runtime, companyId);\n  const ctx = await resolveActorWithAccount(deps, runtime);')
      .replace("  if ('kind' in ctx) return ctx.result;", '');
    buildRepo({ functions: { generateStrategyForRequest: commented } });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('calls neither resolveMeteredContext or resolveMeteredParticipateSession');
  });

  test('BYPASS 3 — importing the compliant function without CALLING it fails', () => {
    // The checker verified that a compliant name was imported and never that the handler used it. A handler that
    // imports it, re-exports it to satisfy the linter, and then calls the runtime directly, passed.
    const smuggled = [
      "import { generateTasksForRequest } from '@/server/companies/companies-request';",
      "import { runtimeOf } from '@/server/companies/runtime';",
      '',
      'export const _unused = generateTasksForRequest;',
      '',
      'export async function POST(request: Request): Promise<Response> {',
      '  const runtime = await runtimeOf({});',
      '  return Response.json(await runtime.generateTasks({ companyId: fromUrl(request) }));',
      '}',
      '',
    ].join('\n');
    buildRepo({ routes: { 'tasks/generate': smuggled } });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('never calls');
  });

  test('BYPASS 4 — a SECOND HTTP method on a metered route that skips the ceiling fails', () => {
    // Only POST was ever examined. A compliant POST beside an unmetered PUT on the same money route passed.
    const twoMethods = [
      "import { generateRoadmapForRequest } from '@/server/companies/companies-request';",
      "import { runtimeOf } from '@/server/companies/runtime';",
      '',
      'export async function POST(request: Request): Promise<Response> {',
      "  return respond(() => generateRoadmapForRequest('co'));",
      '}',
      '',
      'export async function PUT(request: Request): Promise<Response> {',
      '  const runtime = await runtimeOf({});',
      "  return Response.json(await runtime.generateRoadmap({ companyId: 'co' }));",
      '}',
      '',
    ].join('\n');
    buildRepo({ routes: { 'roadmap/generate': twoMethods } });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('PUT');
  });

  test('BYPASS 5 — a paid route NOT named generate or recommend is caught by the metered-method rule', () => {
    // `isMeteredRoute` keys on the directory name, so `brief/compose` was never examined at all. The floor does
    // not help: it counts routes matching the convention, and a route outside it neither raises nor lowers that.
    // The metered-METHOD rule catches it from the other direction — any request function that calls a paid
    // runtime method must go through the ceiling, whatever the route above it is called.
    const unmetered = [
      'export async function composeBriefForRequest(companyId: string, deps = {}) {',
      '  const runtime = await runtimeOf(deps);',
      '  const ctx = await resolveActorWithAccount(deps, runtime);',
      "  if ('kind' in ctx) return ctx.result;",
      '  return runtime.generateStrategyOptions({ companyId });',
      '}',
      '',
    ].join('\n');
    buildRepo({ extraFunctions: unmetered });
    const r = check(root);
    expect(r.code).toBe(1);
    const text = r.failures.join('\n');
    expect(text).toContain('composeBriefForRequest');
    expect(text).toContain('generateStrategyOptions');
  });

  test('BYPASS 6 — the exit-code contract is asserted by RUNNING the script, not by reading check()', () => {
    // Every other case here imports `check()` and inspects `r.code`. Nothing spawned the script, so changing
    // `process.exit(2)` to `process.exit(0)` left the whole suite green — the advertised contract had no test.
    buildRepo();
    expect(spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' }).status).toBe(0);
    rmSync(join(root, 'apps', 'web', 'src', 'server'), { recursive: true, force: true });
    const blindRun = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
    expect(blindRun.status).toBe(2);
    expect(blindRun.stderr).toContain('COULD NOT RUN');
  });

  test('BYPASS 7 — debiting the company bucket BEFORE authorizeMeteredGenerate fails', () => {
    // CDR-092 §15. Presence of both needles is not enough: the old helper had the consume and would still
    // pass every requirement except order. That is the drain.
    const swapped = [
      'async function resolveMeteredContext(deps, runtime, companyId, action) {',
      '  const ctx = await resolveActorWithAccount(deps, runtime);',
      "  if ('kind' in ctx) return ctx;",
      "  const limit = await runtime.checkRequestLimit('company', companyId);",
      "  if (limit.kind === 'throttled') return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds } };",
      "  if (limit.kind === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };",
      '  const authz = await runtime.authorizeMeteredGenerate({ userId: ctx.userId, accountId: ctx.accountId, companyId, action });',
      "  if (authz === 'forbidden') return { kind: 'result', result: { status: 'forbidden' } };",
      '  return ctx;',
      '}',
      '',
    ].join('\n');
    buildRepo({ helper: swapped });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('AFTER debiting the company bucket');
  });
});

/**
 * ACBP-API-013 added a SECOND metered helper, and with it the way this checker could quietly stop checking half of
 * what it covers. Every case above gutted `resolveMeteredContext`; none of them could have noticed if the new
 * helper's requirements were never evaluated at all. These three watch the member-level ceiling fail.
 */
describe('the MEMBER-level ceiling is checked, not just the owner-only one', () => {
  /** A request module whose participate helper is whatever the case supplies. */
  function withParticipateHelper(body) {
    return [helper(), body, ...ROUTE_DEFS.map((d) => meteredFunction(d.fn, d.helper))].join('\n');
  }

  test('a participate helper that debits BEFORE authorizing fails on order, exactly as the generate one does', () => {
    const swapped = [
      'async function resolveMeteredParticipateSession(companyId, deps) {',
      '  const ctx = await resolveActorWithAccount(deps, runtimeOf(deps));',
      "  if ('kind' in ctx) return ctx;",
      "  const limit = await runtime.checkRequestLimit('company', companyId);",
      "  if (limit.kind === 'throttled') return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: 1 } };",
      "  if (limit.kind === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };",
      '  const authz = await runtime.authorizeMeteredParticipate({ userId: ctx.userId, companyId });',
      "  if (authz === 'forbidden') return { kind: 'result', result: { status: 'forbidden' } };",
      '  return ctx;',
      '}',
      '',
    ].join('\n');
    buildRepo({ requestModule: withParticipateHelper(swapped) });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('resolveMeteredParticipateSession consults authorizeMeteredParticipate AFTER debiting the company bucket');
  });

  test('a participate helper that stopped authorizing at all fails — a debit with nothing in front of it', () => {
    const noAuthz = [
      'async function resolveMeteredParticipateSession(companyId, deps) {',
      '  const ctx = await resolveActorWithAccount(deps, runtimeOf(deps));',
      "  if ('kind' in ctx) return ctx;",
      "  const limit = await runtime.checkRequestLimit('company', companyId);",
      "  if (limit.kind === 'throttled') return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: 1 } };",
      "  if (limit.kind === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };",
      '  return ctx;',
      '}',
      '',
    ].join('\n');
    buildRepo({ requestModule: withParticipateHelper(noAuthz) });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('no longer calls authorizeMeteredParticipate');
  });

  test('a VANISHED participate helper fails rather than being skipped — absence is not compliance', () => {
    // The `continue` this replaced would have been the quiet death: delete the helper and the only thing that
    // checks it disappears with it.
    buildRepo({ requestModule: withParticipateHelper('') });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('resolveMeteredParticipateSession is not a top-level function');
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
