// @acbp/contracts — the artifact read-back rule (ACBP-P5-011; CDR-060 G1; TASK-005). Zero-dep and PURE.
//
// TASK-005's failure clause has two halves. The loud half is a persist that THROWS, and any caller remembers to
// handle that. The quiet half is a persist that RETURNS SUCCESS for bytes that never landed — a provider bug, a
// silently dropped write, a partial upload reported as whole — and the caller has no reason to doubt it. That half is
// what turns a task into a hollow success, so the object is read back and compared before any row claims it exists.
import type { HeadObjectResult } from '../adapters/storage-provider.js';

export type ObjectVerificationFailure = 'object_missing' | 'size_mismatch' | 'unreadable';
export type ObjectVerification = { readonly ok: true } | { readonly ok: false; readonly reason: ObjectVerificationFailure };

/**
 * Did the object we just wrote actually land, whole?
 *
 * FAILS CLOSED on anything it cannot read. A malformed or unexpected head result means we do not know whether the
 * object is there, and "we do not know" must fail the task rather than complete it — the whole point of the rule.
 *
 * SIZE MISMATCH IN EITHER DIRECTION IS A FAILURE. A short object is a truncated write; a long one is not a harmless
 * surplus but a sign the key does not address the content we believe it does, which under content addressing is the
 * more alarming of the two.
 *
 * This is a size check, not a checksum: the digest is computed from the bytes we hold, so re-hashing them proves
 * nothing about what the provider stored, and asking the provider to attest its own checksum trusts the party whose
 * honesty is in question. Reading the object back in full would be the stronger check and is deliberately not done
 * per write — an 8 MiB read-back on every artifact to catch a provider defect is a cost the size check gets most of
 * for free.
 */
export function verifyPersistedObject(head: HeadObjectResult, expectedSizeBytes: number): ObjectVerification {
  if (!Number.isInteger(expectedSizeBytes) || expectedSizeBytes <= 0) return { ok: false, reason: 'unreadable' };
  if (typeof head !== 'object' || head === null) return { ok: false, reason: 'unreadable' };
  const candidate = head as { exists?: unknown; metadata?: { sizeBytes?: unknown } };
  if (candidate.exists === false) return { ok: false, reason: 'object_missing' };
  if (candidate.exists !== true) return { ok: false, reason: 'unreadable' };
  const size = candidate.metadata?.sizeBytes;
  if (typeof size !== 'number' || !Number.isInteger(size)) return { ok: false, reason: 'unreadable' };
  if (size !== expectedSizeBytes) return { ok: false, reason: 'size_mismatch' };
  return { ok: true };
}
