// @acbp/core/composition — the caps seam wiring (ACBP-P6-010; CDR-075 §1/§3-G4).
import { describe, expect, it } from 'vitest';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider } from '@acbp/adapters';
import { USAGE_CAP_DEFAULTS } from '@acbp/config';
import type { DatabaseClient } from '@acbp/database';
import { createModelGateway, type ResolvedProvider } from '../index.js';

const DUMMY_CLIENT = {} as unknown as DatabaseClient;
const provider = (): ResolvedProvider => ({
  name: 'primary',
  modelId: toModelId('primary-model'),
  modelVersion: 'v1',
  provider: new FakeModelProvider({ behavior: { kind: 'respond', output: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } }),
});
const estimateCost = () => 0;

describe('createModelGateway caps wiring', () => {
  it('REFUSES both `caps` and `policyPrecheck` rather than silently preferring one', () => {
    // THE GUARD. Preferring either one quietly would leave a caller who configured caps believing they were
    // enforced while a hand-written precheck answered instead — the ceiling would be configured, documented, and
    // inert. That is the exact failure shape ACBP-P6-011 found twice (a mechanism wired to nothing), so this one
    // is a throw at construction rather than a surprise at runtime.
    expect(() =>
      createModelGateway(DUMMY_CLIENT, {
        primary: provider(),
        estimateCost,
        caps: USAGE_CAP_DEFAULTS,
        policyPrecheck: () => ({ allowed: true }),
      }),
    ).toThrow(TypeError);
  });

  it('builds without caps — absence means no ceiling, which is the pre-P6-010 behaviour', () => {
    // Stated as a test rather than only in a comment. `policyPrecheck` has always been optional and defaulted to
    // *always allowed*, so every existing caller enforced nothing; making caps mandatory would have changed the
    // meaning of every one of them in a commit about limits.
    expect(() => createModelGateway(DUMMY_CLIENT, { primary: provider(), estimateCost })).not.toThrow();
  });

  it('builds with caps alone, and with a precheck alone', () => {
    expect(() => createModelGateway(DUMMY_CLIENT, { primary: provider(), estimateCost, caps: USAGE_CAP_DEFAULTS })).not.toThrow();
    expect(() => createModelGateway(DUMMY_CLIENT, { primary: provider(), estimateCost, policyPrecheck: () => ({ allowed: true }) })).not.toThrow();
  });

  it('a blocked call is reported as budget_exceeded, an unreadable one as internal', async () => {
    // The distinction CDR-075 §3-G6 exists for, asserted at the gateway boundary rather than only inside
    // `evaluateCaps`: "you have spent your budget" is the founder's to act on, "we cannot tell what you have
    // spent" is ours. A single boolean collapses them, and the collapsed version sends someone to top up an
    // account that was never the problem.
    const blocked = createModelGateway(DUMMY_CLIENT, { primary: provider(), estimateCost, policyPrecheck: () => ({ allowed: false, errorCategory: 'budget_exceeded' }) });
    const unreadable = createModelGateway(DUMMY_CLIENT, { primary: provider(), estimateCost, policyPrecheck: () => ({ allowed: false, errorCategory: 'internal' }) });
    const request = {
      taskClass: 'extraction' as const,
      templateRef: 'tmpl@1',
      contextParts: [{ role: 'user' as const, content: 'go' }],
      timeoutClass: 'interactive' as const,
      accountId: 'acc-1',
      companyId: 'co-1',
    };

    expect((await blocked(request)).errorCategory).toBe('budget_exceeded');
    expect((await unreadable(request)).errorCategory).toBe('internal');
  });

  it('an omitted errorCategory still means budget_exceeded — the historical default is preserved', async () => {
    const legacy = createModelGateway(DUMMY_CLIENT, { primary: provider(), estimateCost, policyPrecheck: () => ({ allowed: false }) });
    const request = {
      taskClass: 'extraction' as const,
      templateRef: 'tmpl@1',
      contextParts: [{ role: 'user' as const, content: 'go' }],
      timeoutClass: 'interactive' as const,
      accountId: 'acc-1',
      companyId: 'co-1',
    };
    expect((await legacy(request)).errorCategory).toBe('budget_exceeded');
  });
});
