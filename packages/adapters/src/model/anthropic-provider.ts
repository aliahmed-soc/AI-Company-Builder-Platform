// @acbp/adapters — the LIVE Anthropic model provider (ACBP-API-006; CDR-091; ADR-011 §5).
//
// This is the first `ModelProvider` in this repository that costs money. It maps ONE already-resolved model call
// onto the Anthropic Messages API and maps the response back onto the platform's provider-neutral shape.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO. Retry, re-ask, fallback, timeout policy, cost estimation and usage
// metering all belong to `callModel` in `@acbp/core` and are NOT duplicated here. A provider that retried on its
// own would be invisible to the gateway's accounting — see the `maxRetries` note below, which is the single most
// important line in this file.
//
// `@acbp/adapters` is the only package permitted to hold a provider SDK, the same rule that confines
// `@clerk/backend`. Nothing above this layer may import `@anthropic-ai/sdk`.
import Anthropic from '@anthropic-ai/sdk';
import type { Secret } from '@acbp/config';
import {
  PlatformError,
  ErrorCodes,
  type AdapterCallOptions,
  type ModelFinishStatus,
  type ModelProvider,
  type ModelProviderRequest,
  type ModelProviderResponse,
  type ModelUsage,
} from '@acbp/contracts';

/** Bounded, non-secret provider family name. Stamped onto usage events and artifacts. */
export const ANTHROPIC_PROVIDER_NAME = 'anthropic';

/**
 * The PROVIDER CLIENT's deadline (CDR-091 §2.1) — the INNER bound.
 *
 * It must stay strictly below the gateway's own generation-class deadline (`TIMEOUT_CLASS_MS.generation`, 120s).
 * If it ever exceeded it, the gateway's `withTimeout` would always fire first and this abort would be dead code —
 * a silent inversion. `anthropic-provider.test.ts` asserts the ordering rather than trusting this comment.
 */
export const ANTHROPIC_CLIENT_TIMEOUT_MS = 60_000;

/** The narrow slice of the SDK this adapter uses. Declared structurally so tests can inject a stub. */
export interface AnthropicMessagesClient {
  readonly messages: {
    create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };
}

export interface AnthropicProviderOptions {
  readonly apiKey: Secret;
  /** A pre-built client (tests). When present, `clientFactory` and the real SDK are not used. */
  readonly client?: AnthropicMessagesClient;
  /** Constructs the client from the resolved options — the seam the maxRetries guard inspects. */
  readonly clientFactory?: (options: Record<string, unknown>) => AnthropicMessagesClient;
  readonly timeoutMs?: number;
}

/** Anthropic `stop_reason` → the platform's finish states. An unrecognised reason is an ERROR, never a success. */
function toFinishStatus(stopReason: unknown): ModelFinishStatus {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
      return 'completed';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'refused';
    default:
      // Includes `null` (which the API uses while streaming) and anything added by a future API version.
      // Mapping an unknown reason to `completed` would let a partial or declined answer be persisted as a real
      // one; `error` is the only safe default, and the gateway already knows what to do with it.
      return 'error';
  }
}

/**
 * Concatenate the TEXT blocks only.
 *
 * `thinking` blocks are deliberately excluded: they are the model's reasoning, not its answer, and letting them
 * into `output` would put reasoning into persisted artifacts and into schema validation.
 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
}

function usageOf(usage: unknown): ModelUsage {
  const u = (typeof usage === 'object' && usage !== null ? usage : {}) as Record<string, unknown>;
  const inputTokens = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : 0;
  const outputTokens = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/**
 * Normalize any thrown SDK value into a `PlatformError`.
 *
 * The raw provider text is attached as the INTERNAL message (operator logs) and never as the user message — the
 * gateway re-normalizes this into its seven-category taxonomy and its redaction tests prove neither the internal
 * text nor the credential reaches a client.
 */
