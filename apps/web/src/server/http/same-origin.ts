// ACBP-P7-014 / CDR-081 — the same-origin gate: CSRF protection for apps/web (NFR-010's ASVS baseline).
//
// WHAT THIS DEFENDS. The 16 state-changing route modules under src/app/api authenticate through
// `resolveVerifiedIdentity` -> `auth()`, which reads Clerk's `__session` cookie. A cookie is an AMBIENT
// credential: the browser attaches it to a cross-site request without the page that caused the request
// having any access to it. So a page the user never trusted can cause a state change they never asked for.
// `POST /api/companies/{id}/pause` is the clearest case in this codebase — it reads no body and no header
// beyond the cookie, so nothing else in the request could refuse it.
//
// WHY THIS AND NOT A TOKEN (CDR-081 §1). A synchronizer/double-submit token has to be issued to a document
// and echoed by the client. This repository has NO rendered UI, so a token would ship with no producer of a
// valid token anywhere in production — the "reachable but unwired" shape this repository has been bitten by
// three times (ACBP-P6-010's caps, ACBP-P6-011's usage key, ACBP-P7-002's zero-caller predicate). The two
// headers read here are FORBIDDEN HEADER NAMES: page script can neither set nor remove them, and the
// browser computes them against the real request target.
//
// THE FUNCTION IS PURE AND TOTAL. Every input maps to exactly one verdict from a closed vocabulary, and the
// default in every branch is DENY. It performs no I/O so it can be exhausted by a table rather than sampled
// — same-origin.test.ts asserts on the REASON, not just allow/deny, so a row that stops denying cannot pass
// by coincidence. Enforcement lives in src/proxy.ts, which is the only caller.

/** RFC 9110 safe methods. An ALLOWLIST: an unrecognised verb is unsafe, never waved through. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Closed vocabulary. The reason is part of the decision — the tests and the operator both read it. */
export type OriginVerdict =
  | { readonly kind: 'allow'; readonly reason: 'safe_method' | 'sec_fetch_same_origin' | 'origin_allowed' }
  | {
      readonly kind: 'deny';
      readonly reason:
        | 'sec_fetch_same_site'
        | 'sec_fetch_cross_site'
        | 'sec_fetch_none'
        | 'sec_fetch_unrecognised'
        | 'origin_mismatch'
        | 'no_provenance';
    };

/** The neutral slice of a request this gate reads. No Next types, no Headers instance, no cookies. */
export interface OriginGateRequest {
  readonly method: string;
  readonly secFetchSite: string | null;
  readonly origin: string | null;
}

/**
 * Reduce a URL or origin to a canonical `scheme://host[:port]`, or null when it cannot be one.
 *
 * Null (not a string) for anything unusable, and that matters more than it looks: `new URL('file:///x')
 * .origin` is the STRING "null" in Node, and the literal `null` is what a browser sends for an opaque
 * origin (sandboxed iframe, `file://` page, some redirect chains). Returning either would put a MATCHABLE
 * value into the comparison, so an allowlist that ever contained "null" would admit every opaque origin.
 * Restricting to http/https is what makes that impossible rather than merely unlikely.
 */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // `URL.origin` already lowercases scheme + host and drops a default port; path/query/fragment never
  // appear in it, so an APP_PUBLIC_URL carrying one still yields the bare origin.
  const origin = url.origin;
  return origin === 'null' || origin === '' ? null : origin;
}

/**
 * The allowed origin set, from APP_PUBLIC_URL.
 *
 * Read as ONE environment variable rather than through `parseWebServerConfig`, deliberately (CDR-081 §1.2):
 * the full parser throws on any incomplete web env, and a throw inside the request-interception boundary is
 * a 500 on every request — including the safe ones this gate does not even evaluate.
 *
 * An absent or unusable value yields an EMPTY set, never a permissive default. `decideSameOrigin` then
 * denies the Origin rows while `Sec-Fetch-Site: same-origin` still admits a modern browser, so a
 * misconfigured deployment degrades toward refusing state-changing requests and never toward accepting
 * them. Both halves of that sentence are asserted in the suite.
 */
export function allowedOriginsFromEnv(env: Record<string, string | undefined>): readonly string[] {
  const origin = normalizeOrigin(env['APP_PUBLIC_URL']);
  return origin === null ? [] : [origin];
}

/**
 * Decide whether a request carries proof it came from an allowed origin. CDR-081 §1.1, in order.
 *
 * `Sec-Fetch-Site` is consulted FIRST AND EXCLUSIVELY when present, and that ordering is the security
 * property rather than a preference: the browser computes it against the actual target, so if a request
 * ever carried both a spoof-shaped Origin and an honest `cross-site` marker, consulting Origin second would
 * let the weaker signal win.
 *
 * `allowedOrigins` entries must ALREADY be canonical (`normalizeOrigin` output): the comparison is exact
 * equality, so `'https://app.example.test/'` with a trailing slash would never match a real Origin header.
 * The only production caller is `allowedOriginsFromEnv`, which normalizes. Exact equality is the point —
 * a prefix or substring comparison is defeated by `https://app.example.test.evil.test`, which is mutation
 * M5 in `tools/probes/p7-014-csrf-origin-gate.probe.mjs`.
 */
export function decideSameOrigin(request: OriginGateRequest, allowedOrigins: readonly string[]): OriginVerdict {
  // Uppercasing WIDENS the safe set (HTTP methods are case-sensitive, so `get` is not `GET`), and that is
  // deliberate rather than sloppy. It can only ever admit lowercase spellings of GET/HEAD/OPTIONS — an
  // unsafe verb in any casing still misses the allowlist and falls through to the provenance rows — and
  // Next dispatches `get` to nothing, so a request that gains `safe_method` this way reaches a 405 instead
  // of a handler. Normalizing costs nothing and avoids a gate whose verdict depends on header casing.
  if (SAFE_METHODS.has(request.method.trim().toUpperCase())) {
    return { kind: 'allow', reason: 'safe_method' };
  }

  const site = typeof request.secFetchSite === 'string' ? request.secFetchSite.trim().toLowerCase() : '';
  if (site !== '') {
    switch (site) {
      case 'same-origin':
        return { kind: 'allow', reason: 'sec_fetch_same_origin' };
      case 'same-site':
        // A site is eTLD+1; an origin is scheme+host+port. A sibling subdomain is a different security
        // principal, and site-scoped cookie semantics are exactly the gap this gate must not inherit.
        return { kind: 'deny', reason: 'sec_fetch_same_site' };
      case 'cross-site':
        return { kind: 'deny', reason: 'sec_fetch_cross_site' };
      case 'none':
        // User-initiated with no page context (typed URL, bookmark). A browser cannot produce a
        // state-changing request that way, so on an unsafe method it is anomalous.
        return { kind: 'deny', reason: 'sec_fetch_none' };
      default:
        // The vocabulary is CLOSED. A value this build has never seen is not evidence of same-origin, and
        // an `allow` default here would turn any future browser token into a bypass.
        return { kind: 'deny', reason: 'sec_fetch_unrecognised' };
    }
  }

  const origin = normalizeOrigin(request.origin);
  // ABSENCE OF PROVENANCE IS NEVER PERMISSION. This is the row that makes the gate a control rather than a
  // filter, and the row a later "make curl work" change would delete. See CDR-081 §7.2 before touching it.
  if (origin === null) return { kind: 'deny', reason: 'no_provenance' };
  return allowedOrigins.includes(origin)
    ? { kind: 'allow', reason: 'origin_allowed' }
    : { kind: 'deny', reason: 'origin_mismatch' };
}
