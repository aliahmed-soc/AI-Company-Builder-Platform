// ACBP-P4-007 / CDR-044 — the Slice D E2E integration suite (M4 milestone exit). Drives `runSliceDJourney` — the SAME
// implementation the runnable `pnpm demo:slice-d` uses, so the demo can never drift from this guarantee — against the
// real isolated PostgreSQL under the restricted `acbp_app` role (dual-keyed FORCE RLS). The whole planned-work
// vertical (confirmed understanding → strategy → selection → decision → roadmap → tasks → board → detail → controls)
// runs through the real @acbp/core use cases with the P2-003 gateway wired to the deterministic FakeModelProvider (no
// live model). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceDJourney, type SliceDOps, type SliceDFakeBehavior, type SliceDValidator, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, understandingOutputValidator, strategyOutputValidator, roadmapOutputValidator, taskPlanOutputValidator, type ResolvedProvider } from '../index.js';
import { generateUnderstanding, confirmUnderstanding } from '../understanding/index.js';
import { generateStrategyOptions, recordStrategyDecision, recordDecision } from '../strategy/index.js';
import { generateRoadmap, generateTasks } from './index.js';
import { listTasks, planTask, addTaskDependency, getTaskBoard, getTaskDetail, repeatTask, deleteTask } from '../tasks/index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

/** The injected @acbp/core use cases (names match SliceDOps exactly). */
const OPS: SliceDOps = { generateUnderstanding, confirmUnderstanding, generateStrategyOptions, recordStrategyDecision, recordDecision, generateRoadmap, generateTasks, listTasks, planTask, addTaskDependency, getTaskBoard, getTaskDetail, repeatTask, deleteTask };

describe.skipIf(!hasTestDatabase)('Slice D — planned work E2E (real PostgreSQL, restricted role) — ACBP-P4-007/CDR-044', () => {
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

  const makeGateway = (validator: SliceDValidator, behavior: SliceDFakeBehavior, opts: { milestoneCount?: number } = {}) => {
    const primary: ResolvedProvider = { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior: behavior as FakeProviderBehavior }) };
    const validateOutput =
      validator === 'understanding'
        ? understandingOutputValidator
        : validator === 'strategy'
          ? strategyOutputValidator
          : validator === 'roadmap'
            ? roadmapOutputValidator
            : taskPlanOutputValidator(opts.milestoneCount ?? 0);
    return createModelGateway(product, { primary, estimateCost, validateOutput, config: { maxRetries: 0, maxReask: 0 } });
  };

  test('the whole Slice D journey passes end to end (every step ok, with evidence)', async () => {
    const { steps } = await runSliceDJourney({ product, owner, userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, ops: OPS, makeGateway });
    const failures = steps.filter((s) => !s.ok).map((s) => `[${s.requirement}] ${s.step} — ${s.detail}`);
    expect(failures, failures.join('\n')).toHaveLength(0);
    // The journey must actually have run its full sequence — a bail() returns early, so a short `steps` array is the
    // signature of a silently truncated run rather than a pass.
    expect(steps.length).toBe(12);
    expect(steps.every((s) => s.ok)).toBe(true);
  }, 120_000);
});