function normalizeSdkError(err: unknown): PlatformError {
  const status = typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : undefined;
  const internalMessage = err instanceof Error ? err.message : 'anthropic provider failure';
  const cause = err instanceof Error ? { cause: err } : {};

  if (status === 429) return new PlatformError('limit_exceeded', { code: ErrorCodes.RATE_LIMIT_EXCEEDED, internalMessage, ...cause });
  if (status === 408) return new PlatformError('provider_unavailable', { code: ErrorCodes.DEPENDENCY_TIMEOUT, internalMessage, ...cause });
  if (status !== undefined && status >= 500) return new PlatformError('provider_unavailable', { code: ErrorCodes.DEPENDENCY_UNAVAILABLE, internalMessage, ...cause });
  // A connection/abort failure carries no status. Treat it as a timeout so the gateway's bounded retry can act:
  // classifying it `internal` would make a transient network blip permanently fatal for the call.
  if (status === undefined && err instanceof Error && /abort|timeout|ECONN|socket/i.test(err.name + err.message)) {
    return new PlatformError('provider_unavailable', { code: ErrorCodes.DEPENDENCY_TIMEOUT, internalMessage, ...cause });
  }
  // 401/403 land here on purpose: a bad credential is OUR configuration defect, not a transient provider fault,
  // and must NOT be retried against a paid endpoint.
  return new PlatformError('internal', { internalMessage, ...cause });
}

export class AnthropicModelProvider implements ModelProvider {
  readonly #client: AnthropicMessagesClient;
  readonly #timeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    this.#timeoutMs = options.timeoutMs ?? ANTHROPIC_CLIENT_TIMEOUT_MS;

    if (options.client !== undefined) {
      this.#client = options.client;
      return;
    }

    // ── THE MONEY GUARD (CDR-091 §3.4) ──────────────────────────────────────────────────────────────────────
    // `maxRetries: 0` is NOT a default being restated — the SDK's own default is 2, and leaving it would put a
    // third retry layer INSIDE `generate()` where the gateway cannot see it. The gateway would then record one
    // usage event carrying only the final attempt's tokens while the provider billed every attempt, and the two
    // layers would multiply: 3 SDK attempts x 3 gateway attempts = up to NINE paid calls for one generation.
    // The gateway's bounded retry is the only retry layer in this system. Enforced by test, not by this comment.
    const clientOptions: Record<string, unknown> = {
      apiKey: options.apiKey.reveal(),
      maxRetries: 0,
      timeout: this.#timeoutMs,
    };
    this.#client = options.clientFactory !== undefined ? options.clientFactory(clientOptions) : (new Anthropic(clientOptions) as unknown as AnthropicMessagesClient);
  }

  async generate(request: ModelProviderRequest, options?: AdapterCallOptions): Promise<ModelProviderResponse> {
    // The Messages API takes the system prompt as a TOP-LEVEL parameter; a `system` role inside `messages` is
    // rejected with a 400. Splitting here rather than at the call site keeps every caller provider-neutral.
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));

    const params: Record<string, unknown> = {
      model: String(request.modelId),
      // `max_tokens` is REQUIRED by the Messages API. The gateway's budget is the source when it supplies one;
      // 16000 is the skill-documented non-streaming default that stays under SDK HTTP timeouts.
      max_tokens: request.maxOutputTokens ?? 16_000,
      messages: turns,
      ...(system !== '' ? { system } : {}),
      // Stated explicitly rather than relying on a per-model default: thinking is on by default on Opus 5 but was
      // OFF by default one model generation earlier, so an implicit default would silently change behaviour on a
      // model swap. `budget_tokens` is deliberately absent — it is rejected with a 400 on this model family.
      thinking: { type: 'adaptive' },
    };

    const started = Date.now();
    let raw: unknown;
    try {
      raw = await this.#client.messages.create(params, {
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        timeout: options?.timeoutMs ?? this.#timeoutMs,
      });
    } catch (err) {
      throw normalizeSdkError(err);
    }

    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const finishStatus = toFinishStatus(body['stop_reason']);
    // On a refusal the API may still carry a `stop_details.explanation`. It is NEVER mapped into `output`: that
    // string is provider-authored prose about why a request was declined, and CDR-088 §2.1a is this repository's
    // precedent for how easily such a value reaches a client when nobody names the hazard.
    const output = finishStatus === 'refused' ? '' : textOf(body['content']);
    const modelVersion = typeof body['model'] === 'string' ? body['model'] : undefined;
    const providerRequestId = typeof body['id'] === 'string' ? body['id'] : undefined;

    return {
      finishStatus,
      output,
      usage: usageOf(body['usage']),
      ...(modelVersion !== undefined ? { modelVersion } : {}),
      latencyMs: Math.max(0, Date.now() - started),
      // Diagnostics only — the contract forbids this ever becoming a domain identifier.
      ...(providerRequestId !== undefined ? { providerRequestId } : {}),
    };
  }
}
