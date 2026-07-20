// @acbp/contracts — provider-neutral AUTHORITATIVE identity reader contract (ACBP-P1-002 Slice 3;
// ADR-022 §13, CDR-008).
//
// This is a THIRD, distinct identity contract, separate from both the session-oriented IdentityProvider
// (verifies a request's session token) and the IdentityWebhookVerifier (verifies an inbound webhook).
// It models an OUTBOUND authoritative lookup of a provider identity — the read-through used to
// reconcile an internal mapping on a cache/mapping miss. It is framework-neutral and provider-neutral:
// no Clerk SDK object, no raw provider response, no session claim, and no browser-supplied value ever
// crosses it. A provider failure becomes a bounded, sanitized PublicErrorEnvelope.
import type { PublicErrorEnvelope } from '../errors.js';
import type { AdapterCallOptions } from './common.js';

/** The composite provider-identity a caller wants an authoritative snapshot for. */
export interface AuthoritativeIdentityQuery {
  readonly provider: string;
  readonly providerInstanceId: string;
  readonly providerUserId: string;
}

/**
 * Normalized authoritative identity snapshot. MINIMAL PII (CDR-008 #4): primary email + verification
 * only — never names, image URLs, phone numbers, metadata, organizations, roles, permissions, tokens,
 * or session claims, and never a raw provider object.
 */
export interface AuthoritativeIdentitySnapshot {
  readonly provider: string;
  readonly providerInstanceId: string;
  readonly providerUserId: string;
  /** Normalized primary email, or null when absent. Not unique across identities. */
  readonly primaryEmail: string | null;
  /** True only when the authoritative PRIMARY email is verified. */
  readonly emailVerified: boolean;
  /** Provider-reported creation time, or null when unknown. */
  readonly providerCreatedAt: Date | null;
  /** Provider-reported last-update time — the convergence ordering guard. */
  readonly providerUpdatedAt: Date;
}

/**
 * Discriminated result of an authoritative lookup:
 *  - `found`    — the provider returned a live identity (snapshot attached).
 *  - `not_found`— the provider authoritatively has no such identity (create nothing).
 *  - `unavailable` — a provider/network/config failure; bounded sanitized error, never a raw exception.
 */
export type AuthoritativeIdentityResult =
  | { readonly status: 'found'; readonly snapshot: AuthoritativeIdentitySnapshot }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly error: PublicErrorEnvelope };

/** Provider-neutral authoritative identity reader. Implemented per-provider in @acbp/adapters. */
export interface AuthoritativeIdentityReader {
  /** Look up the authoritative identity. Never throws for a genuine not-found; never leaks provider detail. */
  read(query: AuthoritativeIdentityQuery, options?: AdapterCallOptions): Promise<AuthoritativeIdentityResult>;
}
