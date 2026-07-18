// @acbp/contracts — object-storage contract (ACBP-P0-019; portability direction of ADR-016).
//
// Provider-neutral only. ACBP-P0-005 (object-storage provider selection) remains owner-BLOCKED, so
// this contract selects NO vendor: there is no bucket type, no vendor URL type, no SDK object, and
// no presigned-URL abstraction (deferred until a provider is chosen and canonical scope requires it).
// Objects are addressed by an opaque key. Access is never public by default. When tenant-owned
// objects are introduced later, the caller must make tenant ownership explicit in the key (e.g., a
// `company/{id}/…` prefix per DATA-ARCHITECTURE §2.8); this contract never derives cross-tenant keys.
import type { AdapterCallOptions } from './common.js';

declare const objectKeyBrand: unique symbol;
/** Opaque object key. Tenant scoping is the caller's explicit responsibility — never auto-derived here. */
export type ObjectKey = string & { readonly [objectKeyBrand]: true };

export function toObjectKey(key: string): ObjectKey {
  return key as ObjectKey;
}

export interface ChecksumMetadata {
  readonly algorithm: 'sha256' | 'crc32c' | 'md5';
  readonly value: string;
}

export interface ObjectMetadata {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksum?: ChecksumMetadata;
}

/** A body is either bytes or a controlled read stream (AsyncIterable) — no DOM/vendor stream types. */
export type ObjectBody = Uint8Array | AsyncIterable<Uint8Array>;

export interface PutObjectInput {
  readonly key: ObjectKey;
  readonly body: ObjectBody;
  readonly contentType: string;
  readonly checksum?: ChecksumMetadata;
}

export interface GetObjectResult {
  readonly metadata: ObjectMetadata;
  readonly body: ObjectBody;
}

export type HeadObjectResult =
  | { readonly exists: true; readonly metadata: ObjectMetadata }
  | { readonly exists: false };

export interface ObjectStorage {
  put(input: PutObjectInput, options?: AdapterCallOptions): Promise<ObjectMetadata>;
  get(key: ObjectKey, options?: AdapterCallOptions): Promise<GetObjectResult>;
  delete(key: ObjectKey, options?: AdapterCallOptions): Promise<void>;
  head(key: ObjectKey, options?: AdapterCallOptions): Promise<HeadObjectResult>;
}
