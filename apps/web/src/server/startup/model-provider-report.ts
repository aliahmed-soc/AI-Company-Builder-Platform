// ACBP-API-012 — report model-provider misconfiguration, once, as a fact (CDR-090 §1-G3; CDR-091 §4; CDR-094 §7).
//
// WHAT THIS EXISTS TO FIX. `CDR-090 §1-G3` ruled that an absent or misconfigured `ANTHROPIC_API_KEY` must be a
// STARTUP-VISIBLE failure rather than a per-request surprise. Two comments claimed the property was delivered.
// It was not: `getClerkIdentityRuntime` is a lazy module singleton reached through a request-scoped
// `await import`, and no `instrumentation.ts` existed under `apps/web`, so the line first fired on whichever
// REQUEST happened to touch the runtime first. Starting the server told an operator nothing.
//
// This module is the single definition of that report. `instrumentation.ts` calls it at boot, which is what makes
// the failure visible before any request is served; `clerk-runtime.ts` calls it when composing, which is what
// gives that call site the parsed config. ONE definition, so the boot line and the composition line cannot drift
// into saying different things about the same condition.
//
// TWO PROPERTIES ARE LOAD-BEARING AND BOTH ARE TESTED RATHER THAN ASSERTED HERE:
//
//   FACT-ONLY. The payload carries a consequence and an unaffected scope, and never the parser's message — a
//   config error message can quote the offending value, and `ANTHROPIC_API_KEY` is the offending value.
//
//   NON-FATAL. This runtime serves every route in the application. A fatal model misconfiguration would take
//   down the 32 routes that never touch a model along with the 4 that do, so a misconfigured model provider
//   degrades generation and nothing else.
import { parseModelProviderConfig, type ModelProviderConfig } from '@acbp/config';

/** The event name, exported so callers and tests name it once rather than repeating a string literal. */
export const MODEL_PROVIDER_NOT_CONFIGURED_EVENT = 'model_provider.not_configured';

/** The narrow slice of a logger this needs. Declared structurally so a test can pass a spy. */
export interface ReportLogger {
  error(event: string, payload?: { metadata?: Record<string, unknown> }): void;
}

/**
 * The outcome, carrying the parsed config on success.
 *
 * A boolean would force `clerk-runtime.ts` to parse a second time, and two parses of the same environment are
 * two chances to disagree about it.
 */
export type ModelProviderReport =
  | { readonly state: 'configured'; readonly config: ModelProviderConfig }
  | { readonly state: 'not_configured' };

/**
 * Parse the model-provider configuration and, when it is absent or unparseable, say so exactly once.
 *
 * Returns rather than throws. See the NON-FATAL note in the file header: the caller is a runtime shared by every
 * route, so this reports a degraded capability, not a dead server.
 */
export function reportModelProviderConfiguration(options: {
  readonly env: Record<string, string | undefined>;
  readonly logger: ReportLogger;
}): ModelProviderReport {
  try {
    return { state: 'configured', config: parseModelProviderConfig(options.env) };
  } catch {
    // The caught error is deliberately NOT inspected, named, or forwarded. Its message is written for a
    // developer and can quote the value that failed validation.
    options.logger.error(MODEL_PROVIDER_NOT_CONFIGURED_EVENT, {
      metadata: {
        consequence: 'the four metered generate routes refuse with MODEL_GATEWAY_NOT_CONFIGURED',
        unaffected: 'every read route',
      },
    });
    return { state: 'not_configured' };
  }
}
