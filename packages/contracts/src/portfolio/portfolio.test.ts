// @acbp/contracts — company portfolio contract tests (ACBP-P1-011; CDR-017).
import { describe, test, expect } from 'vitest';
import {
  PORTFOLIO_PAGE_SIZE_DEFAULT,
  PORTFOLIO_PAGE_SIZE_MAX,
  parsePortfolioLimit,
  encodePortfolioCursor,
  decodePortfolioCursor,
  type PortfolioCursor,
} from './index.js';

// Local base64url encoder for forged-token construction (ASCII payloads only) — mirrors the shared codec so
// the tests can build adversarial payloads the production encoder would never emit.
const encObj = (obj: unknown): string => {
  const s = JSON.stringify(obj);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const b0 = s.charCodeAt(i);
    const b1 = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
    const b2 = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
    out += A[b0 >> 2];
    out += A[((b0 & 3) << 4) | (Number.isNaN(b1) ? 0 : b1 >> 4)];
    if (!Number.isNaN(b1)) out += A[((b1 & 15) << 2) | (Number.isNaN(b2) ? 0 : b2 >> 6)];
    if (!Number.isNaN(b2)) out += A[b2 & 63];
  }
  return out;
};

describe('parsePortfolioLimit (CDR-017 §8: default 25, max 100, REJECT — not clamp)', () => {
  test('absent/empty yields the default', () => {
    expect(parsePortfolioLimit(undefined)).toBe(PORTFOLIO_PAGE_SIZE_DEFAULT);
    expect(parsePortfolioLimit(null)).toBe(PORTFOLIO_PAGE_SIZE_DEFAULT);
    expect(parsePortfolioLimit('')).toBe(PORTFOLIO_PAGE_SIZE_DEFAULT);
    expect(PORTFOLIO_PAGE_SIZE_DEFAULT).toBe(25);
    expect(PORTFOLIO_PAGE_SIZE_MAX).toBe(100);
  });
  test('accepts integers and all-digit strings within [1, 100]', () => {
    expect(parsePortfolioLimit(1)).toBe(1);
    expect(parsePortfolioLimit(25)).toBe(25);
    expect(parsePortfolioLimit(100)).toBe(100);
    expect(parsePortfolioLimit('1')).toBe(1);
    expect(parsePortfolioLimit('50')).toBe(50);
    expect(parsePortfolioLimit('100')).toBe(100);
  });
  test('REJECTS (null) zero, negatives, > max, non-integers, and non-numeric — never clamps', () => {
    for (const bad of [0, '0', -1, '-5', 101, '101', 1000, '1000', 1.5, 10.9, NaN, Infinity, -Infinity, 'abc', '10.5', '1e2', ' 10', '10 ', '0x10', {}, [], true]) {
      expect(parsePortfolioLimit(bad)).toBeNull();
    }
  });
  test('a 4+ digit string is rejected outright (guards against overflow before range check)', () => {
    expect(parsePortfolioLimit('1000')).toBeNull();
    expect(parsePortfolioLimit('99999')).toBeNull();
  });
});

