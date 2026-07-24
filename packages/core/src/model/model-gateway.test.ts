// @acbp/core — model gateway tests (ACBP-P2-003; ADR-011; CDR-026). Deterministic (fake provider, no DB, no
// network). Covers the contract (success + usage metering), fault injection (retry / re-ask / fallback
// eligibility / timeout / terminal), redaction (the seeded secret + raw provider errors never reach logs), and
// FAIL-CLOSED metering (a usage-write failure aborts the call and withholds the output).
import { describe, test, expect, vi } from 'vitest';
import { toModelId, type ModelGatewayRequest, type NewModelCallUsageEvent } from '@acbp/contracts';
import { FakeModelProvider, FAKE_INTERNAL_MARKER, type FakeProviderBehavior } from '@acbp/adapters';
import type { Logger } from '@acbp/observability';
import { callModel, type ModelGatewayDeps, type ResolvedProvider } from './model-gateway.js';

// A logger that records every call so tests can scan the full serialized output for leaks.
function recordingLogger() {
  const lines: { level: string; event: string; fields?: unknown }[] = [];
  const rec = (level: string) => (event: string, fields?: unknown) => { lines.push({ level, event, fields }); };
  const logger: Logger = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => logger, withComponent: () => logger };
  return { logger, lines, dump: () => JSON.stringify(lines) };
}

function provider(name: string, script: FakeProviderBehavior[] | FakeProviderBehavior): ResolvedProvider {
  const opts = Array.isArray(script) ? { script } : { behavior: script };
  return { name, modelId: toModelId(`${name}-model`), modelVersion: '2026-01-01', provider: new FakeModelProvider(opts) };
}

function request(over: Partial<ModelGatewayRequest> = {}): ModelGatewayRequest {
  return {
    taskClass: 'extraction',
    templateRef: 'tmpl/extract@1',
    contextParts: [{ role: 'user', content: 'hello' }],
    timeoutClass: 'interactive',
    companyId: 'company-1',
    accountId: 'account-1',
    correlationId: 'corr-1',
    ...over,
  };
}

function baseDeps(primary: ResolvedProvider, over: Partial<ModelGatewayDeps> = {}): { deps: ModelGatewayDeps; events: NewModelCallUsageEvent[] } {
  const events: NewModelCallUsageEvent[] = [];
  const deps: ModelGatewayDeps = {
    primary,
    recordUsage: (e) => { events.push(e); return Promise.resolve(); },
    estimateCost: ({ inputTokens, outputTokens }) => inputTokens * 2 + outputTokens * 3,
    sleep: () => Promise.resolve(), // no real backoff delay in tests
    now: () => 1000,
    ...over,
  };
  return { deps, events };
}

