// @acbp/contracts — pure-ECMAScript unpadded base64url codec for ASCII payloads (ACBP-P1-009/P1-011).
//
// Shared by the opaque activity and portfolio cursors. No Buffer, no btoa/TextEncoder, no Node typings — the
// zero-dependency contracts package stays runtime-neutral. Payloads are ASCII-only (compact JSON of uuids, ULIDs,
// ISO instants and small integers); a decoded byte outside ASCII is rejected as malformed.
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Encode an ASCII string as unpadded base64url. Throws on a non-ASCII code unit (payloads are ASCII by design). */
export function asciiToBase64Url(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const b: number[] = [];
    for (let j = i; j < i + 3 && j < input.length; j++) {
      const code = input.charCodeAt(j);
      if (code > 0x7f) throw new Error('cursor payload must be ASCII');
      b.push(code);
    }
    const b0 = b[0] ?? 0;
    const b1 = b[1] ?? 0;
    const b2 = b[2] ?? 0;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (b.length > 1) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (b.length > 2) out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Decode unpadded base64url to an ASCII string, or null for any malformed token (bad alphabet, impossible
 *  length, or a decoded byte outside ASCII — i.e. a would-be multi-byte UTF-8 sequence). Never throws. */
export function base64UrlToAscii(token: string): string | null {
  if (token.length === 0 || !B64URL_RE.test(token)) return null;
  if (token.length % 4 === 1) return null; // impossible unpadded base64 length
  const idx = (ch: string): number => B64URL_ALPHABET.indexOf(ch);
  let out = '';
  for (let i = 0; i < token.length; i += 4) {
    const c = [...token.slice(i, i + 4)].map(idx);
    if (c.some((x) => x < 0)) return null;
    const c0 = c[0] ?? 0;
    const c1 = c[1] ?? 0;
    const c2 = c[2] ?? 0;
    const c3 = c[3] ?? 0;
    out += String.fromCharCode((c0 << 2) | (c1 >> 4));
    if (c.length > 2) out += String.fromCharCode(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c.length > 3) out += String.fromCharCode(((c2 & 0x03) << 6) | c3);
  }
  for (let i = 0; i < out.length; i++) if (out.charCodeAt(i) > 0x7f) return null;
  return out;
}
