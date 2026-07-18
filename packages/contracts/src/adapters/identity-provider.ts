// @acbp/contracts — identity-provider contract (ACBP-P0-019; ADR-022).
//
// The external identity provider (e.g., Clerk) owns identity + sessions. This contract only
// NORMALIZES what the provider asserts — it makes no authorization decisions. Provider claims never
// authorize; internal authz, company membership, and roles remain product-owned and are NOT modeled
// here. A provider organization object must never become the product's authoritative company. A
// provider deletion event is just an event — it does not itself authorize product-data deletion.
import type { PlatformError } from '../errors.js';
import type { AdapterCallOptions } from './common.js';

/**
 * Normalized identity claims. NOT authoritative for company/roles/permissions. `providerUserId` is a
 * link/diagnostic key to the external identity, not a product identity or authorization grant.
 */
export interface NormalizedIdentity {
  readonly providerUserId: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly displayName?: string;
}

/** Result of verifying an opaque session token. `unavailable` => fail closed (deny). */
export type SessionVerification =
  | { readonly status: 'valid'; readonly identity: NormalizedIdentity }
  | { readonly status: 'invalid'; readonly error: PlatformError }
  | { readonly status: 'unavailable'; readonly error: PlatformError };

export type IdentityEventType = 'user.created' | 'user.updated' | 'user.deleted' | 'session.revoked';

/** Provider-neutral, already-signature-verified identity lifecycle event (e.g., a normalized webhook). */
export interface IdentityEvent {
  readonly type: IdentityEventType;
  /** Provider event id — for idempotency/dedupe/diagnostics only; never a product identifier. */
  readonly eventId: string;
  /** ISO-8601 timestamp. */
  readonly occurredAt: string;
  readonly identity: NormalizedIdentity;
}

export interface IdentityProvider {
  /** Verify an opaque session token. Never trusts client-supplied claims directly. */
  verifySession(token: string, options?: AdapterCallOptions): Promise<SessionVerification>;
  /** Normalize raw provider claims into the neutral shape. Makes NO authorization decision. */
  normalizeClaims(rawClaims: unknown): NormalizedIdentity;
  /** Parse a raw, signature-verified provider webhook payload into a neutral event. */
  parseEvent(rawEvent: unknown, options?: AdapterCallOptions): Promise<IdentityEvent>;
}
