// ACBP-P7-015 — the security response-header policy (CDR-083 §6).
//
// NFR-010 asks for "OWASP ASVS-aligned controls". Before this file, `apps/web` sent no security header of any
// kind: no CSP, no HSTS, no X-Content-Type-Options, no Referrer-Policy, no frame protection. ACBP-P7-007 found
// that and — under the owner ruling in CDR-080 §4 — filed it rather than building it inside a test pass.
//
// PROVIDER-NEUTRAL AND PURE ON PURPOSE. Nothing here imports Clerk or Next. It operates on the Web `Response`
// and `Headers` types, so the values are testable without a server, a browser or a provider, and `proxy.ts`
// stays the only place that knows about the middleware stack.
//
// WHERE THIS IS APPLIED, AND WHAT THAT DOES NOT COVER — `src/proxy.ts`, on every response the middleware
// returns. Two exclusions, both deliberate and both asserted in `../adversarial/security-headers.test.ts`:
//   1. Static assets. The proxy matcher excludes `_next` and file extensions. `apps/web/public` does not
//      exist, so the only static output is Next's own build artefacts.
//   2. The Clerk webhook route, which `proxy.ts` bypasses entirely so a stray cookie can never 401 an
//      authentic signed webhook (ACBP-P1-002 slice 3). It is machine-to-machine: no browser, no HTML, no
//      script execution, so every header below is inert on it.
// `next.config.ts` `headers()` was the other candidate and was rejected because NOTHING IN THIS REPOSITORY CAN
// OBSERVE IT — CI never runs `next build` or `next start`, so its only possible evidence is a config-shape
// assertion that would stay green through a typo'd header name. CDR-083 §2.

/**
 * The header set, with the exact values CDR-083 §6 justifies. Lower-case names, because that is how they are
 * compared; HTTP header names are case-insensitive and `Headers` normalises them anyway.
 */
export const SECURITY_HEADERS: ReadonlyArray<readonly [name: string, value: string]> = [
  // Stops MIME sniffing turning a JSON error body into executable script.
  ['x-content-type-options', 'nosniff'],
  // LOAD-BEARING FOR TENANCY: company identifiers sit in URL paths (/api/companies/{companyId}/...).
  // `strict-origin-when-cross-origin` — the modern browser default — still leaks the origin. This leaks nothing,
  // and no integration in this app reads `Referer`.
  //
  // IT ALSO CONSTRAINS THE NOT-YET-FILED CSRF TICKET, which is why that is written down here rather than
  // discovered later. Per the Fetch standard's "append a request Origin header", a `no-referrer` policy sets the
  // serialized origin to `null` for any non-GET/HEAD request whose mode is not `cors` — i.e. HTML
  // `<form method="post">` submissions. Clerk's own calls are mode `cors` and still send a real Origin, so
  // nothing breaks today, but an Origin-header CSRF check would see `null` from a legitimate same-origin form
  // AND from an attacker's cross-origin form, and could not tell them apart. CDR-083 §6, §8.
  ['referrer-policy', 'no-referrer'],
  // The clickjacking control that is actually ENFORCED. Its CSP equivalent, `frame-ancestors 'none'`, is present
  // in the policy below but a report-only policy enforces nothing — so while the CSP stays report-only, this is
  // what stops the framing.
  ['x-frame-options', 'DENY'],
  // Blocks a cross-origin page embedding this app's authenticated responses as an image or script. Nothing here
  // is meant to be embedded. (Its partner COEP is deliberately absent: it would require every Clerk
  // subresource — scripts, img.clerk.com, Turnstile frames — to opt in via CORP/CORS, and they do not.)
  //
  // NOTE ON COEP's OTHER SIBLING: `Cross-Origin-Opener-Policy` is NOT here either, and that is a decision with
  // an argument behind it rather than an oversight — see CDR-083 §6.2, and the assertion that pins its absence
  // in `../adversarial/security-headers.test.ts`. Short version: COOP is ENFORCING, its failure mode is a
  // sign-in that hangs, and whether this app needs the popup carve-out cannot be established in this
  // repository — `@clerk/clerk-js` is not installed, no social provider is configured, and no browser runs here.
  ['cross-origin-resource-policy', 'same-origin'],
  // DELIBERATELY SHORT. A blanket deny-list eventually catches `publickey-credentials-get`/`-create`, which
  // Clerk needs for passkeys — a header that silently disables a sign-in factor is the same class of defect as a
  // policy that only looks like a control. These three are provably unused by this product and by Clerk's flows.
  ['permissions-policy', 'camera=(), microphone=(), geolocation=()'],
];

