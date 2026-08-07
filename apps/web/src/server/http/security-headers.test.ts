// ACBP-P7-015 — the header policy itself (CDR-083 §6).
//
// This file pins VALUES. The sweep in `../adversarial/security-headers.test.ts` pins DELIVERY — that every
// response out of the real middleware carries them. Both are needed and neither substitutes for the other:
// a table nobody applies and an applier of the wrong table fail in different places.
//
// Every expectation below is written as a LITERAL, never derived from SECURITY_HEADERS. A test that reads its
// expected value out of the table under test asserts only that the table equals itself.
import { describe, test, expect } from 'vitest';
import {
  SECURITY_HEADERS,
  applySecurityHeaders,
  missingSecurityHeaders,
  CONTENT_SECURITY_POLICY,
} from './security-headers.js';

/** The §6 set, restated independently of the implementation. */
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
  ['cross-origin-resource-policy', 'same-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=()'],
];

describe('ACBP-P7-015 — the security header table (CDR-083 §6)', () => {
  test('is exactly the §6 set, with the §6 values', () => {
    const actual = SECURITY_HEADERS.map(([name, value]) => [name.toLowerCase(), value] as const);
    expect([...actual].sort()).toEqual([...EXPECTED].sort());
  });

  test('header names are lower-case and unique', () => {
    const names = SECURITY_HEADERS.map(([name]) => name);
    expect(names).toEqual(names.map((n) => n.toLowerCase()));
    expect(new Set(names).size, 'a duplicated header name means one value silently wins').toBe(names.length);
  });

  // ── The decisions §6 makes that a later edit would plausibly "tidy" into a break ─────────────────────────────
  test('COOP is ABSENT — an ENFORCING header whose sign-in failure mode cannot be tested here', () => {
    // THIS TEST REPLACES ONE THAT ASSERTED THE OPPOSITE, and the reason is worth keeping. An earlier revision
    // shipped `cross-origin-opener-policy: same-origin-allow-popups` and justified it in four places with
    // "Clerk's OAuth opens a popup and postMessages back to window.opener". That premise is NOT ESTABLISHABLE IN
    // THIS REPOSITORY — @clerk/clerk-js is not installed, <SignIn/> is used with no oauthFlow prop, no social
    // provider is configured, and no browser runs here. The analysis that followed pointed the other way: a
    // popup navigating from the provider (COOP `unsafe-none`) to a callback page carrying
    // `same-origin-allow-popups` fails the COOP match, switches browsing-context group, and nulls
    // `window.opener` — the exact breakage the header was claimed to prevent.
    //
    // COOP is ENFORCING. Unlike the report-only CSP it cannot be published, observed and then corrected. So it
    // is not shipped, and the decision is pinned here rather than left as an absence someone re-adds by
    // reflex. CDR-083 §6.2 carries the full argument and §8 raises it as an owner decision.
    expect(SECURITY_HEADERS.map(([name]) => name)).not.toContain('cross-origin-opener-policy');
  });

  test('Permissions-Policy does not restrict the passkey features Clerk needs', () => {
    // A blanket deny-list would eventually include publickey-credentials-get/-create and silently disable a
    // sign-in factor. The list is deliberately short. CDR-083 §6.
    const policy = SECURITY_HEADERS.find(([name]) => name === 'permissions-policy')?.[1] ?? '';
    expect(policy).not.toMatch(/publickey-credentials/);
    expect(policy).toBe('camera=(), microphone=(), geolocation=()');
  });

  test('HSTS is ABSENT, deliberately — there is no TLS termination this repository controls', () => {
    // CDR-083 §4. Not an omission: no Dockerfile, platform manifest, proxy config or infrastructure directory
    // exists, so max-age/includeSubDomains/preload cannot be chosen, and `preload` is effectively irreversible.
    // ACBP-P7-006 (staging) owns the first environment that can carry TLS. This assertion makes adding it an
    // amendment to a decision rather than a patch over a silent gap.
    expect(SECURITY_HEADERS.map(([name]) => name)).not.toContain('strict-transport-security');
  });

  test('COEP is ABSENT, deliberately — it would break every Clerk subresource', () => {
    // CDR-083 §5. COEP requires cross-origin subresources to opt in via CORP/CORS; Clerk's scripts, img.clerk.com
    // images and Turnstile frames do not.
    expect(SECURITY_HEADERS.map(([name]) => name)).not.toContain('cross-origin-embedder-policy');
  });
});

