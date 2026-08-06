// ACBP-P7-013 / CDR-081 §1.1 — the same-origin gate's decision table.
//
// Threat: CSRF against the 16 cookie-authenticated state-changing route modules in apps/web. The
// `__session` cookie is an ambient credential — the browser attaches it to a cross-site request without
// the causing page having any access to it — so a side effect can be triggered by a page the user never
// trusted. See CDR-081 §0 for why no provider control already covers this.
//
// THIS SUITE IS THE CONTROL'S ONLY EXHAUSTIVE ANCHOR. The proxy suite proves the gate is CALLED; this one
// proves what it decides. Every row of CDR-081 §1.1 appears here by its reason code, so a row that quietly
// stops denying cannot pass: the assertion is on the REASON, not merely on allow/deny, and a reason that
// drifts is a different decision even when the verdict happens to match.
import { describe, test, expect } from 'vitest';
import {
  SAFE_METHODS,
  decideSameOrigin,
  normalizeOrigin,
  allowedOriginsFromEnv,
  type OriginGateRequest,
} from './same-origin.js';

const APP = 'https://app.example.test';
const ALLOWED = [APP] as const;

/** A request with no provenance headers at all — every case below adds only what it is about. */
function request(over: Partial<OriginGateRequest> = {}): OriginGateRequest {
  return { method: 'POST', secFetchSite: null, origin: null, ...over };
}

describe('safe methods are never gated (CDR-081 §1.1 row 1)', () => {
  // A gate that refused GET would break every read route; a gate that treated only POST as unsafe would
  // miss PATCH and DELETE, which five route modules use. Both directions are pinned.
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    test(`${method} is allowed with no provenance headers whatsoever`, () => {
      expect(decideSameOrigin(request({ method }), ALLOWED)).toEqual({ kind: 'allow', reason: 'safe_method' });
    });
  }

  test('method matching is case-insensitive, so a lowercased verb is not treated as unsafe', () => {
    expect(decideSameOrigin(request({ method: 'get' }), ALLOWED)).toEqual({ kind: 'allow', reason: 'safe_method' });
  });

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    test(`${method} with no provenance is DENIED — it is not in the safe set`, () => {
      expect(decideSameOrigin(request({ method }), ALLOWED)).toEqual({ kind: 'deny', reason: 'no_provenance' });
    });
  }

  test('an unrecognised verb is treated as unsafe, not waved through', () => {
    // The safe set is an ALLOWLIST. If it were a denylist of known-unsafe verbs, a method nobody listed
    // would bypass the gate entirely.
    expect(decideSameOrigin(request({ method: 'FROB' }), ALLOWED)).toEqual({ kind: 'deny', reason: 'no_provenance' });
  });

  test('the safe set is exactly GET/HEAD/OPTIONS', () => {
    expect([...SAFE_METHODS].sort()).toEqual(['GET', 'HEAD', 'OPTIONS']);
  });
});

