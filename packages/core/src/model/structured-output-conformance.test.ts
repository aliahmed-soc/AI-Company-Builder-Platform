// ACBP-P5-010 / CDR-046 — the structured-output CONFORMANCE suite (NFR-007; trust-critical #18 groundwork).
//
// CDR-046 §2 records the load-bearing finding: every mechanical clause of this ticket's Objective is ALREADY
// implemented by P2-003/CDR-026. So this suite does not build a second validation path — it PINS the behaviour of
// the one that exists, as behaviour rather than as implementation, so a refactor that preserves the guarantees
// passes and one that quietly drops a bound fails.
//
// A pure unit suite: `callModel` takes its provider, usage sink, cost estimator and validator by injection, so no
// database is involved and the whole thing runs locally. That matters — the properties below are the ones a future
// change is most likely to break, and a test that only runs in CI is a test that gets discovered late.
import { describe, test, expect } from 'vitest';
import { toModelId, MAX_REASK_ATTEMPTS, type ModelGatewayRequest, type NewModelCallUsageEvent } from '@acbp/contracts';
import { FakeModelProvider } from '@acbp/adapters';
import { callModel, type ModelGatewayDeps, type ResolvedProvider } from './model-gateway.js';

const SCHEMA_REF = 'test.output@1';
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

/** A provider that always answers with the same (structurally invalid) body. */
function invalidProvider(): { readonly resolved: ResolvedProvider; readonly fake: FakeModelProvider } {
  const fake = new FakeModelProvider({ behavior: { kind: 'respond', output: 'not-json-at-all' } });
  return { resolved: { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: fake }, fake };
}

/** A validator that accepts only exactly-valid JSON with an `ok` field — everything else fails closed. */
const validateOutput = (_ref: string, output: string) => {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) return { ok: true as const, value: parsed };
    return { ok: false as const };
  } catch {
    return { ok: false as const };
  }
};

interface Harness {
  readonly deps: ModelGatewayDeps;
  readonly fake: FakeModelProvider;
  readonly events: NewModelCallUsageEvent[];
}

function harness(over: { maxReask?: number; maxRetries?: number; recordUsage?: (e: NewModelCallUsageEvent) => Promise<void> } = {}): Harness {
  const { resolved, fake } = invalidProvider();
  const events: NewModelCallUsageEvent[] = [];
  const recordUsage =
    over.recordUsage ??
    (async (e: NewModelCallUsageEvent): Promise<void> => {
      await Promise.resolve();
      events.push(e);
    });
  const deps: ModelGatewayDeps = {
    primary: resolved,
    recordUsage,
    estimateCost,
    validateOutput,
    // `sleep` is stubbed so a retry path cannot make the suite slow — the bound is what is under test, not the wait.
    sleep: async () => {
      await Promise.resolve();
    },
    config: { maxReask: over.maxReask ?? 1, maxRetries: over.maxRetries ?? 2, backoffBaseMs: 1 },
  };
  return { deps, fake, events };
}

/**
 * The free-text request is the BASE and the structured one is derived from it, rather than the two being written out
 * side by side. Written separately they can drift — and the drift would be invisible, because the whole point of the
 * opt-in test is that it differs from `request` in exactly one way. Deriving makes "exactly one way" structural.
 *
 * The schema key is ADDED rather than set to `undefined` on a copy: the repo runs `exactOptionalPropertyTypes`,
 * under which absent and `undefined` are different things, and "the caller supplied no schema" is the case under
 * test. Spreading an explicit `undefined` does not compile, which is that setting doing its job.
 *
 * `extraction` is a structured-output task class, which is the case this suite is about.
 */
const freeTextRequest: ModelGatewayRequest = {
  taskClass: 'extraction',
  timeoutClass: 'interactive',
  templateRef: 'test.template@1',
  contextParts: [{ role: 'user', content: 'go' }],
  companyId: '00000000-0000-0000-0000-0000000000c0',
  accountId: '00000000-0000-0000-0000-0000000000a0',
};
/** The same call, now asking for a validated structured output. */
const request: ModelGatewayRequest = { ...freeTextRequest, outputSchemaRef: SCHEMA_REF };