describe('portfolio cursor (opaque base64url; versioned; account+ACTOR bound; keyset position)', () => {
  const acct = '11111111-1111-1111-1111-111111111111';
  const actor = 'user_2abcDEF';
  const CUR: PortfolioCursor = { createdAt: '2026-07-22T10:00:00.123456Z', companyId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
  const base = { v: 1, a: acct, u: actor, c: CUR.createdAt, i: CUR.companyId };

  test('round-trips for the same account+actor and is URL-safe (no +, /, =)', () => {
    const token = encodePortfolioCursor(acct, actor, CUR);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toMatch(/[+/=]/);
    expect(decodePortfolioCursor(acct, actor, token)).toEqual(CUR);
  });
  test('rejects a foreign account and a foreign actor (binding — the core defense)', () => {
    const token = encodePortfolioCursor(acct, actor, CUR);
    expect(decodePortfolioCursor('22222222-2222-2222-2222-222222222222', actor, token)).toBeNull();
    expect(decodePortfolioCursor(acct, 'user_9zzzZZZ', token)).toBeNull();
  });
  test('rejects malformed base64 (bad alphabet, impossible length), empty, non-string, oversized', () => {
    expect(decodePortfolioCursor(acct, actor, 'has+plus/and=pad')).toBeNull();
    expect(decodePortfolioCursor(acct, actor, 'ab!cd')).toBeNull();
    expect(decodePortfolioCursor(acct, actor, 'AAAAA')).toBeNull(); // length % 4 === 1 is impossible
    expect(decodePortfolioCursor(acct, actor, '')).toBeNull();
    expect(decodePortfolioCursor(acct, actor, 42)).toBeNull();
    expect(decodePortfolioCursor(acct, actor, 'A'.repeat(700))).toBeNull();
  });
  test('rejects non-JSON, non-object, and non-ASCII payloads', () => {
    expect(decodePortfolioCursor(acct, actor, encObj('not-an-object'))).toBeNull();
    expect(decodePortfolioCursor(acct, actor, encObj(['array']))).toBeNull();
    expect(decodePortfolioCursor(acct, actor, 'e2JhZA')).toBeNull(); // decodes to '{bad' — not JSON
    expect(decodePortfolioCursor(acct, actor, 'w6k')).toBeNull(); // decodes to UTF-8 'é' — non-ASCII
  });
  test('rejects unknown version and missing fields', () => {
    expect(decodePortfolioCursor(acct, actor, encObj({ ...base, v: 2 }))).toBeNull();
    expect(decodePortfolioCursor(acct, actor, encObj({ ...base, v: 0 }))).toBeNull();
    for (const missing of ['a', 'u', 'c', 'i'] as const) {
      const { [missing]: _drop, ...rest } = base;
      expect(decodePortfolioCursor(acct, actor, encObj(rest))).toBeNull();
    }
  });
  test('rejects an invalid timestamp and an invalid (non-UUID) company id', () => {
    expect(decodePortfolioCursor(acct, actor, encObj({ ...base, c: 'not-a-date' }))).toBeNull();
    expect(decodePortfolioCursor(acct, actor, encObj({ ...base, c: '2026' }))).toBeNull();
    expect(decodePortfolioCursor(acct, actor, encObj({ ...base, c: 'Jan 1 2026' }))).toBeNull();
    expect(decodePortfolioCursor(acct, actor, encObj({ ...base, i: 'not-a-uuid' }))).toBeNull();
    expect(decodePortfolioCursor(acct, actor, encObj({ ...base, i: '' }))).toBeNull();
    // A ULID (activity-style id) is NOT a valid company id here — the portfolio keys on the UUID company id.
    expect(decodePortfolioCursor(acct, actor, encObj({ ...base, i: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }))).toBeNull();
  });
  test('rejects over-long account/actor binding fields', () => {
    expect(decodePortfolioCursor('x'.repeat(65), actor, encObj({ ...base, a: 'x'.repeat(65) }))).toBeNull();
    expect(decodePortfolioCursor(acct, 'x'.repeat(65), encObj({ ...base, u: 'x'.repeat(65) }))).toBeNull();
  });
  test('accepts exact microsecond-precision timestamps (the canonical stored form)', () => {
    const micro: PortfolioCursor = { createdAt: '2026-07-22T10:00:00.999999Z', companyId: CUR.companyId };
    expect(decodePortfolioCursor(acct, actor, encodePortfolioCursor(acct, actor, micro))).toEqual(micro);
  });
  test('a tampered-but-well-formed position still decodes (it can only re-window the caller\'s own portfolio)', () => {
    const tampered = encObj({ ...base, c: '2020-01-01T00:00:00.000Z' });
    expect(decodePortfolioCursor(acct, actor, tampered)).toEqual({ createdAt: '2020-01-01T00:00:00.000Z', companyId: CUR.companyId });
  });
});
