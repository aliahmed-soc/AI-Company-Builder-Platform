// ACBP-P7-013 / CDR-081 §4 — tests for the CSRF origin-gate check.
//
// The gate is enforced in ONE place, which is its strength (a route that does not exist yet is covered) and
// also its whole risk: it can be switched off for all 16 state-changing routes at once, silently, by an edit
// that looks reasonable in isolation. This checker is what makes that edit a red build — so a silently
// broken version of it would be worse than none, reporting a clean tree forever while the gate sat open.
//
// These run the REAL checker as a subprocess against fixture trees and assert BOTH directions for every
// rule: a compliant tree passes, and each individual violation fails with an actionable message.
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, '..', 'check-csrf-origin-gate.mjs');

const ROUTE_PATH_MODULE = `export const CLERK_WEBHOOK_PATH = '/api/webhooks/clerk';
export function isClerkWebhookPath(pathname) { return pathname === CLERK_WEBHOOK_PATH; }
`;

/** A proxy shaped like the real one. Each option removes exactly one property the checker guards. */
function proxySource({
  gate = true,
  gateBeforeSession = true,
  deny = true,
  matcher = `'/((?!_next).*)',\n    '/(api|trpc)(.*)',`,
  bypass = `  if (isClerkWebhookPath(new URL(request.url).pathname)) return undefined;\n`,
} = {}) {
  const gateCall = `  const verdict = decideSameOrigin({ method: request.method, secFetchSite: request.headers.get('sec-fetch-site'), origin: request.headers.get('origin') }, allowedOrigins);\n`;
  const denyLine = deny ? `  if (verdict.kind === 'deny') return NextResponse.json({ error: 'forbidden' }, { status: 403 });\n` : '';
  const session = `  return sessionProxy(request, event);\n`;
  const body = gate
    ? gateBeforeSession
      ? `${bypass}${gateCall}${denyLine}${session}`
      : `${bypass}${session}${gateCall}${denyLine}`
    : `${bypass}${session}`;
  return `import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { failClosed } from '@/server/auth/fail-closed-proxy';
import { isClerkWebhookPath } from '@/server/webhooks/route-path';
${gate ? `import { decideSameOrigin, allowedOriginsFromEnv } from '@/server/http/same-origin';\n` : ''}const sessionProxy = failClosed(clerkMiddleware());
${gate ? 'const allowedOrigins = allowedOriginsFromEnv(process.env);\n' : ''}const proxy = (request, event) => {
${body}};

export default proxy;

export const config = {
  matcher: [
    ${matcher}
  ],
};
`;
}

