// @acbp/contracts — object storage keys and the signed-URL bound (ACBP-P0-005; CDR-048; ADR-016). Zero-dep,
// provider-neutral: nothing here knows what S3 is.
//
// The owner's decision (2026-07-27) requires cross-tenant access to be "structurally impossible, not just policy".
// A prefix convention that callers are TRUSTED to follow is policy. Three mechanisms make it structural, and they
// close different holes (CDR-048 §3):
//
//   G1  a key can only be CONSTRUCTED from a company id — `ObjectKey` is branded, so a hand-assembled string is not
//       a key as far as the type system is concerned;
//   G2  the derivation REFUSES anything that could escape the prefix rather than sanitising it;
//   G3  ownership is RE-VERIFIED at use, because a key can arrive from a database row or a retry payload long after
//       it was built, and G1 says nothing about those.

import { toObjectKey, type ObjectKey } from '../adapters/storage-provider.js';

/** Root segment of every object key. Environment separation is the BUCKET's job (CDR-048 §5-G6), not the prefix's. */
const ROOT = 'company';

/**
 * Read the underlying string.
 *
 * `ObjectKey` is P0-019's brand, reused rather than redefined — a second brand would mean two incompatible notions
 * of "a storage key" and a cast between them at every boundary. Note that P0-019's `toObjectKey` remains an
 * UNCHECKED escape hatch by design, for platform-owned objects with no tenant; anything company-owned must come
 * from `companyObjectKey`, and `verifyKeyBelongsToCompany` is what catches a key that did not.
 */
export function keyString(key: ObjectKey): string {
  return key;
}

/** Why a key could not be derived. Closed, because a UI or log may render it. */
export type ObjectKeyFailure = 'invalid_company' | 'invalid_segment' | 'empty_path';

export type ObjectKeyResult = { readonly ok: true; readonly value: ObjectKey } | { readonly ok: false; readonly reason: ObjectKeyFailure };

/** A company id is a UUID. Anything else cannot form a prefix — see the `invalid_company` tests. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path segment is a CONSERVATIVE allowlist: letters, digits, dot, dash, underscore — and never `.`/`..`.
 *
 * Allowlist, not denylist. A denylist has to anticipate every encoding of `..` (`%2e%2e`, `%252e`, overlong UTF-8,
 * unicode look-alikes); an allowlist rejects all of them by saying nothing else is permitted. `%` itself is not in
 * the set, which is what makes the percent-encoded cases fall out for free rather than needing their own rule.
 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(segment: string): boolean {
  if (typeof segment !== 'string' || segment.length === 0 || segment.length > 200) return false;
  if (!SEGMENT.test(segment)) return false;
  // `.` and `..` pass the character allowlist but are exactly the traversal we are excluding.
  if (segment === '.' || segment === '..') return false;
  return true;
}

/** The prefix every one of a company's objects lives under. Always ends in `/` so it is a true path boundary. */
export function companyPrefix(companyId: string): string {
  return `${ROOT}/${companyId}/`;
}

/**
 * Derive a company-scoped object key, or refuse.
 *
 * REFUSES rather than sanitises (CDR-048 §3-G2). Quietly rewriting `../other-company/secret` into something adjacent
 * hands the caller a key they never asked for, and the caller is the one who knows whether that is acceptable — a
 * silent rewrite turns a bug into a wrong-but-plausible object, which is harder to notice than an error.
 */
export function companyObjectKey(companyId: string, parts: readonly string[]): ObjectKeyResult {
  if (typeof companyId !== 'string' || !UUID.test(companyId)) return { ok: false, reason: 'invalid_company' };
  // `readonly unknown[]` rather than the declared type: this is a trust boundary, and the declared signature is
  // only a promise. A caller reaching it from parsed JSON can pass anything, and `isSafeSegment` is what decides.
  const segments: readonly unknown[] = Array.isArray(parts) ? (parts as readonly unknown[]) : [];
  if (segments.length === 0) return { ok: false, reason: 'empty_path' };
  const safe: string[] = [];
  for (const part of segments) {
    if (typeof part !== 'string' || !isSafeSegment(part)) return { ok: false, reason: 'invalid_segment' };
    safe.push(part);
  }
  return { ok: true, value: toObjectKey(`${companyPrefix(companyId)}${safe.join('/')}`) };
}

/**
 * Does this key belong to this company? Checked at USE, not only at construction (CDR-048 §3-G3).
 *
 * G1 stops a bug from minting a bad key; this stops a stale or tampered one — from a row, an export manifest, a
 * retry payload — from being honoured. Relying on construction alone would mean any row that ever held a wrong key
 * becomes a live cross-tenant read.
 *
 * The comparison is a true PATH-BOUNDARY check: the prefix ends in `/`, so `company/<A>-evil/...` cannot satisfy
 * `company/<A>/`. A bare `startsWith` on an id without the trailing separator would let a company whose id is a
 * prefix of another's read across the boundary.
 */
export function verifyKeyBelongsToCompany(key: string, companyId: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (typeof companyId !== 'string' || !UUID.test(companyId)) return false;
  const prefix = companyPrefix(companyId);
  if (!key.startsWith(prefix)) return false;
  // Re-validate the remainder: a key that starts correctly but carries traversal after the prefix must not pass.
  const rest = key.slice(prefix.length);
  if (rest.length === 0) return false; // the bare prefix is a directory, not an object
  return rest.split('/').every(isSafeSegment);
}

// ── signed URLs (CDR-048 §4) ─────────────────────────────────────────────────────────────────────────────

/**
 * The platform maximum lifetime of a signed read URL, in seconds.
 *
 * A signed URL is a BEARER CAPABILITY: anyone holding the link can read the object until it expires. The shorter it
 * lives, the smaller the window in which a leaked link is a leaked document. Fifteen minutes is long enough for a
 * browser to fetch and a slow connection to finish, and short enough that a link pasted into a chat is dead before
 * it is useful. A platform constant, never a caller argument (§4-G5).
 */
export const SIGNED_URL_MAX_TTL_SECONDS = 900;

/** Floor, so a caller passing nonsense gets a usable URL rather than one that has already expired. */
export const SIGNED_URL_MIN_TTL_SECONDS = 30;

/** Clamp a requested TTL into the platform bound. A caller cannot widen it, only ask for less. */
export function clampSignedUrlTtl(requestedSeconds: number): number {
  if (!Number.isFinite(requestedSeconds)) return SIGNED_URL_MIN_TTL_SECONDS;
  const whole = Math.trunc(requestedSeconds);
  if (whole < SIGNED_URL_MIN_TTL_SECONDS) return SIGNED_URL_MIN_TTL_SECONDS;
  return Math.min(whole, SIGNED_URL_MAX_TTL_SECONDS);
}
