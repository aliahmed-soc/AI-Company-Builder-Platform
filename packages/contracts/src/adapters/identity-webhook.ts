// @acbp/contracts — provider-neutral identity webhook verification contract (ACBP-P1-002; ADR-022 §13,
// CDR-007, CDR-008).
//
// This is DISTINCT from the session-oriented IdentityProvider (CDR-008 #6): it models the inbound,
// signature-verified provider webhook that synchronizes external identities into internal mappings.
// It is framework-neutral (no Next.js Request) and provider-neutral (no Clerk SDK types, no raw
// provider payload). Signature verification happens INSIDE the verifier; nothing downstream trusts an
// unverified event. The signing secret NEVER appears on any event object.
import type { PublicErrorEnvelope } from '../errors.js';
import type { AdapterCallOptions } from './common.js';

/** Supported identity webhook event types for ACBP-P1-002 (users only; CDR-008 #11). */
export type IdentityWebhookEventType = 'user.created' | 'user.updated' | 'user.deleted';

/**
 * Normalized user state carried by create/update events. Minimal PII (CDR-008 #4): primary email +
 * verification only — no display name. Delete events carry NO user state (no PII).
 */
export interface NormalizedWebhookUser {
  readonly providerUserId: string;
  /** Normalized primary email, or null when absent. Not unique across identities. */
  readonly primaryEmail: string | null;
  /** Authoritative primary-email verification state from the provider. */
  readonly emailVerified: boolean;
  /** ISO-8601 provider-reported creation time, if present. */
  readonly providerCreatedAt?: string;
  /** ISO-8601 provider-reported last-update time — the convergence ordering guard. */
  readonly providerUpdatedAt: string;
}

/** Fields common to every verified event envelope. Contains no raw payload and no secret. */
interface VerifiedIdentityWebhookBase {
  /** Provider discriminator, e.g. 'clerk'. */
  readonly provider: string;
  /** Provider instance/tenant id (isolates instances; CDR-008 #5). */
  readonly providerInstanceId: string;
  /** Provider event/message id — idempotency/dedupe key only; never a product identifier. */
  readonly eventId: string;
  /** Opaque provider subject/user id. */
  readonly providerUserId: string;
  /** ISO-8601 event-envelope timestamp. */
  readonly occurredAt: string;
  /** ISO-8601 last-write-wins ordering guard (provider updatedAt; for deletes, the envelope time). */
  readonly orderingTimestamp: string;
  /** Lowercase 64-hex SHA-256 of the raw verified payload (the payload itself is never exposed/stored). */
  readonly payloadSha256: string;
}

/** A verified, provider-neutral identity webhook event (discriminated by `type`). */
export type VerifiedIdentityWebhookEvent =
  | (VerifiedIdentityWebhookBase & { readonly type: 'user.created'; readonly user: NormalizedWebhookUser })
  | (VerifiedIdentityWebhookBase & { readonly type: 'user.updated'; readonly user: NormalizedWebhookUser })
  | (VerifiedIdentityWebhookBase & { readonly type: 'user.deleted' });

/**
 * Result of verifying a raw inbound webhook request. `verified` carries a supported event; `ignored`
 * is a genuinely verified-but-unsupported event acknowledged as a no-op (NOT a parse failure);
 * `invalid` is a signature/parse/format failure (fail closed — never persist).
 *
 * The `invalid` error is a bounded, already-sanitized {@link PublicErrorEnvelope} (stable
 * category/code, safe message, retryability) — NOT a raw `Error`/`unknown`, and never a provider
 * (Clerk / standardwebhooks) exception, raw provider message, request body, signature, or secret. The
 * adapter converts any provider failure into a `platformError(...).toPublic()` before it crosses here.
 */
export type IdentityWebhookVerification =
  | { readonly status: 'verified'; readonly event: VerifiedIdentityWebhookEvent }
  | { readonly status: 'ignored'; readonly provider: string; readonly providerInstanceId: string; readonly eventId: string; readonly eventType: string }
  | { readonly status: 'invalid'; readonly error: PublicErrorEnvelope };

/**
 * Framework-neutral inbound request handed to the verifier: the EXACT raw request body bytes and a
 * normalized header record. The verifier owns signature + timestamp/replay checks.
 *
 * Boundary contract:
 *  - `rawBody` is the unmodified request payload as RAW BYTES (`Uint8Array`) — never decoded to text
 *    or parsed as JSON in contracts/core; byte-exact fidelity is required for signature verification
 *    and for the payload SHA-256. The provider adapter is solely responsible for converting these
 *    neutral bytes + headers into the provider SDK's verification call.
 *  - `headers` keys are normalized to lowercase consistently by the caller; header VALUES are passed
 *    through exactly (unmodified). The verifier reads only the signature headers it needs.
 *  - The signing secret is NEVER part of this request (nor any event); it lives only in the adapter's
 *    injected configuration.
 */
export interface IdentityWebhookRequest {
  /** The exact, unmodified raw request body bytes (used for signature verification + SHA-256). */
  readonly rawBody: Uint8Array;
  /** Normalized request headers (lowercase keys, exact values); verifier reads only what it needs. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Provider-neutral inbound identity-webhook verifier. Implemented per-provider in @acbp/adapters. */
export interface IdentityWebhookVerifier {
  /** Verify signature + normalize. Never throws for an unsupported-but-verified event (→ `ignored`). */
  verify(request: IdentityWebhookRequest, options?: AdapterCallOptions): Promise<IdentityWebhookVerification>;
}
