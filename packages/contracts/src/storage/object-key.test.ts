// @acbp/contracts — object-key safety tests (ACBP-P0-005; CDR-048 §3; ADR-016 "prefix-scoped generation, tested").
//
// These are the tests the whole ticket exists for. The owner's decision says cross-tenant access must be
// "structurally impossible, not just policy", and CDR-048 §3 names the three mechanisms. Each is pinned here.
import { describe, test, expect } from 'vitest';
import {
  companyObjectKey,
  verifyKeyBelongsToCompany,
  companyPrefix,
  keyString,
  SIGNED_URL_MAX_TTL_SECONDS,
  clampSignedUrlTtl,
} from './object-key.js';

const COMPANY_A = '11111111-1111-1111-1111-111111111111';
const COMPANY_B = '22222222-2222-2222-2222-222222222222';

describe('companyObjectKey — every key is company-scoped by construction (CDR-048 §3-G1)', () => {
  test('a derived key always starts with the company prefix', () => {
    const k = companyObjectKey(COMPANY_A, ['documents', 'abc123.md']);
    expect(k.ok).toBe(true);
    if (k.ok) {
      expect(keyString(k.value)).toBe(`company/${COMPANY_A}/documents/abc123.md`);
      expect(keyString(k.value).startsWith(companyPrefix(COMPANY_A))).toBe(true);
    }
  });

  test('two companies can never produce the same key from the same parts', () => {
    const a = companyObjectKey(COMPANY_A, ['documents', 'same.md']);
    const b = companyObjectKey(COMPANY_B, ['documents', 'same.md']);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(keyString(a.value)).not.toBe(keyString(b.value));
  });

  test('an invalid company id is refused — the prefix cannot be built from junk', () => {
    for (const bad of ['', '   ', '../..', 'company', 'not-a-uuid/../x']) {
      expect(companyObjectKey(bad, ['x']).ok, `companyId=${JSON.stringify(bad)}`).toBe(false);
    }
  });
});

describe('companyObjectKey REFUSES traversal rather than sanitising it (CDR-048 §3-G2)', () => {
  // Sanitising is the wrong behaviour: silently rewriting `../other-company/secret` into something adjacent hands
  // the caller a key they never asked for, and the caller is the one who knows whether that is acceptable.
  const escapes: readonly string[] = [
    '..',
    '.',
    '../other',
    'a/../..',
    '/absolute',
    'has/slash',
    'back\\slash',
    '%2e%2e',
    '%2E%2E',
    '%2f',
    '%2F',
    '..%2fetc',
    '\0nul',
    'control',
    '',
    '   ',
    '\t',
  ];

  test.each(escapes)('segment %j is refused as invalid_segment', (segment) => {
    const r = companyObjectKey(COMPANY_A, [segment]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid_segment');
  });

  test('a traversal buried among valid segments is still refused', () => {
    expect(companyObjectKey(COMPANY_A, ['documents', '..', 'secret.md']).ok).toBe(false);
    expect(companyObjectKey(COMPANY_A, ['documents', 'v1', '%2e%2e', 'x']).ok).toBe(false);
  });

  test('NO input can produce a key outside the company prefix — the property, stated directly', () => {
    // The generic form of every case above: whatever comes back OK is inside the prefix, always.
    for (const segment of [...escapes, 'ok', 'a-b_c.1', 'UPPER']) {
      const r = companyObjectKey(COMPANY_A, ['documents', segment]);
      if (r.ok) expect(keyString(r.value).startsWith(companyPrefix(COMPANY_A))).toBe(true);
    }
  });

  test('an empty parts list is refused — a bare prefix is not an object', () => {
    expect(companyObjectKey(COMPANY_A, []).ok).toBe(false);
  });
});

describe('verifyKeyBelongsToCompany — ownership is RE-CHECKED at use (CDR-048 §3-G3)', () => {
  // G1 stops a bug minting a bad key. G3 stops a stale or tampered key — from a database row, an export manifest,
  // a retry payload — from being honoured. Different failure modes; both need closing.
  test('a key derived for A is accepted for A', () => {
    const k = companyObjectKey(COMPANY_A, ['documents', 'x.md']);
    expect(k.ok).toBe(true);
    if (k.ok) expect(verifyKeyBelongsToCompany(keyString(k.value), COMPANY_A)).toBe(true);
  });

  test("a key derived for A is REFUSED for B — the cross-tenant read this exists to stop", () => {
    const k = companyObjectKey(COMPANY_A, ['documents', 'x.md']);
    expect(k.ok).toBe(true);
    if (k.ok) expect(verifyKeyBelongsToCompany(keyString(k.value), COMPANY_B)).toBe(false);
  });

  test('a hand-forged string that merely LOOKS prefixed is refused', () => {
    // The prefix check must be a true path-boundary check, not `startsWith` on a raw substring: a company whose id
    // is a prefix of another's, or a sibling directory named to collide, must not pass.
    const forged = [
      `company/${COMPANY_B}/documents/x.md`,
      `company/${COMPANY_A}-evil/documents/x.md`,
      `company/${COMPANY_A}/../${COMPANY_B}/x.md`,
      `../company/${COMPANY_A}/x.md`,
      `xcompany/${COMPANY_A}/x.md`,
      `company/${COMPANY_A}`,
      '',
    ];
    for (const f of forged) expect(verifyKeyBelongsToCompany(f, COMPANY_A), f).toBe(false);
  });
});

describe('signed-URL TTL is a platform bound, not a caller choice (CDR-048 §4-G5)', () => {
  test('the maximum is clamped — a caller cannot request a long-lived URL', () => {
    expect(clampSignedUrlTtl(86_400)).toBe(SIGNED_URL_MAX_TTL_SECONDS);
    expect(clampSignedUrlTtl(Number.MAX_SAFE_INTEGER)).toBe(SIGNED_URL_MAX_TTL_SECONDS);
  });

  test('zero, negative and non-finite values clamp to a usable floor rather than an unusable URL', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const ttl = clampSignedUrlTtl(bad);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(SIGNED_URL_MAX_TTL_SECONDS);
    }
  });

  test('a value inside the bound is returned unchanged', () => {
    expect(clampSignedUrlTtl(60)).toBe(60);
  });

  test('the maximum is SHORT — a URL is a bearer capability', () => {
    // Not an arbitrary number: the shorter it lives, the smaller the window in which a leaked link is a leaked
    // document. Pinned so that raising it has to be deliberate.
    expect(SIGNED_URL_MAX_TTL_SECONDS).toBeLessThanOrEqual(900);
  });
});
