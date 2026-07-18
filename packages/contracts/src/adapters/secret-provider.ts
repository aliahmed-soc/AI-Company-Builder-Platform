// @acbp/contracts — secret-provider contract (ACBP-P0-019; ADR-014, ADR-021; INTEG-002, NFR-018).
//
// Product code works with opaque secret REFERENCES; secret VALUES are resolved only at a trusted
// server/worker boundary via this contract, and returned as a redaction-safe wrapper — never as a
// plain string in a DTO. Missing / expired / unavailable / access-denied are distinct so callers can
// FAIL CLOSED (adapter absence = fail closed): anything other than `resolved` must be treated as a
// denial, never as "no secret needed".
import type { PlatformError } from '../errors.js';
import type { AdapterCallOptions } from './common.js';

declare const secretRefBrand: unique symbol;
/** Opaque reference to a secret (the `credential_ref` data object). Carries NO value; safe to store/serialize. */
export type SecretRef = string & { readonly [secretRefBrand]: true };

/** Construct a SecretRef from a provider-neutral reference string (e.g., an Infisical path handle). */
export function toSecretRef(ref: string): SecretRef {
  return ref as SecretRef;
}

/**
 * A resolved secret value wrapper. The plaintext is obtainable ONLY via reveal() at a trusted
 * boundary; the wrapper must redact itself under toString/toJSON/logging (e.g., `@acbp/config`
 * `Secret` satisfies this structurally). Never place a SecretValue in an ordinary serialized DTO.
 */
export interface SecretValue {
  reveal(): string;
}

export type SecretResolutionStatus = 'resolved' | 'missing' | 'expired' | 'unavailable' | 'access_denied';

/** Discriminated result. Only `resolved` carries a value; every other case carries a redacted error. */
export type SecretResolution =
  | { readonly status: 'resolved'; readonly value: SecretValue }
  | { readonly status: 'missing'; readonly error: PlatformError }
  | { readonly status: 'expired'; readonly error: PlatformError }
  | { readonly status: 'unavailable'; readonly error: PlatformError }
  | { readonly status: 'access_denied'; readonly error: PlatformError };

/** Narrows to the resolved case. Callers MUST fail closed when this returns false. */
export function isSecretResolved(result: SecretResolution): result is Extract<SecretResolution, { status: 'resolved' }> {
  return result.status === 'resolved';
}

export interface SecretProvider {
  /** Resolve a secret reference to a value wrapper, or a redacted failure. Never returns plaintext directly. */
  resolve(ref: SecretRef, options?: AdapterCallOptions): Promise<SecretResolution>;
}