/**
 * Options handed to `clerkMiddleware({ contentSecurityPolicy })`. Declared structurally rather than by importing
 * Clerk's type, so this module stays provider-neutral.
 *
 * WHAT MAKES A CLERK OPTION RENAME FAIL THE BUILD IS THE CALL SITE, NOT THIS TYPE. Every field on Clerk's
 * `ContentSecurityPolicyOptions` is OPTIONAL, so handing Clerk this whole object as a variable would typecheck
 * even if Clerk deleted `reportOnly` outright — the enforcing CSP would then ship in silence. `proxy.ts`
 * therefore spreads the fields into an OBJECT LITERAL, where TypeScript's excess-property check does fire.
 * That is the enforcer; naming it here so nobody has to re-derive which line is load-bearing.
 */
export interface ContentSecurityPolicyOptions {
  /** `strict-dynamic` + a per-request nonce in `script-src`, and `https:`/`http:` removed from it. */
  strict: boolean;
  /** Emit `Content-Security-Policy-Report-Only` instead of the enforcing header. */
  reportOnly: boolean;
  /** Merged into Clerk's own directive set. */
  directives: Record<string, string[]>;
}

/**
 * The Content Security Policy, generated by Clerk (which knows its own hosts) and adjusted here.
 *
 * `strict: true` IS NOT AN ENHANCEMENT — it is the difference between a policy and a decoration. Clerk's
 * non-strict default `script-src` is `'self' 'unsafe-inline' https: http:` (plus `'unsafe-eval'` off
 * production), which permits any script over http or https and any inline script. Strict deletes `https:` and
 * `http:` and adds `'strict-dynamic'` plus a fresh nonce. `'unsafe-inline'` stays in the list and that is
 * correct: CSP Level 3 requires browsers to ignore it when a nonce or `'strict-dynamic'` is present.
 *
 * `reportOnly: true` because a CSP that breaks sign-in gets reverted within a day, so it does not get to be
 * enforcing on its first commit. The nonce still reaches Next's own scripts in this mode — verified, not
 * assumed: `next/dist/server/app-render/app-render.js` reads
 * `headers['content-security-policy'] || headers['content-security-policy-report-only']`, and Clerk forwards
 * its generated header onto the request as well as the response.
 *
 * NO `reportTo`, because no reporting endpoint exists. Violations surface in the browser console only. The true
 * sentence is "the policy is published and not enforced" — NOT "we are collecting CSP reports". CDR-083 §3.1.
 */
export const CONTENT_SECURITY_POLICY: ContentSecurityPolicyOptions = {
  strict: true,
  reportOnly: true,
  directives: {
    // The next three are absent from Clerk's default directive set. `frame-ancestors` and `base-uri` do not
    // fall back to `default-src`, so absent means UNRESTRICTED; `object-src` falls back to `default-src 'self'`,
    // which still permits same-origin plugin content.
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    // Already `'self'` in Clerk's defaults. Restated so that a Clerk default change shows up as a diff here
    // rather than as a silent widening of where this app's forms may post.
    'form-action': ["'self'"],
  },
};

/**
 * Names of the §6 headers that are missing from `headers`, or present with a value other than the §6 one.
 *
 * Presence is not the claim — the value is. A detector that only checked existence would pass a response
 * carrying `x-frame-options: ALLOWALL`.
 */
export function missingSecurityHeaders(headers: Headers): string[] {
  return SECURITY_HEADERS.filter(([name, value]) => headers.get(name) !== value).map(([name]) => name);
}

/**
 * Sets every §6 header on `response` and returns it.
 *
 * AUTHORITATIVE, NOT ADVISORY: it overwrites, so a handler further down the stack cannot downgrade the boundary
 * policy by setting a weaker `referrer-policy` of its own.
 *
 * Returns the SAME instance for the responses this app actually produces. Every `NextResponse` factory Clerk and
 * `failClosed` use — `next()`, `json()`, `redirect()` — yields mutable headers, so the copy below does not run
 * on any path in this app. It exists because this function's parameter is the Web `Response` type, and
 * `Response.redirect()` (and any response returned by `fetch`) carries an immutable header guard whose `set()`
 * throws. A general helper that throws on a standard input of its own declared type is a defect regardless of
 * who calls it today.
 */
export function applySecurityHeaders(response: Response): Response {
  try {
    for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
    return response;
  } catch {
    // Immutable header guard. Rebuild, preserving status, body and every existing header. `new Headers(...)`
    // keeps repeated `set-cookie` entries distinct rather than comma-joining them, which matters because the
    // session cookie travels this way.
    const headers = new Headers(response.headers);
    for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