describe('callModel — contract + metering', () => {
  test('success returns validated output and writes exactly one ok usage event', async () => {
    const { deps, events } = baseDeps(provider('primary', { kind: 'respond', output: 'result', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }));
    const res = await callModel(deps, request());
    expect(res.outcome).toBe('ok');
    expect(res.validatedOutput).toBe('result');
    expect(res.provider).toBe('primary');
    expect(res.model).toBe('primary-model@2026-01-01');
    expect(res.fallbackUsed).toBe(false);
    expect(res.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    expect(res.estimatedCostMicros).toBe(10 * 2 + 4 * 3);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'model_call', outcome: 'ok', provider: 'primary', model: 'primary-model@2026-01-01', taskClass: 'extraction', fallbackUsed: false, correlationId: 'corr-1', estimatedCostMicros: 32 });
    expect(events[0]?.errorCategory).toBeUndefined();
  });

  test('schema-first bounded re-ask: invalid output is re-asked, then accepted', async () => {
    const prov = provider('primary', [{ kind: 'respond', output: 'bad' }, { kind: 'respond', output: 'good' }]);
    const { deps, events } = baseDeps(prov, { validateOutput: (_ref, out) => (out === 'good' ? { ok: true, value: { parsed: out } } : { ok: false }) });
    const res = await callModel(deps, request({ outputSchemaRef: 'schema/x@1' }));
    expect(res.outcome).toBe('ok');
    expect(res.validatedOutput).toEqual({ parsed: 'good' });
    expect((prov.provider as FakeModelProvider).callCount).toBe(2); // one re-ask
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('ok');
    // The single event meters BOTH attempts' tokens (the discarded bad output cost tokens too) — accumulation.
    expect(events[0]).toMatchObject({ inputTokens: 24, outputTokens: 16 });
    expect(res.tokenUsage).toEqual({ inputTokens: 24, outputTokens: 16, totalTokens: 40 });
  });

  test('re-ask is bounded: still-invalid after the cap → invalid_output', async () => {
    const prov = provider('primary', { kind: 'respond', output: 'bad' });
    const { deps, events } = baseDeps(prov, { validateOutput: () => ({ ok: false }) });
    const res = await callModel(deps, request({ outputSchemaRef: 'schema/x@1' }));
    expect(res.outcome).toBe('error');
    expect(res.errorCategory).toBe('invalid_output');
    expect((prov.provider as FakeModelProvider).callCount).toBe(2); // initial + 1 bounded re-ask
    // Both attempts returned a (bad) response, so BOTH consumed tokens — the single event meters the SUM
    // (2× the default fake usage 12/8), not zero and not just the last try (CDR-026 §5 accumulation).
    expect(events[0]).toMatchObject({ outcome: 'error', errorCategory: 'invalid_output', inputTokens: 24, outputTokens: 16, estimatedCostMicros: 24 * 2 + 16 * 3 });
  });
});

describe('callModel — fault injection (retry / fallback / timeout)', () => {
  test('bounded retry on a retryable error then success', async () => {
    const prov = provider('primary', [{ kind: 'fail', error: 'provider_unavailable' }, { kind: 'fail', error: 'rate_limited' }, { kind: 'respond', output: 'ok' }]);
    const { deps } = baseDeps(prov);
    const res = await callModel(deps, request());
    expect(res.outcome).toBe('ok');
    expect((prov.provider as FakeModelProvider).callCount).toBe(3); // 1 + 2 retries
    expect(res.fallbackUsed).toBe(false);
  });

  test('retry is bounded: exhausted retryable error → normalized error', async () => {
    const prov = provider('primary', { kind: 'fail', error: 'provider_unavailable' });
    const { deps, events } = baseDeps(prov);
    const res = await callModel(deps, request());
    expect(res.outcome).toBe('error');
    expect(res.errorCategory).toBe('provider_unavailable');
    expect((prov.provider as FakeModelProvider).callCount).toBe(3); // 1 + 2 retries
    expect(events[0]?.errorCategory).toBe('provider_unavailable');
  });

  test('terminal errors are not retried (content_refused)', async () => {
    const prov = provider('primary', { kind: 'fail', error: 'content_refused' });
    const { deps } = baseDeps(prov);
    const res = await callModel(deps, request());
    expect(res.outcome).toBe('error');
    expect(res.errorCategory).toBe('content_refused');
    expect((prov.provider as FakeModelProvider).callCount).toBe(1);
  });

  test('fallback fires for an ELIGIBLE task class on a retryable exhaustion', async () => {
    const primary = provider('primary', { kind: 'fail', error: 'provider_unavailable' });
    const fallback = provider('fallback', { kind: 'respond', output: 'from-fallback' });
    const { deps } = baseDeps(primary, { fallback });
    const res = await callModel(deps, request({ taskClass: 'extraction' }));
    expect(res.outcome).toBe('ok');
    expect(res.validatedOutput).toBe('from-fallback');
    expect(res.fallbackUsed).toBe(true);
    expect(res.provider).toBe('fallback');
    expect((fallback.provider as FakeModelProvider).callCount).toBe(1);
  });

  test('NO silent fallback for quality-bearing generation (ineligible): fallback is never called', async () => {
    const primary = provider('primary', { kind: 'fail', error: 'provider_unavailable' });
    const fallback = provider('fallback', { kind: 'respond', output: 'from-fallback' });
    const { deps } = baseDeps(primary, { fallback });
    const res = await callModel(deps, request({ taskClass: 'generation', timeoutClass: 'generation' }));
    expect(res.outcome).toBe('error');
    expect(res.errorCategory).toBe('provider_unavailable');
    expect(res.fallbackUsed).toBe(false);
    expect((fallback.provider as FakeModelProvider).callCount).toBe(0);
  });

  test('gateway enforces the per-class timeout when the provider hangs', async () => {
    const prov = provider('primary', { kind: 'hang', ms: 500 });
    const { deps } = baseDeps(prov, { config: { timeoutMs: { interactive: 15 }, maxRetries: 0 } });
    const res = await callModel(deps, request());
    expect(res.outcome).toBe('error');
    expect(res.errorCategory).toBe('timeout');
  });
});

