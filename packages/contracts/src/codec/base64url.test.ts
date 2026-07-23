// @acbp/contracts — shared unpadded base64url codec tests (ACBP-P1-009/P1-011). This codec backs both the
// activity and portfolio opaque cursors, so it is pinned directly here in addition to the cursor-level tests.
import { describe, test, expect } from 'vitest';
import { asciiToBase64Url, base64UrlToAscii } from './base64url.js';

describe('asciiToBase64Url / base64UrlToAscii', () => {
  test('round-trips ASCII payloads of every length class (1,2,3 mod 3) and is URL-safe', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '{"v":1,"a":"x"}', JSON.stringify({ v: 1, a: 'acct', u: 'user', c: '2026-07-22T10:00:00.123456Z', i: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })]) {
      const token = asciiToBase64Url(s);
      expect(token).not.toMatch(/[+/=]/);
      if (s.length > 0) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(base64UrlToAscii(token)).toBe(s === '' ? null : s); // empty encodes to '' which decodes to null
    }
  });

  test('encodes the full byte-value range 0x00–0x7f faithfully', () => {
    let s = '';
    for (let c = 0; c <= 0x7f; c++) s += String.fromCharCode(c);
    expect(base64UrlToAscii(asciiToBase64Url(s))).toBe(s);
  });

  test('throws on a non-ASCII input code unit (payloads are ASCII by design)', () => {
    expect(() => asciiToBase64Url('é')).toThrow();
    expect(() => asciiToBase64Url('aĀb')).toThrow();
  });

  test('base64UrlToAscii returns null for malformed tokens (never throws)', () => {
    expect(base64UrlToAscii('')).toBeNull();
    expect(base64UrlToAscii('has+plus')).toBeNull();
    expect(base64UrlToAscii('has/slash')).toBeNull();
    expect(base64UrlToAscii('has=pad')).toBeNull();
    expect(base64UrlToAscii('ab!cd')).toBeNull();
    expect(base64UrlToAscii('AAAAA')).toBeNull(); // length % 4 === 1 is an impossible unpadded length
  });

  test('base64UrlToAscii rejects a token that decodes to a non-ASCII byte (would-be multi-byte UTF-8)', () => {
    expect(base64UrlToAscii('w6k')).toBeNull(); // decodes to 0xC3 0xA9 (UTF-8 'é')
  });
});