describe('structured-output conformance (ACBP-P5-010; NFR-007) — the guarantees P2-003 already implements', () => {
  test('an invalid output is RE-ASKED, not retried — the two budgets are not interchangeable', async () => {
    // Retry is for infrastructure; re-ask is for the model. Conflating them either burns a retry on a deterministic
    // failure or re-asks a timeout. With re-ask 1 and retries 2, a persistently-invalid model must be called exactly
    // twice — if `invalid_output` were retryable it would be called four times.
    const { deps, fake } = harness({ maxReask: 1, maxRetries: 2 });
    const r = await callModel(deps, request);
    expect(r.outcome).toBe('error');
    expect(fake.callCount).toBe(2);
  });

  test('the re-ask bound is honoured EXACTLY within the platform maximum', async () => {
    // The platform caps re-ask at ONE (CDR-026 §1, "re-ask ≤ 1"), so `maxReask = N` means `N + 1` calls only while N
    // is inside that cap. Asserting `N + 1` for an arbitrary N would be asserting the ABSENCE of the cap — which is
    // the opposite of NFR-007, and is how the first draft of this test failed: it expected 4 calls for maxReask=3
    // and got 2, because the clamp was doing its job.
    for (let n = 0; n <= MAX_REASK_ATTEMPTS; n += 1) {
      const { deps, fake } = harness({ maxReask: n, maxRetries: 0 });
      await callModel(deps, request);
      expect(fake.callCount, `maxReask=${n}`).toBe(n + 1);
    }
  });

  test('a caller CANNOT unbound the re-ask budget through configuration (NFR-007: no unlimited retries)', async () => {
    // The bound is a platform guarantee, not a caller's choice. A huge value clamps to the platform maximum, and a
    // negative one clamps to zero rather than wrapping into an unbounded loop.
    // 10_000 must NOT mean 10_001 calls. It clamps to the platform maximum ⇒ MAX_REASK_ATTEMPTS + 1 calls total.
    // DERIVED from the exported constant, not hardcoded: writing `2` here would encode the cap in a second place, so
    // a deliberate change to it would fail this test with no pointer to what actually moved.
    const huge = harness({ maxReask: 10_000, maxRetries: 0 });
    await callModel(huge.deps, request);
    expect(huge.fake.callCount).toBe(MAX_REASK_ATTEMPTS + 1);

    const negative = harness({ maxReask: -5, maxRetries: 0 });
    await callModel(negative.deps, request);
    expect(negative.fake.callCount).toBe(1);
  });

  test('invalid after the last re-ask is a FAILED result carrying invalid_output — never a partial accept', async () => {
    // The clause the acceptance criterion rests on. The caller must receive an error, and must NOT receive the raw
    // or partially-validated body under any key.
    const { deps } = harness({ maxReask: 1, maxRetries: 0 });
    const r = await callModel(deps, request);
    expect(r.outcome).toBe('error');
    expect(r.errorCategory).toBe('invalid_output');
    // The decisive assertion: NO validated output is handed back on the failure path.
    expect(r.validatedOutput).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain('not-json-at-all');
  });

  test('EVERY attempt is metered — a re-asked call costs more in the ledger than a first-time success', async () => {
    // An unmetered re-ask is a free retry the ledger cannot see. The gateway accumulates usage across attempts into
    // one event (CDR-026 §5), so more attempts must mean strictly more recorded tokens.
    const once = harness({ maxReask: 0, maxRetries: 0 });
    await callModel(once.deps, request);
    const twice = harness({ maxReask: 1, maxRetries: 0 });
    await callModel(twice.deps, request);

    expect(once.events).toHaveLength(1);
    expect(twice.events).toHaveLength(1);
    const tokensOf = (e: NewModelCallUsageEvent): number => e.inputTokens + e.outputTokens;
    expect(tokensOf(twice.events[0]!)).toBeGreaterThan(tokensOf(once.events[0]!));
    // …and both are recorded as the failure they were, not quietly as successes.
    expect(twice.events[0]!.outcome).toBe('error');
    expect(twice.events[0]!.errorCategory).toBe('invalid_output');
  });

  test('metering is FAIL-CLOSED on the invalid path too — a sink failure aborts rather than yielding un-metered usage', async () => {
    // The success path's fail-closed rule (CDR-026 §5) must hold identically when the call failed validation:
    // otherwise the cheapest way to hide usage would be to make the call fail.
    const { deps } = harness({
      maxReask: 0,
      maxRetries: 0,
      recordUsage: async () => {
        await Promise.resolve();
        throw new Error('usage sink down');
      },
    });
    await expect(callModel(deps, request)).rejects.toThrow();
  });

  test('with NO schema ref, the raw output is returned — validation is opt-in and does not silently apply', async () => {
    // Guards the other direction: a caller that asked for no structured output must not have one imposed, or every
    // free-text call would start failing as `invalid_output`.
    const { deps } = harness({ maxReask: 1, maxRetries: 0 });
    const r = await callModel(deps, freeTextRequest);
    expect(r.outcome).toBe('ok');
    expect(r.validatedOutput).toBe('not-json-at-all');
  });
});