describe('callModel — redaction (NFR-009)', () => {
  test('a seeded secret in the context is never written to logs', async () => {
    // A unique planted token (not shaped like a real key, so the repo secret scanner stays strict).
    const canary = 'PLANTED-CONTEXT-CANARY-abc123';
    const { logger, dump } = recordingLogger();
    const { deps } = baseDeps(provider('primary', { kind: 'respond', output: 'ok' }), { logger });
    await callModel(deps, request({ contextParts: [{ role: 'system', content: `context contains ${canary}` }, { role: 'user', content: 'go' }] }));
    expect(dump()).not.toContain(canary);
    expect(dump()).toContain('model.call_completed');
  });

  test('raw provider error text (incl. its internal marker) never reaches logs; only the normalized category', async () => {
    const { logger, dump } = recordingLogger();
    const { deps } = baseDeps(provider('primary', { kind: 'fail', error: 'internal' }), { logger, config: { maxRetries: 0 } });
    const res = await callModel(deps, request());
    expect(res.errorCategory).toBe('internal');
    expect(dump()).not.toContain(FAKE_INTERNAL_MARKER);
    expect(dump()).toContain('"errorCategory":"internal"');
  });
});

describe('callModel — fail-closed metering + policy pre-check', () => {
  test('a usage-write failure aborts the call and withholds the output', async () => {
    const { logger, dump } = recordingLogger();
    const deps: ModelGatewayDeps = baseDeps(provider('primary', { kind: 'respond', output: 'withheld-output' }), {
      logger,
      recordUsage: () => { throw new Error('db write failed: constraint xyz'); },
    }).deps;
    await expect(callModel(deps, request())).rejects.toThrow();
    // The raw DB error is not logged; a sanitized metering-failure marker is.
    expect(dump()).toContain('model.metering_failed');
    expect(dump()).not.toContain('constraint xyz');
    expect(dump()).not.toContain('withheld-output');
  });

  test('policy pre-check block → budget_exceeded, no provider call, no usage event', async () => {
    const prov = provider('primary', { kind: 'respond', output: 'ok' });
    const { deps, events } = baseDeps(prov, { policyPrecheck: () => ({ allowed: false }) });
    const res = await callModel(deps, request());
    expect(res.outcome).toBe('error');
    expect(res.errorCategory).toBe('budget_exceeded');
    expect((prov.provider as FakeModelProvider).callCount).toBe(0);
    expect(events).toHaveLength(0); // a caps block is not a call — nothing metered
  });

  test('policy pre-check allow → proceeds normally', async () => {
    const preCheck = vi.fn(() => ({ allowed: true as const }));
    const { deps, events } = baseDeps(provider('primary', { kind: 'respond', output: 'ok' }), { policyPrecheck: preCheck });
    const res = await callModel(deps, request());
    expect(res.outcome).toBe('ok');
    expect(preCheck).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
  });
});