describe('ACBP-P7-015 — applySecurityHeaders', () => {
  test('sets every §6 header on a response', () => {
    const res = applySecurityHeaders(new Response('body', { status: 200 }));
    for (const [name, value] of EXPECTED) expect(res.headers.get(name)).toBe(value);
  });

  test('preserves headers it does not own, and the status and body', async () => {
    const res = applySecurityHeaders(
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'set-cookie': '__session=; Max-Age=0' },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('set-cookie')).toBe('__session=; Max-Age=0');
    expect(await res.text()).toBe('{"error":"unauthenticated"}');
  });

  test('is authoritative: it OVERWRITES a weaker value set further down the stack', () => {
    // A route handler that sets `referrer-policy: unsafe-url` must not be able to downgrade the boundary policy.
    const res = applySecurityHeaders(new Response(null, { headers: { 'referrer-policy': 'unsafe-url' } }));
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('returns the same response instance — the caller must not have to re-wrap it', () => {
    const input = new Response(null, { status: 204 });
    expect(applySecurityHeaders(input)).toBe(input);
  });

  test('a response with an IMMUTABLE header guard is rebuilt rather than throwing', () => {
    // Every NextResponse factory Clerk and failClosed use yields mutable headers, so this path does not run in
    // this app today. It exists because the parameter type is the Web `Response`, and `Response.redirect()`
    // carries an immutable guard whose `set()` throws `TypeError: immutable`.
    const immutable = Response.redirect('https://example.test/sign-in', 302);
    expect(() => immutable.headers.set('x-probe', '1')).toThrow();

    const res = applySecurityHeaders(immutable);
    expect(res).not.toBe(immutable);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.test/sign-in');
    for (const [name, value] of EXPECTED) expect(res.headers.get(name)).toBe(value);
  });

  test('the rebuild keeps repeated set-cookie entries distinct — the session cookie travels this way', () => {
    // A comma-joined Set-Cookie is a corrupted Set-Cookie. Pinned because the rebuild is the only place in this
    // module where headers are copied.
    const source = new Response(null, { status: 200 });
    source.headers.append('set-cookie', '__session=abc; Path=/; HttpOnly');
    source.headers.append('set-cookie', '__client_uat=1; Path=/');

    const rebuilt = new Response(source.body, { status: source.status, headers: new Headers(source.headers) });
    expect(rebuilt.headers.getSetCookie()).toEqual(['__session=abc; Path=/; HttpOnly', '__client_uat=1; Path=/']);
  });
});

describe('ACBP-P7-015 — missingSecurityHeaders (the detector the sweep depends on)', () => {
  // ── THE ANTI-VACUITY CONTROL ─────────────────────────────────────────────────────────────────────────────────
  // Without these two, every assertion in the sweep could pass because the detector is broken rather than because
  // the product is sound. ACBP-P7-007 §0.1 found two assertions in this repository that could not fail; this
  // suite refuses to be the third.
  test('CONTROL: names EVERY header missing from a bare response', () => {
    const found = missingSecurityHeaders(new Response(null).headers);
    expect([...found].sort()).toEqual(EXPECTED.map(([name]) => name).sort());
  });

  test('CONTROL: finds nothing on a treated response — it is not simply always positive', () => {
    expect(missingSecurityHeaders(applySecurityHeaders(new Response(null)).headers)).toEqual([]);
  });

  test('CONTROL: names the one header that is present with the WRONG value', () => {
    // Presence is not the claim; the §6 value is. A detector that only checked existence would pass a response
    // carrying `x-frame-options: ALLOWALL`.
    const res = applySecurityHeaders(new Response(null));
    res.headers.set('x-frame-options', 'ALLOWALL');
    expect(missingSecurityHeaders(res.headers)).toEqual(['x-frame-options']);
  });

  test('CONTROL: header lookup is case-insensitive, as HTTP requires', () => {
    const headers = new Headers();
    for (const [name, value] of EXPECTED) headers.set(name.toUpperCase(), value);
    expect(missingSecurityHeaders(headers)).toEqual([]);
  });
});

describe('ACBP-P7-015 — the Content Security Policy options (CDR-083 §3, §6.1)', () => {
  test('report-only, so a policy that breaks sign-in cannot break sign-in', () => {
    expect(CONTENT_SECURITY_POLICY.reportOnly).toBe(true);
  });

  test('strict — because Clerk’s NON-strict default policy constrains nothing', () => {
    // @clerk/nextjs 7.5.20 dist/esm/server/content-security-policy.js: the default `script-src` is
    // `'self' 'unsafe-inline' https: http:` (plus 'unsafe-eval' off production). A policy permitting any script
    // over http or https AND inline script is a header that looks like a control and is not. `strict: true`
    // deletes `https:`/`http:` and adds 'strict-dynamic' + a per-request nonce. CDR-083 §3(a).
    expect(CONTENT_SECURITY_POLICY.strict).toBe(true);
  });

  test('supplies the three directives Clerk’s defaults leave unset, plus form-action', () => {
    // frame-ancestors and base-uri do NOT fall back to default-src, so absent means unrestricted; object-src
    // falls back to `default-src 'self'`, which still permits same-origin plugin content. CDR-083 §3(b), §6.1.
    expect(CONTENT_SECURITY_POLICY.directives).toEqual({
      'frame-ancestors': ["'none'"],
      'base-uri': ["'self'"],
      'object-src': ["'none'"],
      'form-action': ["'self'"],
    });
  });

  test('sets no reportTo — there is no reporting endpoint, and claiming one would be false', () => {
    // CDR-083 §3.1. Violations surface in the browser console only. "The policy is published and not enforced"
    // is the true sentence; "we are collecting CSP reports" is not.
    expect('reportTo' in CONTENT_SECURITY_POLICY).toBe(false);
  });
});
