// @acbp/contracts — model-provider contract (ACBP-P0-019; ADR-011, ADR-019; NFR-019).
//
// This is the PROVIDER-FACING layer BENEATH the internal model gateway. Product modules call the
// gateway, never a model provider (ADR-011). Model selection, primary/fallback policy, prompt
// templates, schema validation, and metering live in the gateway/configuration — NOT here. This
// contract only expresses a single, already-resolved provider call. No provider SDK types, no
// routing, no automatic fallback. The provider request id is a diagnostic, never a domain identifier.
import type { AdapterCallOptions } from './common.js';

declare const modelIdBrand: unique symbol;
/** Provider-neutral model identifier. Bound to configuration (ADR-019) — never derived at runtime. */
export type ModelId = string & { readonly [modelIdBrand]: true };

export function toModelId(id: string): ModelId {
  return id as ModelId;
}

export type ModelRole = 'system' | 'user' | 'assistant';

export interface ModelMessage {
  readonly role: ModelRole;
  readonly content: string;
}

export interface ModelProviderRequest {
  readonly modelId: ModelId;
  readonly messages: readonly ModelMessage[];
  readonly maxOutputTokens?: number;
  /** Opaque, provider-neutral reference to the output schema the gateway will validate against. */
  readonly outputSchemaRef?: string;
}

/** Provider-neutral usage measurement (gateway meters cost from this). */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** Platform-owned finish states. Concrete providers map their own reasons onto these. */
export type ModelFinishStatus = 'completed' | 'length' | 'content_filtered' | 'refused' | 'error';

export interface ModelProviderResponse {
  readonly finishStatus: ModelFinishStatus;
  /** Raw text output; the gateway validates/parses it against the requested schema. */
  readonly output: string;
  readonly usage: ModelUsage;
  /** Provider-reported model version, stamped by the gateway onto calls/artifacts (ADR-011). */
  readonly modelVersion?: string;
  readonly latencyMs?: number;
  /** Provider request id — DIAGNOSTICS ONLY. Must never become a product/domain identifier. */
  readonly providerRequestId?: string;
}

export interface ModelProvider {
  /** Execute one resolved model call. Throws a normalized PlatformError on failure (no raw SDK errors). */
  generate(request: ModelProviderRequest, options?: AdapterCallOptions): Promise<ModelProviderResponse>;
}
