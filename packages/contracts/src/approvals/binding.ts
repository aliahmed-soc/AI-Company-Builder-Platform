// @acbp/contracts — approval binding, expiry and usability (ACBP-P6-004; CDR-069; ADR-009; APPR-004/005/006/009).
//
// ADR-009's title is the requirement: *"Payload-hash-bound, expiring, revocable, single-use approvals enforced at
// the tool dispatcher."* P6-003 recorded what a human decided. This module makes that decision bind to a SPECIFIC
// execution, so `APPROVAL-AND-POLICY-ARCHITECTURE §2`'s promise — "what you approved is exactly what runs" — becomes
// a test that can fail rather than a sentence in a document.
//
// THE HASHING IS NOT HERE, AND THAT IS THE BOUNDARY SPEAKING. `@acbp/contracts` is zero-dep and framework-neutral;
// `node:crypto` would have been the only Node import in the package. So this module owns the CANONICAL MATERIAL —
// the exact bytes that get hashed — and `@acbp/core` owns the digest, which is precisely how the dispatcher already
// splits `canonicalizeToolArguments` from its `createHash` call for TOOL-002. One canonicalization, one hashing
// call site, no second implementation to drift.
//
// EVERYTHING HERE IS PURE AND TOTAL. The atomicity that makes single-use real is a single conditional UPDATE in the
// database (CDR-069 §1-G5); these functions answer "would this approval authorize this call?", which is the question
// that predicate encodes and the question a reader needs answered afterwards.
import { canonicalizeToolArguments } from '../tools/arguments.js';

/**
 * The normalization ruleset version baked into every stored binding.
 *
 * ADR-009 names the maintenance cost of this design explicitly: *"canonical serialization/normalization rules must
 * be versioned and maintained."* Storing the version beside the hash is what makes that possible — and an UNKNOWN
 * version is a mismatch rather than a migration prompt, because a hash we cannot recompute is a hash we cannot
 * verify. Bump this only alongside a deliberate decision about what happens to approvals bound under the old rules.
 */
export const BINDING_NORMALIZATION_VERSION = 1;

/** Exactly what the material-change rule binds (APPROVAL-AND-POLICY §2), and nothing else — CDR-069 §1-G1. */
export interface ApprovalBindingInput {
  readonly toolId: string;
  readonly toolVersion: number;
  readonly payload: unknown;
  /** The cost bound from preflight. Execution exceeding it fails closed, so a change to it is a material change. */
  readonly costBoundCredits: number;
}

export interface PayloadBinding {
  readonly hash: string;
  readonly version: number;
}

/**
 * The exact bytes an approval's hash is taken over.
 *
 * Field-labelled and newline-separated, so `("ab", "c")` and `("a", "bc")` cannot collide: the labels and the
 * separator cannot appear inside a canonical encoding at the position that would be needed to shift a boundary.
 * The version is the FIRST line, so material produced under different rules can never be byte-equal.
 *
 * `canonicalizeToolArguments` is reused rather than reimplemented — it is already total over cycles, `Date`s and
 * junk, sorts object keys and preserves array order. A second canonicalization is the defect this design is most
 * exposed to: two functions that agree today and drift tomorrow, the disagreement surfacing as approvals that
 * mysteriously stop matching.
 */
export function bindingMaterial(input: ApprovalBindingInput): string {
  return [
    `v${BINDING_NORMALIZATION_VERSION}`,
    `tool=${canonicalizeToolArguments(input.toolId)}`,
    `version=${canonicalizeToolArguments(input.toolVersion)}`,
    `cost=${canonicalizeToolArguments(input.costBoundCredits)}`,
    `payload=${canonicalizeToolArguments(input.payload)}`,
  ].join('\n');
}

/**
 * Does a STORED binding authorize a call whose material hashes to `expectedHash`? Total over junk, false by default.
 *
 * A stored binding at an unrecognised version returns `false` — see `BINDING_NORMALIZATION_VERSION`. So does an
 * unreadable one: a corrupt record must never read as agreement.
 *
 * THERE IS NO SHAPE CHECK ON THE STORED HASH, and its absence is deliberate. One was written here
 * (`/^[0-9a-f]{64}$/`) and mutation testing proved it could not fire: the expected hash is always a real digest, so
 * `===` already refuses an empty string, a non-hex string, a number, or anything else. Deleting it beat keeping it,
 * on this repo's own measured rule — a guard that cannot fire is worse than no guard, because the next reader
 * trusts it and stops looking. The junk cases are still asserted; they are carried by the comparison rather than by
 * a second condition pretending to be independent.
 */
