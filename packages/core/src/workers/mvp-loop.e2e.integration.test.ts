// ACBP-P7-009 / CDR-085 — the end-to-end MVP suite. Drives `runMvpLoopJourney` — the SAME implementation the
// runnable `pnpm demo:mvp-loop` uses, so the demo can never drift from this guarantee — against the real isolated
// PostgreSQL under the restricted `acbp_app` role (dual-keyed FORCE RLS).
//
// One company, carried the whole way: the founder's typed answer → memory → understanding → confirmation →
// strategy → decision → roadmap → planned tasks → THE PLANNED TASK RUNNING → a cited document → completion →
// settlement → a revision that re-executes → and finally a walk back down the chain from the revised document to
// the account, which fails unless every link resolves inside one tenant.
//
// This is the compositional claim, not a re-proof of the mechanisms: distinctness, phase bounding, citation
// certification, settlement and the negative sets belong to Slices B–E and stay there (CDR-085 §2).
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, InMemoryObjectStorage, InMemoryResearchFetcher, type FakeProviderBehavior } from '@acbp/adapters';
import {
  hasTestDatabase,
  createOwnerFixtureClient,
  createRestrictedProductClient,
  enableAppLogin,
  resetSchema,
  truncateFixtures,
  seedTwoTenantWorld,
  teardown,
  assertRestrictedRole,
  runMvpLoopJourney,
  type MvpLoopOps,
  type MvpLoopFakeBehavior,
  type MvpLoopValidator,
  type MvpLoopSource,
  type TwoTenantWorld,
} from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import {
  createModelGateway,
  understandingOutputValidator,
  strategyOutputValidator,
  roadmapOutputValidator,
  taskPlanOutputValidator,
  researchOutputValidator,
  interviewOutputValidator,
  type ResolvedProvider,
} from '../index.js';
import { startInterviewSession, addInterviewQuestion, evaluateAnswer } from '../discovery/index.js';
import { listMemoryItems } from '../memory/index.js';
import { generateUnderstanding, confirmUnderstanding, isCurrentUnderstandingConfirmed } from '../understanding/index.js';
import { generateStrategyOptions, recordStrategyDecision, recordDecision } from '../strategy/index.js';
import { generateRoadmap, generateTasks } from '../planning/index.js';
import { planTask } from '../tasks/index.js';
import { preflightRun, reserveCredit, settleRun } from '../billing/credit-service.js';
import { startRun, succeedRun } from '../runs/index.js';
import { listRunArtifacts } from '../artifacts/persist.js';
import { completeTask } from '../artifacts/complete.js';
import { requestRevision } from '../artifacts/request-revision.js';
import { readArtifactLineage } from '../artifacts/lineage.js';
import { runResearch } from './research.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

/**
 * The injected @acbp/core use cases (names match MvpLoopOps exactly).
 *
 * ANNOTATED, never cast. `as unknown as MvpLoopOps` would compile whatever was written here, including a journey
 * that had the wrong field name for a DTO — the exact class of bug several earlier slices shipped to CI. The
 * annotation is what makes the structural types in the journey load-bearing.
 */
const OPS: MvpLoopOps = {
  startInterviewSession,
  addInterviewQuestion,
  evaluateAnswer,
  listMemoryItems,
  generateUnderstanding,
  confirmUnderstanding,
  isCurrentUnderstandingConfirmed,
  generateStrategyOptions,
  recordStrategyDecision,
  recordDecision,
  generateRoadmap,
  generateTasks,
  planTask,
  preflightRun,
  startRun,
  reserveCredit,
  runResearch,
  listRunArtifacts,
  succeedRun,
  completeTask,
  settleRun,
  requestRevision,
  readArtifactLineage,
};

describe.skipIf(!hasTestDatabase)('the MVP loop — end to end on one company (real PostgreSQL, restricted role) — ACBP-P7-009/CDR-085', () => {
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
  }, 60_000);

  /** A one-shot gateway on the deterministic fake provider, validated by the REAL validator for that stage. */
  const makeGateway = (validator: MvpLoopValidator, behavior: MvpLoopFakeBehavior, opts: { milestoneCount?: number } = {}) => {
    const primary: ResolvedProvider = { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior: behavior as FakeProviderBehavior }) };
    const validateOutput =
      validator === 'interview'
        ? interviewOutputValidator
        : validator === 'understanding'
          ? understandingOutputValidator
          : validator === 'strategy'
            ? strategyOutputValidator
            : validator === 'roadmap'
              ? roadmapOutputValidator
              : validator === 'research'
                ? researchOutputValidator
                : taskPlanOutputValidator(opts.milestoneCount ?? 0);
    return createModelGateway(product, { primary, estimateCost, validateOutput, config: { maxRetries: 0, maxReask: 0 } });
  };

  /** A fresh in-memory fetcher seeded with the journey's sources — the read-only research port. */
  const makeFetcher = (question: string, sources: readonly MvpLoopSource[]) => {
    const fetcher = new InMemoryResearchFetcher();
    fetcher.seed(question, sources);
    return fetcher;
  };
  const makeStorage = () => new InMemoryObjectStorage();

  test('one company travels the whole loop, and the revised document still descends from the account', async () => {
    const { steps } = await runMvpLoopJourney({
      product,
      owner,
      userId: w.aOwner,
      accountId: w.accountA,
      companyId: w.companyA1,
      // The unrelated tenant the continuity walk uses to stay falsifiable: it must end the loop holding nothing.
      foreignAccountId: w.accountB,
      ops: OPS,
      makeGateway,
      makeFetcher,
      makeStorage,
    });
    const failures = steps.filter((s) => !s.ok).map((s) => `[${s.requirement}] ${s.step} — ${s.detail}`);
    expect(failures, failures.join('\n')).toHaveLength(0);
    // The journey must actually have run its full sequence — `bail()` returns early, so a short `steps` array is
    // the signature of a silently truncated run rather than a pass. Eleven verdicts: the eight stages of CDR-085
    // §3, with strategy contributing two (generation and decision are separate hops), execution contributing two
    // (the planned task running, then the document it produced), and the closing continuity walk.
    expect(steps.length).toBe(11);
    expect(steps.every((s) => s.ok)).toBe(true);
  }, 240_000);
});
