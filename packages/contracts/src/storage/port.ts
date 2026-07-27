// @acbp/contracts — the signed-URL half of the object-storage contract (ACBP-P0-005; CDR-048 §4; ADR-016).
//
// This file EXTENDS the port ACBP-P0-019 already built in `adapters/storage-provider.ts`. It does not replace it,
// and there is deliberately no second `ObjectStorage` interface: two storage ports could disagree about when a
// tenant boundary is crossed, which is the worst possible thing to be ambiguous about.
//
// P0-019 left exactly two things for the moment a provider was chosen, and said so in its own header:
//   1. "no presigned-URL abstraction (deferred until a provider is chosen and canonical scope requires it)";
//   2. "when tenant-owned objects are introduced later, the caller must make tenant ownership explicit in the key
//      … this contract never derives cross-tenant keys."
// The owner's 2026-07-27 decision supplies the provider class, so this ticket supplies both: the derivation lives in
// `object-key.ts`, the signing capability lives here.
import type { ObjectKey } from '../adapters/storage-provider.js';

/**
 * A short-lived, prefix-scoped read capability (CDR-048 §4). NEVER a public URL — the owner's decision forbids
 * public bucket access outright, so this is the only read path for a browser.
 */
export interface SignedReadUrl {
  readonly url: string;
  /**
   * Absolute expiry, ISO-8601 — not a duration. A duration has to be added to something, and the thing it gets
   * added to is where "expires in 15 minutes" quietly becomes "expires 15 minutes after whenever this was read".
   */
  readonly expiresAt: string;
}

export type SignedUrlResult =
  | { readonly status: 'ok'; readonly signed: SignedReadUrl }
  | { readonly status: 'not_found' }
  // The key does not belong to the requesting company. Distinct from `not_found` INTERNALLY so the platform can
  // alarm on it — a cross-tenant signing attempt is a security event, not a miss. What the CALLER is told is a
  // separate decision for the use case, which should not confirm the existence of another tenant's object.
  | { readonly status: 'forbidden' };

/**
 * Issues short-lived read URLs for company-owned objects.
 *
 * Separate from `ObjectStorage` (P0-019) rather than bolted onto it: put/get/head are byte transport and are
 * meaningful for platform-owned objects with no tenant at all, whereas signing is inherently a TENANT-SCOPED
 * capability — it takes a `companyId` because it cannot be done safely without one. Keeping them apart means an
 * implementation of the transport port cannot accidentally acquire the authority to mint capabilities.
 */
export interface SignedUrlIssuer {
  /**
   * `requestedTtlSeconds` is CLAMPED by the implementation (`clampSignedUrlTtl`), never honoured verbatim.
   *
   * `companyId` is required so the implementation can RE-VERIFY that the key belongs to the caller before signing
   * (CDR-048 §3-G3). The branded `ObjectKey` proves a key was well-formed when it was built; it proves nothing
   * about a key loaded from a row months later, and that is the case this parameter exists for.
   */
  signedReadUrl(key: ObjectKey, companyId: string, requestedTtlSeconds: number): Promise<SignedUrlResult>;
}

/**
 * Runtime storage configuration.
 *
 * The bucket is CONFIGURATION and is never derived from tenant data (CDR-048 §5-G7): one bucket per environment,
 * with tenant separation carried entirely by the key prefix. A bucket-per-company scheme would make tenant
 * isolation depend on a provider-side naming rule and would not survive provider account limits.
 */
export interface ObjectStorageConfig {
  readonly bucket: string;
  readonly region: string;
  /** S3-compatible endpoint override, so a non-AWS compatible provider works without a code change (ADR-016). */
  readonly endpoint?: string;
}