/** A throwaway repo shaped like apps/web: a proxy, the webhook path module, and some route modules. */
function makeTree({ proxy = proxySource(), routes = {}, routePath = ROUTE_PATH_MODULE } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-csrf-gate-'));
  mkdirSync(join(root, 'apps', 'web', 'src', 'server', 'webhooks'), { recursive: true });
  writeFileSync(join(root, 'apps', 'web', 'src', 'proxy.ts'), proxy);
  writeFileSync(join(root, 'apps', 'web', 'src', 'server', 'webhooks', 'route-path.ts'), routePath);
  for (const [rel, content] of Object.entries(routes)) {
    const full = join(root, 'apps', 'web', 'src', 'app', ...rel.split('/'), 'route.ts');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  cpSync(CHECKER, join(root, 'checker.mjs'));
  return root;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(root, 'checker.mjs')], { cwd: root, encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const GET_ROUTE = `export async function GET() { return new Response(null); }\n`;
const POST_ROUTE = `export async function POST() { return new Response(null); }\n`;

describe('a compliant tree passes', () => {
  test('gate present, before the session, denying, with the API matcher and API-only routes', () => {
    const r = run(makeTree({ routes: { 'api/companies': POST_ROUTE, 'api/companies/[companyId]/activity': GET_ROUTE } }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/csrf-origin-gate check/);
  });

  test('the clean line REPORTS THE COUNT, so the figure in CDR-081 §0.1 can be re-derived', () => {
    // A checker that only ever prints "ok" cannot be used as evidence of how much it covers.
    const r = run(makeTree({ routes: { 'api/a': POST_ROUTE, 'api/b': POST_ROUTE, 'api/c': GET_ROUTE } }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 state-changing/);
  });

  test('a route with no exported methods at all is not miscounted as state-changing', () => {
    const r = run(makeTree({ routes: { 'api/empty': `export const runtime = 'nodejs';\n` } }));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 state-changing/);
  });
});

describe('the four ways the gate gets switched off for every route at once', () => {
  test('FAILS when proxy.ts no longer calls the gate', () => {
    const r = run(makeTree({ proxy: proxySource({ gate: false }), routes: { 'api/companies': POST_ROUTE } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/decideSameOrigin/);
  });

  test('FAILS when the gate is called AFTER the session middleware', () => {
    // Denial after a session is established still refuses the request, so no functional test would catch
    // this — but it is not the order CDR-081 §2 asserts, and the claim "reaches no Clerk round trip" would
    // have quietly become false.
    const r = run(makeTree({ proxy: proxySource({ gateBeforeSession: false }), routes: { 'api/companies': POST_ROUTE } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/before/i);
  });

  test('FAILS when the deny branch no longer returns a 403', () => {
    const r = run(makeTree({ proxy: proxySource({ deny: false }), routes: { 'api/companies': POST_ROUTE } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/403/);
  });

  test('FAILS when the matcher stops covering /api', () => {
    // THE MOST DANGEROUS OF THE FOUR: a config edit far from any security-looking file, which leaves every
    // route uncovered while every test that drives the gate directly stays green.
    const r = run(makeTree({ proxy: proxySource({ matcher: `'/((?!_next).*)',` }), routes: { 'api/companies': POST_ROUTE } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/matcher/i);
  });
});

describe('coverage of routes and exemptions', () => {
  test('FAILS when a state-changing route lives OUTSIDE src/app/api', () => {
    const r = run(makeTree({ routes: { 'admin-tools': POST_ROUTE } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/admin-tools/);
  });

  test('a GET-only route outside src/app/api is fine — the rule is about state changes', () => {
    const r = run(makeTree({ routes: { 'auth-check': GET_ROUTE } }));
    expect(r.code).toBe(0);
  });

  test('FAILS when a SECOND path bypass appears beside the webhook one', () => {
    // A new exemption must be an edit to this checker, which is a visible decision — never a line added to
    // the proxy that nobody reviews as a security change.
    const bypass = `  if (isClerkWebhookPath(new URL(request.url).pathname)) return undefined;\n  if (new URL(request.url).pathname === '/api/internal/ping') return undefined;\n`;
    const r = run(makeTree({ proxy: proxySource({ bypass }), routes: { 'api/companies': POST_ROUTE } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/bypass|exempt/i);
  });

  test('FAILS when the webhook bypass is removed entirely', () => {
    // The opposite error, and it breaks identity ingestion rather than security: Clerk sends no provenance
    // headers, so an unbypassed webhook is denied by the no-provenance row.
    const r = run(makeTree({ proxy: proxySource({ bypass: '' }), routes: { 'api/companies': POST_ROUTE } }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/bypass|webhook/i);
  });

  test('FAILS when CLERK_WEBHOOK_PATH is widened to something other than the exact route', () => {
    const r = run(
      makeTree({ routePath: `export const CLERK_WEBHOOK_PATH = '/api/webhooks';\n`, routes: { 'api/companies': POST_ROUTE } }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/CLERK_WEBHOOK_PATH/);
  });
});

describe('every declaration shape a state-changing method can take', () => {
  // A guard that only knows one shape is a guard that reports clean. The webhook route uses the second
  // form and nothing stops a future route using the third or fourth.
  const shapes = {
    'export async function': `export async function POST() {}\n`,
    'export function': `export function POST() {}\n`,
    'export const arrow': `export const POST = async () => new Response(null);\n`,
    'export const handler ref': `const handler = () => {}; export const DELETE = handler;\n`,
    'renamed re-export': `function h() {} export { h as PATCH };\n`,
  };
  for (const [name, source] of Object.entries(shapes)) {
    test(`\`${name}\` outside src/app/api is caught`, () => {
      const r = run(makeTree({ routes: { 'outside': source } }));
      expect(r.code, `${name} was not detected`).toBe(1);
    });
  }

  test('a method NAME appearing only in a comment or string is not a false positive', () => {
    const r = run(
      makeTree({ routes: { 'outside': `// POST is handled elsewhere\nconst note = 'POST';\nexport async function GET() {}\n` } }),
    );
    expect(r.code).toBe(0);
  });
});

describe('the checker cannot pass while blind', () => {
  test('EXIT 2 when proxy.ts is missing — it can no longer see what it guards', () => {
    const root = mkdtempSync(join(tmpdir(), 'acbp-csrf-gate-blind-'));
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
    cpSync(CHECKER, join(root, 'checker.mjs'));
    const r = run(root);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/CANNOT SEE/i);
  });

  test('EXIT 2 when the matcher block cannot be located at all', () => {
    const proxy = proxySource().replace(/export const config[\s\S]*$/, '');
    const r = run(makeTree({ proxy, routes: { 'api/companies': POST_ROUTE } }));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/CANNOT SEE/i);
  });
});
