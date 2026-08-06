// ACBP-P7-015 — every browser-facing response leaves the middleware boundary carrying the security headers.
//
// WHY THIS FILE EXISTS. NFR-010 asks for ASVS-aligned controls. `apps/web` sent NO security header of any kind:
// no CSP, no HSTS, no X-Content-Type-Options, no Referrer-Policy, no frame protection. ACBP-P7-007 found it and
// filed it (CDR-080 §4); CDR-083 is the decision record and this is its evidence.
//
// EXTENDS THE ACBP-P7-007 HARNESS. `secret-egress.test.ts` already discovers every route module and drives it
// with no database. Its walk, method list and dynamic-segment table now live in `route-inventory.ts` and are
// shared, so "every route in this app" has exactly one definition and cannot drift between the two sweeps.
//
// WHAT IS REAL HERE AND WHAT IS NOT — stated because the difference is the whole value of the file.
//   REAL: the exported `proxy` from `src/proxy.ts`, the real `failClosed` wrapper, and the REAL `clerkMiddleware`
//         with its real CSP generator. `@clerk/nextjs/server` is NOT mocked. Clerk's request authentication
//         reaches no network for a request carrying no session token, so this suite runs offline and needs no
//         database — verified, not assumed: it passes with PostgreSQL down.
//   NOT REAL: this drives the middleware function in-process. It is not an HTTP request to a running server, so
//         it does NOT prove Next's `matcher` config routes these paths through the proxy at runtime. CI never
//         runs `next build`/`next start`, so nothing in this repository can prove that today (CDR-083 §2.2).
import { describe, test, expect, beforeAll } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import type { NextFetchEvent, NextMiddleware } from 'next/server';
import { CLERK_WEBHOOK_PATH } from '../webhooks/route-path.js';
import { SECURITY_HEADERS, missingSecurityHeaders } from '../http/security-headers.js';
import {
  APP_ROOT,
  discoverPageFiles,
  discoverRouteFiles,
  pagePathFor,
  routePathFor,
} from './route-inventory.js';

// Synthetic, never real. The publishable key must DECODE, because Clerk derives the Frontend API host from it
// and puts that host in `connect-src`: a malformed key would make the generator emit a policy shaped unlike the
// production one, and this suite would assert against a fiction. Format is `pk_test_` + base64("<host>$").
const FRONTEND_API_HOST = 'clerk.adversarial-headers.test';
const PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${FRONTEND_API_HOST}$`).toString('base64')}`;
const SECRET_KEY = 'sk_test_headers_sweep_never_a_real_key';

let proxy: NextMiddleware;

/** A NextFetchEvent stand-in. `proxy` only forwards it; nothing under test reads it. */
const event = { waitUntil: () => undefined } as unknown as NextFetchEvent;

async function driveProxy(pathname: string): Promise<Response | undefined> {
  const result = await proxy(new NextRequest(`https://example.test${pathname}`), event);
  return result ?? undefined;
}

/** Every request path this app serves: one per route module, one per page. Read from disk on every call. */
const ALL_PATHS = (): string[] =>
  [...discoverRouteFiles().map(routePathFor), ...discoverPageFiles().map(pagePathFor)].sort();

beforeAll(async () => {
  // Set BEFORE `@/proxy` is imported: Clerk reads its keys into module constants at import time, and
  // `clerkMiddleware()` is invoked at proxy.ts module scope. Values set afterwards would never be read.
  process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] = PUBLISHABLE_KEY;
  process.env['CLERK_SECRET_KEY'] = SECRET_KEY;
  // No outbound telemetry from a test run.
  process.env['CLERK_TELEMETRY_DISABLED'] = '1';
  ({ default: proxy } = (await import('@/proxy')) as { default: NextMiddleware });
});

