// ACBP-P3-007 / CDR-045 — the Slice C E2E integration suite (M3 milestone exit). Drives `runSliceCJourney` — the SAME
// implementation the runnable `pnpm demo:slice-c` uses, so the demo can never drift from this guarantee — against the
// real isolated PostgreSQL under the restricted `acbp_app` role (dual-keyed FORCE RLS). The strategy-selection
// vertical (confirmed understanding → three distinct options → advisory comparison → owner selection → immutable
// decision) runs through the real @acbp/core use cases with the P2-003 gateway wired to the deterministic
// FakeModelProvider (no live model), together with BOTH negatives the backlog names: the distinctness rejection and
// record-failure-blocks. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceCJourney, type SliceCOps, type SliceCFakeBehavior, type SliceCValidator, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, understandingOutputValidator, strategyOutputValidator, strategyRecommendationValidator, type ResolvedProvider } from '../index.js';
import { generateUnderstanding, confirmUnderstanding } from '../understanding/index.js';
import { generateStrategyOptions, getLatestStrategyGeneration, recommendStrategy, recordStrategyDecision, recordDecision } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

/** The injected @acbp/core use cases (names match SliceCOps exactly). */
const OPS: SliceCOps = { generateUnderstanding, confirmUnderstanding, generateStrategyOptions, getLatestStrategyGeneration, recommendStrategy, recordStrategyDecision, recordDecision };

describe.skipIf(!hasTestDatabase)('Slice C — strategy selection E2E (real PostgreSQL, restricted role) — ACBP-P3-007/CDR-045', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  const makeGateway = (validator: SliceCValidator, behavior: SliceCFakeBehavior) => {
    const primary: ResolvedProvider = { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior: behavior as FakeProviderBehavior }) };
    const validateOutput = validator === 'understanding' ? understandingOutputValidator : validator === 'strategy' ? strategyOutputValidator : strategyRecommendationValidator;
    return createModelGateway(product, { primary, estimateCost, validateOutput, config: { maxRetries: 0, maxReask: 0 } });
  };

  test('the whole Slice C journey passes end to end, including both negatives', async () => {
    // `companyA2` carries the negatives (CDR-045 §4-G9): a half-written negative must not corrupt the state the
    // positive steps already proved, and a failure must never be ambiguous about which half broke.
    const { steps } = await runSliceCJourney({ product, owner, userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, negativeCompanyId: w.companyA2, ops: OPS, makeGateway });
    const failures = steps.filter((s) => !s.ok).map((s) => `[${s.requirement}] ${s.step} — ${s.detail}`);
    expect(failures, failures.join('\n')).toHaveLength(0);
    // `bail()` returns early, so a short `steps` array is the signature of a silently truncated run rather than a
    // pass. Exact, not `>=`: a journey that stopped after step 3 must not read as success.
    expect(steps.length).toBe(10);
    expect(steps.every((s) => s.ok)).toBe(true);
  }, 120_000);
});
