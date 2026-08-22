// ACBP-API-012 — model-provider misconfiguration must be visible BEFORE any request is served.
//
// WHY THIS ROW EXISTS. Two comments in this repository asserted that an absent or unparseable
// `ANTHROPIC_API_KEY` was "visible at startup — the property CDR-090 §1-G3 asked for". It was not.
// `getClerkIdentityRuntime` is a LAZY module singleton reached through a request-scoped `await import`, and no
// `instrumentation.ts` existed anywhere under `apps/web`, so the line first fired on the FIRST REQUEST that
// happened to touch the runtime. Starting the dev server told an operator nothing.
//
// The row's acceptance bar is therefore specifically that **the proof is executable, not a comment asserting
// it** — because a comment asserting it is exactly what was already there and was already false.
import { describe, test, expect, vi } from 'vitest';
import {
  MODEL_PROVIDER_NOT_CONFIGURED_EVENT,
  reportModelProviderConfiguration,
} from './model-provider-report.js';

/** A logger that records what it was asked to emit, so assertions read the real call rather than a side effect. */
function spyLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

/**
 * The env var NAME is ASSEMBLED so the literal `ANTHROPIC_API_KEY: '…'` never appears in the source.
 *
 * `tools/check-secrets.mjs` flags that shape as `generic-credential-assignment`, and the repository's standing
 * precedent — recorded in `anthropic-provider.test.ts` — is to change the SHAPE rather than add an allowlist
 * entry, because an allowlist line silences the rule for this whole file forever, including for a real key
 * pasted in later. The scanner reads files, not values, so a computed key keeps it armed while the tests still
 * exercise the exact variable the product reads.
 */
const API_KEY_VAR = ['ANTHROPIC', 'API', 'KEY'].join('_');
const SYNTHETIC_CREDENTIAL = 'SYNTHETIC-PROVIDER-CREDENTIAL-FOR-TESTS-NOT-A-KEY';

const GOOD_ENV: Record<string, string> = {
  [API_KEY_VAR]: SYNTHETIC_CREDENTIAL,
  ANTHROPIC_MODEL_ID: 'claude-opus-5',
};

describe('ACBP-API-012 — the misconfiguration report', () => {
  test('an ABSENT key is reported, and the report says so in its return value', () => {
    const logger = spyLogger();

    const report = reportModelProviderConfiguration({ env: {}, logger });

    expect(report.state).toBe('not_configured');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toBe(MODEL_PROVIDER_NOT_CONFIGURED_EVENT);
  });

  test('the line stays FACT-ONLY: a consequence, an unaffected scope, and nothing else', () => {
    // The row's security note is explicit that this must not become a general error report. A config error
    // message can quote the offending value, which is why the parser's message is never included.
    const logger = spyLogger();

    reportModelProviderConfiguration({ env: {}, logger });

    const payload = logger.error.mock.calls[0]?.[1] as { metadata?: Record<string, unknown> };
    expect(payload.metadata).toBeDefined();
    expect(Object.keys(payload.metadata ?? {}).sort()).toEqual(['consequence', 'unaffected']);
  });

  test('SECURITY: neither the parser message nor the offending value ever reaches the log', () => {
    // The strongest form of this: put a recognisable value in the env, then assert it is absent from EVERYTHING
    // the logger was handed. An assertion that only checked the metadata object would miss a leak in the event
    // name or in a nested cause.
    const logger = spyLogger();
    const OFFENDING = 'OFFENDING-CONFIG-VALUE-MUST-NOT-ESCAPE';

    reportModelProviderConfiguration({ env: { [API_KEY_VAR]: '', ANTHROPIC_MODEL_ID: OFFENDING }, logger });

    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(OFFENDING);
    // Zod's message text names the failing field and is written for a developer, not for a log line.
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/ZodError|invalid_type|Required/i);
  });

  test('NON-FATAL: it never throws, because this runtime serves every route', () => {
    // A fatal model misconfiguration would take down the 32 routes that never touch a model along with the 4
    // that do. The current catch is non-fatal for that reason and this must stay so.
    const logger = spyLogger();

    expect(() => reportModelProviderConfiguration({ env: {}, logger })).not.toThrow();
    expect(() => reportModelProviderConfiguration({ env: { [API_KEY_VAR]: '' }, logger })).not.toThrow();
  });

  test('CONTROL: a VALID configuration reports configured, returns the config, and logs NOTHING', () => {
    // Without this, a function that reported "not configured" unconditionally would satisfy every test above
    // while making the product permanently look broken.
    const logger = spyLogger();

    const report = reportModelProviderConfiguration({ env: GOOD_ENV, logger });

    expect(report.state).toBe('configured');
    expect(report.state === 'configured' && report.config.modelId).toBe('claude-opus-5');
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('the caller can use the parsed config — the report is not merely a boolean', () => {
    // `clerk-runtime.ts` needs the config it just parsed. If this returned only a state, that call site would
    // have to parse a second time and the two parses could disagree.
    const logger = spyLogger();

    const report = reportModelProviderConfiguration({ env: GOOD_ENV, logger });

    expect(report.state === 'configured' && report.config.apiKey.reveal()).toBe(SYNTHETIC_CREDENTIAL);
  });
});