describe('ACBP-P7-015 — security headers on every browser-facing response (CDR-083)', () => {
  // ── THE ANTI-VACUITY CONTROLS ────────────────────────────────────────────────────────────────────────────────
  // Without these, every assertion below could pass because the detector is broken rather than because the
  // product is sound. ACBP-P7-007 §0.1 found two assertions in this repository that were unconditionally true.
  test('CONTROL: the detector NAMES every header missing from an untreated response', () => {
    const bare = new Response('untreated', { status: 200 });
    expect([...missingSecurityHeaders(bare.headers)].sort()).toEqual(SECURITY_HEADERS.map(([n]) => n).sort());
  });

  test('CONTROL: the proxy is the thing under test — an untreated response FAILS the same assertion', () => {
    // Pins that "missingSecurityHeaders(...) toEqual []" is a claim about the proxy's output and not a tautology
    // that any Response would satisfy.
    expect(missingSecurityHeaders(new Response(null).headers)).not.toEqual([]);
  });

  // ── THE SWEEP ────────────────────────────────────────────────────────────────────────────────────────────────
  test('every route module path answers WITH the full header set', async () => {
    const files = discoverRouteFiles();
    expect(files.length, 'no route modules discovered — the walk is broken, not the tree').toBeGreaterThan(0);

    const offenders: string[] = [];
    const exercised: string[] = [];

    for (const file of files) {
      const pathname = routePathFor(file);
      if (pathname === CLERK_WEBHOOK_PATH) continue; // the pinned exception; asserted on its own below
      exercised.push(file);

      const res = await driveProxy(pathname);
      if (res === undefined) {
        offenders.push(`${file} → proxy returned no response`);
        continue;
      }
      const missing = missingSecurityHeaders(res.headers);
      if (missing.length > 0) offenders.push(`${file} → ${res.status} missing: ${missing.join(', ')}`);
    }

    expect(exercised.length, 'no paths were driven — the sweep proved nothing').toBeGreaterThan(0);
    expect(offenders, 'a route left the middleware boundary without its security headers').toEqual([]);
  });

  test('every PAGE path answers with the full header set', async () => {
    // The HTML surfaces are where scripts execute, so they are the ones a CSP is for. A sweep of route handlers
    // alone would exclude exactly the pages that matter most.
    const pages = discoverPageFiles();
    expect(pages.length, 'no pages discovered — the walk is broken, not the tree').toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of pages) {
      const res = await driveProxy(pagePathFor(file));
      if (res === undefined) {
        offenders.push(`${file} → proxy returned no response`);
        continue;
      }
      const missing = missingSecurityHeaders(res.headers);
      if (missing.length > 0) offenders.push(`${file} → missing: ${missing.join(', ')}`);
    }
    expect(offenders, 'a page left the middleware boundary without its security headers').toEqual([]);
  });

  test('the 401 the boundary GENERATES ITSELF carries the headers', async () => {
    // THE CASE `next.config.ts` headers() COULD NEVER HAVE COVERED (CDR-083 §2.4). `failClosed` builds this
    // response inside the middleware, so the request never reaches the routing layer that applies configured
    // headers. It is driven through the REAL proxy by a real malformed credential — a token Clerk cannot parse —
    // rather than by calling failClosed directly, because calling the helper would prove the helper works and
    // say nothing about whether the boundary wraps it.
    const denied = await proxy(
      new NextRequest('https://example.test/api/companies', { headers: { authorization: 'Bearer aaa.bbb.ccc' } }),
      event,
    );

    expect(denied?.status, 'the malformed credential no longer reaches failClosed; this test now proves nothing').toBe(401);
    expect(await (denied as Response).clone().text()).toBe('{"error":"unauthenticated"}');
    expect(missingSecurityHeaders((denied as Response).headers)).toEqual([]);
  });

  // ── THE PINNED EXCEPTIONS ────────────────────────────────────────────────────────────────────────────────────
  // Both are CDR-083 decisions. An assertion is what stops a decision decaying into a forgotten omission.
  test('EXCEPTION: the Clerk webhook path is bypassed entirely, and is the ONLY path that is', async () => {
    // proxy.ts returns undefined for exactly this route so a stray cookie can never 401 an authentic signed
    // webhook (ACBP-P1-002 slice 3). It is machine-to-machine: no browser, no HTML, no script execution, so
    // every header in the set is inert on it. Not worth editing a proven auth-bypass path to gain nothing.
    expect(await driveProxy(CLERK_WEBHOOK_PATH)).toBeUndefined();

    const actuallyBypassed: string[] = [];
    for (const pathname of ALL_PATHS()) {
      if ((await driveProxy(pathname)) === undefined) actuallyBypassed.push(pathname);
    }
    expect(actuallyBypassed).toEqual([CLERK_WEBHOOK_PATH]);
  });

  test('EXCEPTION: HSTS, COEP and COOP are absent from EVERY response, deliberately', async () => {
    // HSTS — CDR-083 §4: no TLS termination exists in this repository (no Dockerfile, platform manifest, proxy
    // config or infrastructure directory), so max-age/includeSubDomains/preload cannot be justified and
    // `preload` is effectively irreversible. ACBP-P7-006 (staging) owns the first environment that can carry TLS.
    // COEP — CDR-083 §5: it requires every cross-origin subresource to opt in via CORP/CORS, and Clerk's
    // scripts, img.clerk.com images and Turnstile frames do not. Enabling it breaks sign-in outright.
    // COOP — CDR-083 §6.2: this WAS shipped as `same-origin-allow-popups` and was REMOVED under review. The
    // justification ("Clerk's OAuth opens a popup") could not be established in this repository — @clerk/clerk-js
    // is not installed, no social provider is configured, and no browser runs here — and the analysis that
    // followed pointed the other way: a popup navigating from the provider (COOP `unsafe-none`) to a callback
    // page carrying `same-origin-allow-popups` triggers a browsing-context-group switch and nulls
    // `window.opener`, which is the very failure the header was claimed to avoid. COOP is ENFORCING, so unlike
    // the report-only CSP it cannot be observed-then-fixed. Shipping an unverifiable enforcing control is the
    // defect class this ticket's parent exists to find.
    //
    // Swept over every path rather than sampled: "absent from every response" is the claim, so one path would
    // not be evidence for it.
    const offenders: string[] = [];
    for (const pathname of ALL_PATHS()) {
      const res = await driveProxy(pathname);
      if (res === undefined) continue; // the webhook bypass, asserted on its own above
      for (const header of [
        'strict-transport-security',
        'cross-origin-embedder-policy',
        'cross-origin-opener-policy',
      ]) {
        if (res.headers.get(header) !== null) offenders.push(`${pathname} → ${header}`);
      }
    }
    expect(offenders, 'a header this ticket deliberately does NOT ship is being sent').toEqual([]);
  });

  // ── THE CONTENT SECURITY POLICY, from the REAL Clerk generator ───────────────────────────────────────────────
  test('the CSP is emitted REPORT-ONLY, and the enforcing header is absent', async () => {
    const res = await driveProxy('/');
    expect(res?.headers.get('content-security-policy-report-only')).toBeTruthy();
    expect(
      res?.headers.get('content-security-policy'),
      'the enforcing header would revert on the first broken sign-in; CDR-083 §3.1',
    ).toBeNull();
  });

  test('the CSP carries the three directives Clerk’s defaults leave UNSET, plus form-action', async () => {
    // frame-ancestors and base-uri do not fall back to default-src, so absent means unrestricted; object-src
    // falls back to `default-src 'self'`, which still permits same-origin plugin content. CDR-083 §3(b), §6.1.
    const csp = (await driveProxy('/'))?.headers.get('content-security-policy-report-only') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  test('script-src is STRICT: nonce + strict-dynamic, and no blanket https:/http:', async () => {
    // THE FINDING THIS ASSERTION EXISTS FOR. Clerk's NON-strict default script-src is
    // `'self' 'unsafe-inline' https: http:` — a policy permitting any script over http or https and any inline
    // script. Shipping it would install a header that looks like a control and is not. CDR-083 §3(a).
    const csp = (await driveProxy('/'))?.headers.get('content-security-policy-report-only') ?? '';
    const scriptSrc = /(?:^|;\s*)script-src ([^;]*)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc, 'no script-src directive in the emitted policy').not.toBe('');
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(scriptSrc.split(/\s+/)).not.toContain('https:');
    expect(scriptSrc.split(/\s+/)).not.toContain('http:');
  });

  test('a per-request nonce is issued, and it is DIFFERENT on every request', async () => {
    // A reused nonce is not a nonce. Two drives, two values.
    const first = await driveProxy('/');
    const second = await driveProxy('/');
    const nonceOf = (res: Response | undefined): string =>
      /'nonce-([A-Za-z0-9+/=]+)'/.exec(res?.headers.get('content-security-policy-report-only') ?? '')?.[1] ?? '';
    expect(nonceOf(first)).not.toBe('');
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    expect(first?.headers.get('x-nonce')).toBe(nonceOf(first));
  });

  test('the Clerk Frontend API host reaches connect-src — the policy is derived, not hard-coded', async () => {
    const csp = (await driveProxy('/'))?.headers.get('content-security-policy-report-only') ?? '';
    expect(csp).toContain(FRONTEND_API_HOST);
  });

  // ── THE SOURCE GUARD ─────────────────────────────────────────────────────────────────────────────────────────
  // The sweep can only cover what it discovered, so discovery is what needs pinning. A new route or page that
  // this suite does not drive must FAIL the build rather than ship unproven.
  test('SOURCE GUARD: discovery finds every routable file on disk — checked against a SECOND, independent walk', () => {
    // THE FIRST VERSION OF THIS TEST GUARDED NOTHING, and both independent reviewers said so. It compared the
    // swept set against `ALL_PATHS()` — but the swept set was BUILT from `ALL_PATHS()`, so the two sides could
    // not disagree about discovery. If `discoverPageFiles()` silently returned two of three pages, both sides
    // shrank together and it stayed green. What follows is the anchor that fixes it, and it is the one
    // `secret-egress.test.ts:210` already had: a walk written separately from the one under test.
    const onDisk: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('_')) walk(join(dir, entry.name));
          continue;
        }
        // Deliberately spelled out rather than imported: sharing the matcher with the code under test would
        // reintroduce the single point of failure this test exists to remove.
        if (/^(?:route|page)\.(?:[cm]?[jt]s|[jt]sx|mdx)$/.test(entry.name)) {
          onDisk.push(relative(APP_ROOT, join(dir, entry.name)).split(sep).join('/'));
        }
      }
    };
    walk(APP_ROOT);

    const discovered = [...discoverRouteFiles(), ...discoverPageFiles()].sort();
    expect(discovered, 'discovery and the tree disagree — one of them stopped seeing a routable file').toEqual(
      onDisk.sort(),
    );
    expect(discovered.length, 'the app tree emptied — the sweep would then prove nothing').toBeGreaterThanOrEqual(26);
  });

  test('SOURCE GUARD: every discovered surface was actually driven and asserted', async () => {
    // The companion property: discovery being correct buys nothing if a discovered path is never exercised.
    // Adding a route or page puts its path in `expected` automatically; if the boundary does not header it,
    // `covered` no longer matches and the build goes red.
    const expected = ALL_PATHS();

    const covered: string[] = [];
    for (const pathname of expected) {
      const res = await driveProxy(pathname);
      const ok =
        pathname === CLERK_WEBHOOK_PATH
          ? res === undefined
          : res !== undefined && missingSecurityHeaders(res.headers).length === 0;
      if (ok) covered.push(pathname);
    }
    expect(covered.sort()).toEqual(expected);
  });
});
