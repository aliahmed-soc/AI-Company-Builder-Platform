// @acbp/contracts — shared provider-adapter primitives (ACBP-P0-019).
//
// These are provider-NEUTRAL building blocks for the adapter contracts (identity, secrets, storage,
// model). They contain no provider SDK types, no framework types, no database types, and no runtime
// dependencies — `@acbp/contracts` is a zero-dependency leaf. Cancellation is expressed via a
// structural AbortSignalLike (a real AbortSignal is assignable) so the leaf needs no DOM/node lib.
import type { CorrelationContext } from '../correlation.js';

/** Minimal structural view of AbortSignal — keeps the contracts leaf free of DOM/node libs. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/**
 * Options common to every adapter call. All optional so contracts stay minimal:
 *  - `correlation` threads the P0-017 correlation context for redacted diagnostics.
 *  - `signal` supports cancellation of long-running operations.
 *  - `timeoutMs` expresses the caller's timeout expectation (the implementation enforces it).
 */
export interface AdapterCallOptions {
  readonly correlation?: CorrelationContext;
  readonly signal?: AbortSignalLike;
  readonly timeoutMs?: number;
}

/**
 * Optional lifecycle for adapters that need explicit startup/shutdown (e.g., pooled clients).
 * Implementations that need neither may omit both; callers must not assume either exists.
 */
export interface AdapterLifecycle {
  init?(options?: AdapterCallOptions): Promise<void>;
  shutdown?(options?: AdapterCallOptions): Promise<void>;
}
