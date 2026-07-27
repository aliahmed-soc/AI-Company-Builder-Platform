// ACBP-P5-009 / CDR-047 §4 — the SILENT-FALLBACK negative suite (NFR-019; trust-critical #19).
//
// The backlog names "silent-fallback negative tests", not fallback tests, and the distinction is the whole point: a
// suite that only proved eligible classes DO fall back would pass on a gateway that silently downgraded everything.
// The decisive assertion here is that an INELIGIBLE class does NOT fall over even when a fallback is configured and
// the primary fails retryably — paired with an eligible-class control, so the negative cannot pass because the
// fallback path is simply broken.
//
// A unit suite: `callModel` takes both providers, the usage sink and the cost estimator by injection, so this runs
// locally with no database.
import { describe, test, expect } from 'vitest';
import { toModelId, type ModelGatewayRequest, type NewModelCallUsageEvent, type TaskClass } from '@acbp/contracts';
import { FakeModelProvider } from '@acbp/adapters';
import { callModel, type ModelGatewayDeps, type ResolvedProvider } from './model-gateway.js';

const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

/** A provider that always fails with a RETRYABLE infrastructure error — the only thing that can trigger a fallover. */
function failingProvider(name: string): { readonly resolved: ResolvedProvider; readonly fake: FakeModelProvider } {
  const fake = new FakeModelProvider({ behavior: { kind: 'fail', error: 'provider_unavailable' } });
  return { resolved: { name, modelId: toModelId(`${name}-model`), modelVersion: 'v1', provider: fake }, fake };
}
/** A healthy secondary, so a fallover would visibly succeed if one were allowed to happen. */
function healthyProvider(name: string): { readonly resolved: ResolvedProvider; readonly fake: FakeModelProvider } {
  const fake = new FakeModelProvider({ behavior: { kind: 'respond', output: 'secondary answered' } });
  return { resolved: { name, modelId: toModelId(`${name}-model`), modelVersion: 'v1', provider: fake }, fake };
}

interface Harness {
  readonly deps: ModelGatewayDeps;
  readonly primary: FakeModelProvider;
  readonly secondary: FakeModelProvider;
  readonly events: NewModelCallUsageEvent[];
}

/** Primary always fails retryably; a healthy fallback IS configured. Whether it is used is what each test asserts. */
function harness(): Harness {
  const p = failingProvider('primary');
  const s = healthyProvider('secondary');
  const events: NewModelCallUsageEvent[] = [];
  const deps: ModelGatewayDeps = {
    primary: p.resolved,
    fallback: s.resolved,
    recordUsage: async (e) => {
      await Promise.resolve();
      events.push(e);
    },
    estimateCost,
    sleep: async () => {
      await Promise.resolve();
    },
    config: { maxRetries: 1, maxReask: 0, backoffBaseMs: 1 },
  };
  return { deps, primary: p.fake, secondary: s.fake, events };
}

const requestFor = (taskClass: TaskClass): ModelGatewayRequest => ({
  taskClass,
  timeoutClass: taskClass === 'generation' ? 'generation' : 'interactive',
  templateRef: 'test.template@1',
  contextParts: [{ role: 'user', content: 'go' }],
  companyId: '00000000-0000-0000-0000-0000000000c0',
  accountId: '00000000-0000-0000-0000-0000000000a0',
});

describe('silent-fallback negatives (ACBP-P5-009; NFR-019; trust-critical #19)', () => {
  test('a MATERIAL decision does NOT silently fall over — generation fails on the primary', async () => {
    // THE decisive test. `generation` is quality-bearing: a founder's strategy or plan must not be produced by a
    // different model than the one that was chosen, without anybody being told. A configured, healthy fallback must
    // sit unused.
    const h = harness();
    const r = await callModel(h.deps, requestFor('generation'));

    expect(r.outcome).toBe('error');
    expect(r.fallbackUsed).toBe(false);
    expect(h.secondary.callCount).toBe(0);
    // …and the answer is NOT the secondary's, which is what "silent" would look like.
    expect(r.validatedOutput).toBeUndefined();
  });

  test('CONTROL: an eligible class DOES fall over on the same configuration', async () => {
    // Without this, the negative above passes just as well on a gateway whose fallback path is simply broken —
    // proving nothing about eligibility. Same harness, same failing primary, only the task class differs.
    const h = harness();
    const r = await callModel(h.deps, requestFor('interactive'));

    expect(r.outcome).toBe('ok');
    expect(r.fallbackUsed).toBe(true);
    expect(h.secondary.callCount).toBeGreaterThan(0);
    expect(r.validatedOutput).toBe('secondary answered');
  });

  test('the fallover records WHY, using the normalized category and never provider text', async () => {
    const h = harness();
    await callModel(h.deps, requestFor('interactive'));

    expect(h.events).toHaveLength(1);
    const event = h.events[0]!;
    expect(event.fallbackUsed).toBe(true);
    // The PRIMARY's terminal category — what actually triggered the fallover, not the secondary's outcome.
    expect(event.fallbackReason).toBe('provider_unavailable');
    // The ledger is retained for the billing lifetime; an unbounded vendor string must never reach it.
    expect(JSON.stringify(event)).not.toContain('SECRET');
  });

  test('a call that never fell over records NO reason — the pair cannot contradict itself', async () => {
    // Mirrors the database CHECK: a reason must never appear without a fallover. A row claiming it did not fall back
    // while naming why it did is worse than no row, because it looks authoritative.
    const h = harness();
    await callModel(h.deps, requestFor('generation'));

    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.fallbackUsed).toBe(false);
    expect(h.events[0]!.fallbackReason).toBeUndefined();
  });

  test('a material decision that fails, fails HONESTLY — the caller sees the primary error (invariant 20)', async () => {
    // User-facing status is always truthful. A refused fallover must surface as a real failure, never as a
    // quietly-degraded success, and the error must be the normalized category rather than raw provider text.
    const h = harness();
    const r = await callModel(h.deps, requestFor('generation'));

    expect(r.outcome).toBe('error');
    expect(r.errorCategory).toBe('provider_unavailable');
    expect(r.provider).toBe('primary');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  test('with NO fallback configured, an eligible class still fails cleanly rather than hanging or half-succeeding', async () => {
    const h = harness();
    const { fallback: _unused, ...withoutFallback } = h.deps;
    const r = await callModel(withoutFallback, requestFor('interactive'));

    expect(r.outcome).toBe('error');
    expect(r.fallbackUsed).toBe(false);
    expect(r.errorCategory).toBe('provider_unavailable');
  });
});
