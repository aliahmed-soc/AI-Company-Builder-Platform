// @acbp/core — the approval payload digest (ACBP-P6-004; CDR-069 §1-G2).
//
// THIS FILE IS ONE LINE OF LOGIC, and it lives here for a boundary reason worth stating so nobody "tidies" it back.
// `@acbp/contracts` is zero-dep and framework-neutral; `node:crypto` would have been the only Node import in that
// package. So contracts owns the CANONICAL MATERIAL — the exact bytes, the versioning, the collision resistance —
// and this owns the digest over them.
//
// It is the same split the dispatcher already uses for TOOL-002's `arguments_digest`: `canonicalizeToolArguments`
// in contracts, `createHash` at the call site. One canonicalization, one hashing step, and no second
// implementation of either to drift out of agreement.
import { createHash } from 'node:crypto';
import { BINDING_NORMALIZATION_VERSION, bindingMaterial, type ApprovalBindingInput, type PayloadBinding } from '@acbp/contracts';

/**
 * The bound hash of a proposed action, and the normalization version it was taken under.
 *
 * Both halves are stored together on the approval request, because a hash without its ruleset version cannot be
 * verified later — see `BINDING_NORMALIZATION_VERSION` for why an unknown version is a mismatch rather than a
 * migration prompt.
 */
export function computePayloadBinding(input: ApprovalBindingInput): PayloadBinding {
  return { hash: createHash('sha256').update(bindingMaterial(input), 'utf8').digest('hex'), version: BINDING_NORMALIZATION_VERSION };
}
