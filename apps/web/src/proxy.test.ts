// ACBP-P7-014 / CDR-081 §2 — the request-interception boundary, driven as the REAL exported module.
//
// `proxy.ts` had no test file before this ticket. That mattered: it is the single point every request
// crosses, and after this ticket it is the ENFORCEMENT POINT for CSRF. same-origin.test.ts proves what the
// gate decides; this suite proves the gate is CALLED, is called in the right ORDER, and that the three
// things which must stay ungated stayed ungated.
//
// THE ONLY SEAM is the provider SDK: `@clerk/nextjs/server` is mocked so `clerkMiddleware()` yields a spy
// instead of contacting Clerk. Everything else — the gate, the webhook bypass, `failClosed`, the matcher —
// is the production module. The spy is what makes the ORDERING assertions possible: "denied" and "denied
// only after a session was established" are different claims, and CDR-081 §2 asserts the first.
import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { NextMiddleware } from 'next/server';

/** Records every request that reached Clerk's session middleware. Empty means the gate refused first. */
const sessionCalls: string[] = [];

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: () => (request: Request) => {
    sessionCalls.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response(null, { status: 204 });
  },
}));

const APP_ORIGIN = 'https://app.example.test';

// The gate reads APP_PUBLIC_URL through `allowedOriginsFromEnv`. Set before the module under test loads.
process.env['APP_PUBLIC_URL'] = APP_ORIGIN;

const { default: proxy, config } = await import('./proxy.js');

type ProxyArgs = Parameters<NextMiddleware>;
const event = {} as ProxyArgs[1];

/** Build a request the way a browser would, then hand it to the real proxy. */
async function run(
  path: string,
  init: { method?: string; secFetchSite?: string; origin?: string } = {},
): Promise<Response | undefined> {
  const headers = new Headers();
  if (init.secFetchSite !== undefined) headers.set('sec-fetch-site', init.secFetchSite);
  if (init.origin !== undefined) headers.set('origin', init.origin);
  const request = new Request(`${APP_ORIGIN}${path}`, { method: init.method ?? 'POST', headers });
  // `null` and `undefined` both mean "the proxy did not answer"; normalize so the assertions read cleanly.
  const result = await proxy(request as unknown as ProxyArgs[0], event);
  return result ?? undefined;
}

beforeEach(() => {
  sessionCalls.length = 0;
});

describe('a forged cross-site request is refused at the boundary', () => {
  test('a cross-site POST to a real state-changing route is 403 and NEVER reaches the session', async () => {
    const response = await run('/api/companies/11111111-1111-4111-8111-111111111111/pause', {
      secFetchSite: 'cross-site',
      origin: 'https://evil.test',
    });
    expect(response?.status).toBe(403);
    // The ordering claim from CDR-081 §2: refused BEFORE any session is established, so a forgery costs no
    // Clerk round trip and reaches no handler. A gate placed after `clerkMiddleware()` would still refuse
    // the request but would fail this line.
    expect(sessionCalls).toEqual([]);
  });

  test('the denial body is the coarse, oracle-free `forbidden` — it names no reason', async () => {
    const response = await run('/api/companies', { secFetchSite: 'cross-site' });
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({ error: 'forbidden' });
    // The reason code exists for the gate's own tests and for an operator, never for the caller: telling a
    // forger which row refused them is an oracle. Assert the body carries nothing else at all.
    const body = (await (await run('/api/companies', { secFetchSite: 'cross-site' }))?.json()) as object;
    expect(Object.keys(body)).toEqual(['error']);
  });

  test('every state-changing method is gated, not just POST', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await run('/api/account/profile', { method, secFetchSite: 'cross-site' });
      expect(response?.status, `${method} must be gated`).toBe(403);
    }
    expect(sessionCalls).toEqual([]);
  });

  test('a state-changing request with NO provenance headers is refused', async () => {
    // The fail-closed core, at the boundary rather than in the pure function. A non-browser client sends
    // neither header; CDR-081 §7.2 records that denying it is correct today and owns the consequence.
    const response = await run('/api/companies/11111111-1111-4111-8111-111111111111/memory');
    expect(response?.status).toBe(403);
    expect(sessionCalls).toEqual([]);
  });

  test('a same-SITE request from a sibling subdomain is refused', async () => {
    const response = await run('/api/companies', { secFetchSite: 'same-site', origin: 'https://blog.example.test' });
    expect(response?.status).toBe(403);
    expect(sessionCalls).toEqual([]);
  });
});

describe('legitimate traffic is untouched', () => {
  test('a same-origin POST reaches the session middleware', async () => {
    const response = await run('/api/companies', { secFetchSite: 'same-origin', origin: APP_ORIGIN });
    expect(response?.status).toBe(204);
    expect(sessionCalls).toEqual(['POST /api/companies']);
  });

  test('a POST from a browser sending only Origin reaches the session middleware', async () => {
    const response = await run('/api/companies', { origin: APP_ORIGIN });
    expect(response?.status).toBe(204);
    expect(sessionCalls).toEqual(['POST /api/companies']);
  });

  test('a GET with no provenance headers at all reaches the session middleware', async () => {
    // Six route modules are GET-only and every page load is a GET. A gate that touched safe methods would
    // break the whole application, which is a different failure from the one this ticket is preventing.
    const response = await run('/api/companies/11111111-1111-4111-8111-111111111111/activity', { method: 'GET' });
    expect(response?.status).toBe(204);
    expect(sessionCalls).toEqual(['GET /api/companies/11111111-1111-4111-8111-111111111111/activity']);
  });

  test('a page navigation is not gated', async () => {
    const response = await run('/sign-in', { method: 'GET' });
    expect(response?.status).toBe(204);
    expect(sessionCalls).toEqual(['GET /sign-in']);
  });
});

describe('the Clerk webhook bypass survives the gate (CDR-081 §2, ordering step 1)', () => {
  test('a signed webhook POST with NEITHER provenance header passes straight through', async () => {
    // THE REGRESSION THIS PINS. Clerk's servers send no Origin and no Sec-Fetch-Site, so a gate evaluated
    // before the bypass — or a bypass accidentally moved below it — would deny every authentic webhook by
    // the no-provenance row, silently breaking identity ingestion. The route is authenticated by signature
    // verification in its handler (ACBP-P1-002 slice 3) and needs no session, so `undefined` is correct.
    const response = await run('/api/webhooks/clerk');
    expect(response).toBeUndefined();
    expect(sessionCalls).toEqual([]);
  });

  test('the bypass is EXACT — a neighbouring path under /api/webhooks is still gated', async () => {
    const response = await run('/api/webhooks/clerk/extra');
    expect(response?.status).toBe(403);
    expect(sessionCalls).toEqual([]);
  });
});

describe('the matcher still covers what the gate is claimed to cover', () => {
  test('config.matcher includes the API catch-all', () => {
    // Blanket enforcement is only blanket while the matcher runs the proxy for /api. This is asserted here
    // AND statically in tools/check-csrf-origin-gate.mjs, because a matcher edit is a config change far
    // from any security-looking file and would leave every route uncovered with this suite still green.
    expect(config.matcher).toContain('/(api|trpc)(.*)');
  });
});
