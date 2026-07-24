// ACBP-P2-012 / CDR-031 — the Slice B E2E integration suite (M2/M3 milestone exit). Drives `runSliceBJourney` — the
// SAME implementation the runnable `pnpm demo:slice-b` uses, so the demo can never drift from this guarantee —
// against the real isolated PostgreSQL under the restricted `acbp_app` role (dual-keyed FORCE RLS). The whole
// founder-discovery vertical (interview → adaptive follow-ups → classification → understanding → edit → confirm →
// correction → fallback-flag negative) runs through the real @acbp/core use cases + the P2-003 gateway wired to the
// deterministic FakeModelProvider (no live model). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceBJourney, type SliceBOps, type SliceBFakeBehavior, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, interviewOutputValidator, understandingOutputValidator, type ResolvedProvider } from '../index.js';
import { startInterviewSession, suspendInterviewSession, resumeInterviewSession, getInterviewSession, addInterviewQuestion, generateAdaptiveBatch, evaluateAnswer, suggestAssumptionForSkip, getSessionQa } from './index.js';
import { generateUnderstanding, recordUnderstandingReview, confirmUnderstanding, correctUnderstanding, isCurrentUnderstandingConfirmed } from '../understanding/index.js';
import { listMemoryItems } from '../memory/index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

/** The injected @acbp/core use cases (names match SliceBOps exactly). */
const OPS: SliceBOps = { startInterviewSession, suspendInterviewSession, resumeInterviewSession, getInterviewSession, addInterviewQuestion, generateAdaptiveBatch, evaluateAnswer, suggestAssumptionForSkip, getSessionQa, listMemoryItems, generateUnderstanding, recordUnderstandingReview, confirmUnderstanding, correctUnderstanding, isCurrentUnderstandingConfirmed };

describe.skipIf(!hasTestDatabase)('Slice B — confirmed understanding E2E (real PostgreSQL, restricted role) — ACBP-P2-012/CDR-031', () => {
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

  const makeGateway = (validator: 'interview' | 'understanding', behavior: SliceBFakeBehavior) => {
    const primary: ResolvedProvider = { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior: behavior as FakeProviderBehavior }) };
    return createModelGateway(product, { primary, estimateCost, validateOutput: validator === 'interview' ? interviewOutputValidator : understandingOutputValidator, config: { maxRetries: 0, maxReask: 0 } });
  };

  test('the whole Slice B journey passes end to end (every step ok, with evidence)', async () => {
    const { steps } = await runSliceBJourney({ product, owner, userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, ops: OPS, makeGateway });
    const failures = steps.filter((s) => !s.ok).map((s) => `[${s.requirement}] ${s.step} — ${s.detail}`);
    expect(failures, failures.join('\n')).toHaveLength(0);
    // The journey must actually have run its full sequence (guard against a silently-truncated run).
    expect(steps.length).toBe(13);
    expect(steps.every((s) => s.ok)).toBe(true);
  });
});
