// @acbp/contracts — ULID generation for audit event ids (ACBP-P1-008; EVENT-CATALOG envelope: "event_id |
// ULID, unique"). A ULID is a 26-char Crockford-base32 string: 48 bits of millisecond timestamp (10 chars,
// lexicographically time-sortable) followed by 80 bits of cryptographic randomness (16 chars). Zero-dependency
// (Web Crypto `globalThis.crypto`, available in Node 20+). `nowMs` is injected so the function stays pure and
// unit-testable; the audit writer passes `Date.now()`. Event ids are ALWAYS server-generated — never accepted
// from a caller — so an audit row's identity cannot be forged.

// Crockford base32 alphabet (excludes I, L, O, U to avoid ambiguity).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;
/** Max ULID timestamp: 2^48 - 1 ms (~year 10889). */
const MAX_TIME = 281474976710655;

function encodeTime(nowMs: number): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIME) {
    throw new RangeError('ULID timestamp must be an integer in [0, 2^48).');
  }
  let time = nowMs;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    out = ENCODING[mod] + out;
    time = (time - mod) / ENCODING_LEN;
  }
  return out;
}

// Web Crypto is the framework-neutral randomness source (globalThis.crypto — Node 20+ and browsers). Accessed
// through a typed cast so @acbp/contracts stays zero-dependency (no node:crypto import) without a DOM lib.
const webCrypto = (globalThis as unknown as { crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T } }).crypto;

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  webCrypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    // Map each byte into the 32-char alphabet. `byte % 32` is uniform (256 = 8 x 32), so each of the 16 chars
    // carries full 5-bit entropy — 80 bits total, backed by the database primary-key uniqueness constraint.
    out += ENCODING[(bytes[i] as number) % ENCODING_LEN];
  }
  return out;
}

/** Generate a server-side ULID for an audit event id. `nowMs` is the current epoch-millis (injected). */
export function generateEventId(nowMs: number): string {
  return encodeTime(nowMs) + encodeRandom();
}

/** True IFF `value` is a syntactically valid 26-char Crockford-base32 ULID. */
export function isUlid(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of value) {
    if (!ENCODING.includes(ch)) return false;
  }
  return true;
}
