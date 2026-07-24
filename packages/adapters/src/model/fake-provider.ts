// @acbp/adapters — deterministic FAKE model provider (ACBP-P2-003; CDR-026 §3; ADR-011).
//
// The ONLY model provider wired in P2-003. It implements the provider-facing `ModelProvider` contract with
// NO network, NO SDK, NO credentials — every result is scripted, so the gateway's contract, fault-injection,
// and redaction behaviour can be proven deterministically. The concrete OpenAI/Anthropic adapters + any live
// call are a DEFERRED owner gate (CDR-026 §0) and are NOT built here.
//
// It is programmable two ways: a single fixed `behavior`, or a `script` consumed one-per-call (the last entry
// repeats) so a test can drive retry / re-ask / fallback sequences. Failures throw a NORMALIZED PlatformError
// (the contract's rule — no raw SDK errors); the internal message deliberately carries a sensitive-looking
// marker so the redaction tests can prove the gateway never logs or returns it.
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

/** The normalized failure kinds the fake can inject (each maps to a PlatformError the gateway re-normalizes). */
export type FakeFailure = 'timeout' | 'rate_limited' | 'provider_unavailable' | 'content_refused' | 'internal';

export type FakeProviderBehavior =
  | { readonly kind: 'respond'; readonly output: string; readonly finishStatus?: ModelFinishStatus; readonly usage?: Partial<ModelUsage>; readonly modelVersion?: string }
  // Throws a normalized PlatformError (the internal message carries SECRET_MARKER for the redaction tests).
  | { readonly kind: 'fail'; readonly error: FakeFailure }
  // Resolves late (or rejects early when the caller aborts) — drives the gateway's own timeout enforcement.
  | { readonly kind: 'hang'; readonly ms: number };

/** A unique token embedded in every fake failure's INTERNAL (log-only) message — must never surface in logs/output.
 *  Deliberately NOT shaped like a real key, so the repo secret scanner stays strict while the redaction tests can
 *  still assert the gateway never leaks internal provider-error text. */
export const FAKE_INTERNAL_MARKER = 'PLANTED-INTERNAL-MARKER-9f8e7d6c';

export interface FakeProviderOptions {
  readonly behavior?: FakeProviderBehavior;
  readonly script?: readonly FakeProviderBehavior[];
  readonly defaultUsage?: ModelUsage;
}

const DEFAULT_USAGE: ModelUsage = { inputTokens: 12, outputTokens: 8, totalTokens: 20 };

function failureToError(f: FakeFailure): PlatformError {
  const internalMessage = `fake provider failure=${f} ${FAKE_INTERNAL_MARKER}`;
  switch (f) {
    case 'timeout':
      return new PlatformError('provider_unavailable', { code: ErrorCodes.DEPENDENCY_TIMEOUT, internalMessage });
    case 'rate_limited':
      return new PlatformError('limit_exceeded', { code: ErrorCodes.RATE_LIMIT_EXCEEDED, internalMessage });
    case 'provider_unavailable':
      return new PlatformError('provider_unavailable', { code: ErrorCodes.DEPENDENCY_UNAVAILABLE, internalMessage });
    case 'content_refused':
      return new PlatformError('policy_blocked', { internalMessage });
    case 'internal':
      return new PlatformError('internal', { internalMessage });
  }
}

/**
 * A deterministic, controllable `ModelProvider`. Records every request it received (`calls`) and how many times
 * it was invoked (`callCount`) so tests can assert retry/re-ask/fallback behaviour.
 */
export class FakeModelProvider implements ModelProvider {
  readonly #script: readonly FakeProviderBehavior[];
  readonly #defaultUsage: ModelUsage;
  readonly #calls: ModelProviderRequest[] = [];
  #index = 0;

  constructor(options: FakeProviderOptions = {}) {
    if (options.script !== undefined && options.script.length > 0) this.#script = options.script;
    else if (options.behavior !== undefined) this.#script = [options.behavior];
    else this.#script = [{ kind: 'respond', output: 'ok' }];
    this.#defaultUsage = options.defaultUsage ?? DEFAULT_USAGE;
  }

  get callCount(): number {
    return this.#index;
  }
  get calls(): readonly ModelProviderRequest[] {
    return this.#calls;
  }

  async generate(request: ModelProviderRequest, options?: AdapterCallOptions): Promise<ModelProviderResponse> {
    const behavior = this.#script[Math.min(this.#index, this.#script.length - 1)]!;
    this.#index += 1;
    this.#calls.push(request);

    if (behavior.kind === 'fail') throw failureToError(behavior.error);

    if (behavior.kind === 'hang') {
      await new Promise<void>((resolve, reject) => {
        const signal = options?.signal;
        const timer = setTimeout(resolve, behavior.ms);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            reject(new PlatformError('provider_unavailable', { code: ErrorCodes.DEPENDENCY_TIMEOUT, internalMessage: `fake hang aborted ${FAKE_INTERNAL_MARKER}` }));
            return;
          }
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new PlatformError('provider_unavailable', { code: ErrorCodes.DEPENDENCY_TIMEOUT, internalMessage: `fake hang aborted ${FAKE_INTERNAL_MARKER}` }));
          });
        }
      });
      // If it was NOT aborted, fall through to a normal response.
    }

    const usage: ModelUsage = behavior.kind === 'respond' && behavior.usage !== undefined ? { ...this.#defaultUsage, ...behavior.usage } : this.#defaultUsage;
    const output = behavior.kind === 'respond' ? behavior.output : 'ok';
    const finishStatus: ModelFinishStatus = behavior.kind === 'respond' && behavior.finishStatus !== undefined ? behavior.finishStatus : 'completed';
    const modelVersion = behavior.kind === 'respond' ? behavior.modelVersion : undefined;
    return {
      finishStatus,
      output,
      usage,
      ...(modelVersion !== undefined ? { modelVersion } : {}),
    };
  }
}