describe('Sec-Fetch-Site decides alone when present (CDR-081 §1.1 rows 3-7)', () => {
  test('same-origin is allowed', () => {
    expect(decideSameOrigin(request({ secFetchSite: 'same-origin' }), ALLOWED)).toEqual({
      kind: 'allow',
      reason: 'sec_fetch_same_origin',
    });
  });

  test('cross-site is denied — this is the plain forgery case', () => {
    expect(decideSameOrigin(request({ secFetchSite: 'cross-site' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'sec_fetch_cross_site',
    });
  });

  test('same-site is DENIED: a sibling subdomain is a different origin', () => {
    // The distinction this row exists for. `SameSite` cookie semantics are site-scoped (eTLD+1), so a
    // control inherited from the cookie would admit a sibling subdomain. This gate is origin-scoped.
    expect(decideSameOrigin(request({ secFetchSite: 'same-site' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'sec_fetch_same_site',
    });
  });

  test('none is denied — a browser cannot state-change without a page context', () => {
    expect(decideSameOrigin(request({ secFetchSite: 'none' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'sec_fetch_none',
    });
  });

  test('an unrecognised value is denied, because the vocabulary is CLOSED', () => {
    // A future value this build has never seen is not evidence of same-origin. The failure direction
    // matters: an `default: allow` here would turn any new browser token into a bypass.
    expect(decideSameOrigin(request({ secFetchSite: 'same-planet' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'sec_fetch_unrecognised',
    });
  });

  test('the value is matched case-insensitively and after trimming', () => {
    expect(decideSameOrigin(request({ secFetchSite: '  Same-Origin ' }), ALLOWED)).toEqual({
      kind: 'allow',
      reason: 'sec_fetch_same_origin',
    });
  });

  test('an empty Sec-Fetch-Site falls through to Origin rather than counting as a value', () => {
    expect(decideSameOrigin(request({ secFetchSite: '   ', origin: APP }), ALLOWED)).toEqual({
      kind: 'allow',
      reason: 'origin_allowed',
    });
  });

  test('a cross-site Sec-Fetch-Site OUTRANKS a matching Origin header', () => {
    // The ordering is the security property, not a preference. Sec-Fetch-Site is computed by the browser
    // against the real target; if a request ever carried both a spoof-shaped Origin and an honest
    // cross-site marker, consulting Origin second would let the weaker signal win.
    expect(decideSameOrigin(request({ secFetchSite: 'cross-site', origin: APP }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'sec_fetch_cross_site',
    });
  });
});

describe('Origin is the fallback when Sec-Fetch-Site is absent (CDR-081 §1.1 rows 8-10)', () => {
  test('an exactly matching Origin is allowed', () => {
    expect(decideSameOrigin(request({ origin: APP }), ALLOWED)).toEqual({ kind: 'allow', reason: 'origin_allowed' });
  });

  test('a foreign Origin is denied', () => {
    expect(decideSameOrigin(request({ origin: 'https://evil.example.test' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'origin_mismatch',
    });
  });

  test('an absent Origin is denied — absence of provenance is never permission', () => {
    // THE FAIL-CLOSED CORE (CDR-081 §1.1 row 10). This is the row a later "make curl work" change deletes,
    // and the row without which the gate is a filter rather than a control.
    expect(decideSameOrigin(request(), ALLOWED)).toEqual({ kind: 'deny', reason: 'no_provenance' });
  });

  test('a same-host origin on a DIFFERENT SCHEME is denied', () => {
    expect(decideSameOrigin(request({ origin: 'http://app.example.test' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'origin_mismatch',
    });
  });

  test('a same-host origin on a DIFFERENT PORT is denied', () => {
    expect(decideSameOrigin(request({ origin: 'https://app.example.test:8443' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'origin_mismatch',
    });
  });

  test('a subdomain of the allowed origin is denied', () => {
    expect(decideSameOrigin(request({ origin: 'https://evil.app.example.test' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'origin_mismatch',
    });
  });

  test('an origin that merely has the allowed origin as a PREFIX is denied', () => {
    // Guards against a substring/startsWith comparison, which `https://app.example.test.evil.test` defeats.
    expect(decideSameOrigin(request({ origin: 'https://app.example.test.evil.test' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'origin_mismatch',
    });
  });

  test('the opaque `Origin: null` is treated as no provenance, never as a matchable value', () => {
    // Sandboxed iframes, redirects and `file://` pages send the literal string `null`. If the comparison
    // were string equality over raw header values, an allowlist that ever contained `null` would match it.
    expect(decideSameOrigin(request({ origin: 'null' }), ALLOWED)).toEqual({ kind: 'deny', reason: 'no_provenance' });
    expect(decideSameOrigin(request({ origin: 'null' }), ['null'])).toEqual({ kind: 'deny', reason: 'no_provenance' });
  });

  test('with an EMPTY allowed set, a well-formed Origin is denied (CDR-081 §1.2)', () => {
    // The misconfiguration path: no APP_PUBLIC_URL means no allowed origin, and the degradation must be
    // toward refusing state-changing requests.
    expect(decideSameOrigin(request({ origin: APP }), [])).toEqual({ kind: 'deny', reason: 'origin_mismatch' });
  });

  test('with an EMPTY allowed set, Sec-Fetch-Site still admits a same-origin browser request', () => {
    // Row 3 needs no configuration to be meaningful, so a misconfigured deployment is not a dead app.
    expect(decideSameOrigin(request({ secFetchSite: 'same-origin' }), [])).toEqual({
      kind: 'allow',
      reason: 'sec_fetch_same_origin',
    });
  });

  test('more than one allowed origin is honoured', () => {
    const both = [APP, 'https://admin.example.test'];
    expect(decideSameOrigin(request({ origin: 'https://admin.example.test' }), both)).toEqual({
      kind: 'allow',
      reason: 'origin_allowed',
    });
  });
});

describe('normalizeOrigin', () => {
  test('drops a default port so the configured and header forms compare equal', () => {
    expect(normalizeOrigin('https://app.example.test:443')).toBe('https://app.example.test');
    expect(normalizeOrigin('http://app.example.test:80')).toBe('http://app.example.test');
  });

  test('keeps a non-default port', () => {
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  test('lowercases scheme and host', () => {
    expect(normalizeOrigin('HTTPS://APP.Example.Test')).toBe('https://app.example.test');
  });

  test('strips any path, query or fragment — APP_PUBLIC_URL may carry one', () => {
    expect(normalizeOrigin('https://app.example.test/app?x=1#y')).toBe('https://app.example.test');
    expect(normalizeOrigin('https://app.example.test/')).toBe('https://app.example.test');
  });

  test('refuses non-http(s) schemes', () => {
    // `new URL('file:///x').origin` is the STRING "null" in Node. Returning it would put a matchable
    // value into the allowlist that any opaque origin could equal.
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('data:text/html,x')).toBeNull();
  });

  test('refuses the literal `null`, empty, blank and unparseable values', () => {
    expect(normalizeOrigin('null')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('   ')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });
});

describe('allowedOriginsFromEnv (CDR-081 §1.2)', () => {
  test('reads APP_PUBLIC_URL and returns its normalized origin', () => {
    expect(allowedOriginsFromEnv({ APP_PUBLIC_URL: 'https://app.example.test/' })).toEqual(['https://app.example.test']);
  });

  test('a URL carrying a path still yields the bare origin', () => {
    expect(allowedOriginsFromEnv({ APP_PUBLIC_URL: 'https://app.example.test/dashboard' })).toEqual([
      'https://app.example.test',
    ]);
  });

  test('an absent or unusable APP_PUBLIC_URL yields an EMPTY set, never a permissive default', () => {
    // The whole point: a misconfiguration must not become a wildcard. `decideSameOrigin` then denies
    // rows 8/9, which the two tests above pin.
    expect(allowedOriginsFromEnv({})).toEqual([]);
    expect(allowedOriginsFromEnv({ APP_PUBLIC_URL: '' })).toEqual([]);
    expect(allowedOriginsFromEnv({ APP_PUBLIC_URL: 'not a url' })).toEqual([]);
    expect(allowedOriginsFromEnv({ APP_PUBLIC_URL: 'file:///srv/app' })).toEqual([]);
  });
});

describe('the forgeries this gate exists to refuse', () => {
  // Each case is a real attack shape rather than a synthetic header combination, so a reader can see what
  // the control is for without reconstructing it from the table.

  test('a bodyless cross-site form POST to /api/companies/{id}/pause is refused', () => {
    // The clearest case in the codebase: the pause route reads NO body and NO header but the cookie
    // (route.ts:13), so nothing else in the request could have refused it.
    expect(decideSameOrigin({ method: 'POST', secFetchSite: 'cross-site', origin: 'https://evil.test' }, ALLOWED)).toEqual(
      { kind: 'deny', reason: 'sec_fetch_cross_site' },
    );
  });

  test('the same forgery from a browser too old to send Sec-Fetch-Site is still refused, by Origin', () => {
    expect(decideSameOrigin({ method: 'POST', secFetchSite: null, origin: 'https://evil.test' }, ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'origin_mismatch',
    });
  });

  test('a forgery that STRIPS both headers is refused rather than admitted', () => {
    // `Origin` and `Sec-Fetch-Site` are forbidden header names: page script cannot remove them from a
    // browser-issued request. Refusing this shape means the gate does not depend on that being true.
    expect(decideSameOrigin({ method: 'DELETE', secFetchSite: null, origin: null }, ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'no_provenance',
    });
  });

  test('a compromised sibling subdomain cannot invite itself in', () => {
    expect(
      decideSameOrigin({ method: 'PATCH', secFetchSite: 'same-site', origin: 'https://blog.example.test' }, ALLOWED),
    ).toEqual({ kind: 'deny', reason: 'sec_fetch_same_site' });
  });

  // DUPLICATE HEADERS. `Headers.get()` JOINS repeated same-name headers with ", " — so a request carrying
  // two of either header hands the gate a value no browser would ever produce. A browser cannot send two;
  // a misconfigured or malicious intermediary can. Both must land on deny, and the mechanism is different
  // in each case, so each is asserted rather than assumed from the other.
  test('two Origin headers joined by Headers.get() cannot smuggle the allowed origin past the check', () => {
    // "https://app.example.test, https://evil.test" — an allowlist compared with `includes` on the raw
    // string would reject it anyway, but a comparison that split, trimmed or substring-matched would not.
    // `normalizeOrigin` refuses to parse it at all, so it is treated as no provenance.
    expect(decideSameOrigin(request({ origin: `${APP}, https://evil.test` }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'no_provenance',
    });
    expect(decideSameOrigin(request({ origin: `https://evil.test, ${APP}` }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'no_provenance',
    });
  });

  test('two Sec-Fetch-Site headers joined into one value fall to the closed-vocabulary deny', () => {
    // "same-origin, cross-site" is not a member of the vocabulary, so row 7 refuses it. An implementation
    // that used `includes('same-origin')` instead of equality would allow it.
    expect(decideSameOrigin(request({ secFetchSite: 'same-origin, cross-site' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'sec_fetch_unrecognised',
    });
    expect(decideSameOrigin(request({ secFetchSite: 'cross-site, same-origin' }), ALLOWED)).toEqual({
      kind: 'deny',
      reason: 'sec_fetch_unrecognised',
    });
  });
});
