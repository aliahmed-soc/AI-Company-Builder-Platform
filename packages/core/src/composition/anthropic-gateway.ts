// @acbp/core/composition — the LIVE Anthropic model gateway (ACBP-API-006; CDR-091).
//
// This is the file CDR-090 §1 found missing: a search of the composition layer for `gateway` returned zero
// matches, because every shipped route was database-only and no composition ever built one.
//
// BOUNDARY. `@acbp/core` is the composition layer and MAY import `@acbp/adapters`; it must never import a
// provider SDK itself. `AnthropicModelProvider` is imported here as an already-built adapter — `@anthropic-ai/sdk`
// appears nowhere in this package, exactly as `@clerk/backend` does not.
import { AnthropicModelProvider, ANTHROPIC_PROVIDER_NAME } from '@acbp/adapters';
import { toModelId, type ModelGatewayRequest } from '@acbp/contracts';
import type { Secret } from '@acbp/config';
import type { DatabaseClient } from '@acbp/database';
import { createModelGateway, type BoundModelGateway, type ModelGatewayCompositionConfig } from './model-gateway.js';
import type { CostInput } from '../model/model-gateway.js';

export interface AnthropicGatewayConfig {
  readonly apiKey: Secret;
  /** Configuration-bound model id (ADR-019 — never derived at runtime). */
  readonly modelId: string;
  /** Everything `createModelGateway` accepts except the provider itself, which this function supplies. */
  readonly gateway?: Omit<ModelGatewayCompositionConfig, 'primary' | 'fallback' | 'estimateCost'> & {
    readonly estimateCost?: (input: CostInput) => number;
  };
}

/**
 * Published Anthropic list price for Claude Opus 5, in micro-units (millionths) of USD per token.
 *
 * $5.00 / 1M input tokens and $25.00 / 1M output tokens ⇒ 5 and 25 micro-units per token respectively.
 * These are ESTIMATE-lane numbers (ADR-013): they are what the platform records as expected spend, not an
 * invoice. They will drift when Anthropic changes pricing, which is why they are named constants with the
 * arithmetic shown rather than two bare integers inside a function.
 */
export const OPUS_5_INPUT_MICROS_PER_TOKEN = 5;
export const OPUS_5_OUTPUT_MICROS_PER_TOKEN = 25;

/** Integer micro-units. Truncated, never rounded up, and never a float — the usage column is an integer. */
export function estimateAnthropicCostMicros(input: CostInput): number {
  const raw = input.inputTokens * OPUS_5_INPUT_MICROS_PER_TOKEN + input.outputTokens * OPUS_5_OUTPUT_MICROS_PER_TOKEN;
  return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

/**
 * Build a model gateway bound to the LIVE Anthropic provider.
 *
 * NO FALLBACK PROVIDER is wired, and that is a decision rather than an omission: `TASK_CLASS_POLICY` marks
 * `generation` fallback-INELIGIBLE (ADR-019, no silent fallback for quality-bearing work), so a second provider
 * would be unreachable for exactly the calls this gateway exists to serve. Wiring one would create the
 * appearance of redundancy that the policy forbids using.
 */
export function createAnthropicGateway(client: DatabaseClient, config: AnthropicGatewayConfig): BoundModelGateway {
  const provider = new AnthropicModelProvider({ apiKey: config.apiKey });
  return createModelGateway(client, {
    ...(config.gateway ?? {}),
    primary: {
      name: ANTHROPIC_PROVIDER_NAME,
      modelId: toModelId(config.modelId),
      provider,
    },
    estimateCost: config.gateway?.estimateCost ?? estimateAnthropicCostMicros,
  });
}

/** Re-exported so a caller can type a request without reaching past the composition layer. */
export type { ModelGatewayRequest };