export function bindingMatches(stored: PayloadBinding | null | undefined, expectedHash: string): boolean {
  if (stored === null || stored === undefined || typeof stored !== 'object') return false;
  if (stored.version !== BINDING_NORMALIZATION_VERSION) return false;
  return stored.hash === expectedHash;
}

const isUsableDate = (v: unknown): v is Date => v instanceof Date && Number.isFinite(v.getTime());

/**
 * Has this approval expired at `now`?
 *
 * `now >= expiresAt`, so the boundary instant is EXPIRED. `APPROVAL-AND-POLICY §2` says clock ambiguity resolves to
 * expired, and the instant an approval is defined to die is precisely the ambiguous one.
 *
 * AN UNREADABLE CLOCK OR EXPIRY IS ALSO EXPIRED. That is the same rule applied to a different ambiguity: if we
 * cannot tell whether an approval is still valid, it is not. `now` is a PARAMETER — reading the wall clock here
 * would make "was this valid at time T?" unanswerable from the record.
 */
export function isExpired(now: unknown, expiresAt: unknown): boolean {
  if (!isUsableDate(now) || !isUsableDate(expiresAt)) return true;
  return now.getTime() >= expiresAt.getTime();
}

/** The stored approval state this module reasons about. Structural on purpose — the row shape lives in @acbp/database. */
export interface ApprovalUsabilityState {
  readonly status: unknown;
  readonly revokedAt: unknown;
  readonly expiresAt: unknown;
  readonly binding: PayloadBinding | null | undefined;
}

export type ApprovalUnusableReason = 'not_decided' | 'consumed' | 'revoked' | 'expired' | 'payload_mismatch';

export type ApprovalUsability = { readonly usable: true } | { readonly usable: false; readonly reason: ApprovalUnusableReason };

/**
 * The whole question, in one total function: would this approval authorize this call at this instant?
 *
 * THERE IS NO LENIENT OUTCOME. The backlog's failure clause for this ticket is *"Hash mismatch = reject never
 * warn-and-continue"*, and the way to guarantee that is to make the lenient answer INEXPRESSIBLE: the result type
 * has two shapes, and neither is a warning.
 *
 * ORDER MATTERS, and it is chosen for the reader rather than for the machine — every branch refuses, so any order
 * is equally safe, but only one produces a reason a human can act on:
 *   1. `consumed` first, because "it already ran" explains a surprise better than "it expired".
 *   2. REVOCATION OUTRANKS EXPIRY. Both may be true; a human deliberately withdrew this one, and that is the fact
 *      worth surfacing. "It expired" would send someone to look at clocks instead of at the person who revoked it.
 *   3. The payload check runs LAST because it is the only expensive one, and because a mismatch on an
 *      already-revoked approval is not the interesting finding.
 *
 * THIS IS NOT THE ENFORCEMENT. Single-use is enforced by one conditional UPDATE whose zero-row result is the
 * refusal (CDR-069 §1-G5) — a check here followed by a write there would be exactly the read-then-write window that
 * lets two dispatches both proceed. This answers the same question for callers who need it BEFORE committing, and
 * for anyone reconstructing afterwards why a call was refused.
 */
export function approvalUsability(state: ApprovalUsabilityState | null | undefined, expectedHash: string, now: unknown): ApprovalUsability {
  if (state === null || state === undefined || typeof state !== 'object') return { usable: false, reason: 'not_decided' };
  if (state.status === 'consumed') return { usable: false, reason: 'consumed' };
  if (state.revokedAt !== null && state.revokedAt !== undefined) return { usable: false, reason: 'revoked' };
  if (state.status !== 'decided') return { usable: false, reason: 'not_decided' };
  if (isExpired(now, state.expiresAt)) return { usable: false, reason: 'expired' };
  if (!bindingMatches(state.binding, expectedHash)) return { usable: false, reason: 'payload_mismatch' };
  return { usable: true };
}
