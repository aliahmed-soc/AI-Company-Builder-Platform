// ACBP-P5-015 / CDR-065 — the Slice E E2E integration suite (M5 milestone exit). Drives `runSliceEJourney` — the SAME
// implementation the runnable `pnpm demo:slice-e` uses, so the demo can never drift from this guarantee — against the
// real isolated PostgreSQL under the restricted `acbp_app` role (dual-keyed FORCE RLS). The safe-internal-execution
// vertical (preflight → queue → run → research document → provenance → completion → settlement → ledger →
// activity/audit → revision → lineage, then the negative set) runs through the real @acbp/core use cases with the
// P2-003 gateway wired to the deterministic FakeModelProvider (no live model, no network, no spend).
// Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, InMemoryObjectStorage, InMemoryResearchFetcher, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceEJourney, type SliceEOps, type SliceEFakeBehavior, type SliceESource, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, researchOutputValidator, type ResolvedProvider } from '../index.js';
import { createTask, planTask } from '../tasks/index.js';
import { preflightRun, reserveCredit, settleRun, readCreditLedger } from '../billing/credit-service.js';
import { startRun, succeedRun, failRun } from '../runs/index.js';
import { listRunArtifacts } from '../artifacts/persist.js';
import { completeTask } from '../artifacts/complete.js';
import { requestRevision } from '../artifacts/request-revision.js';
import { readArtifactLineage } from '../artifacts/lineage.js';
import { getCompanyActivity } from '../company/activity-service.js';
import { runResearch } from './research.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

/**
 * The injected @acbp/core use cases (names match SliceEOps exactly).
 *
 * ANNOTATED, never cast. `as unknown as SliceEOps` would compile whatever was written here, including a journey that
 * had the wrong field name for a DTO — which is the exact class of bug this file's two predecessors shipped to CI.
 * The annotation is what makes the structural types in the journey load-bearing.
 */
const OPS: SliceEOps = {
  createTask,
  planTask,
  preflightRun,
  startRun,
  reserveCredit,
  runResearch,
  listRunArtifacts,
  succeedRun,
  failRun,
  completeTask,
  settleRun,
  readCreditLedger,
  getCompanyActivity,
  requestRevision,
  readArtifactLineage,
};

describe.skipIf(!hasTestDatabase)('Slice E — safe internal execution E2E (real PostgreSQL, restricted role) — ACBP-P5-015/CDR-065', () => {
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

  /** One-shot gateway on the deterministic fake provider, validated by the REAL research output validator. */
  const makeGateway = (behavior: SliceEFakeBehavior) => {
    const primary: ResolvedProvider = { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior: behavior as FakeProviderBehavior }) };
    return createModelGateway(product, { primary, estimateCost, validateOutput: researchOutputValidator, config: { maxRetries: 0, maxReask: 0 } });
  };

  /** A fresh in-memory fetcher seeded with the journey's sources — the read-only research port (CDR-061 §3). */
  const makeFetcher = (question: string, sources: readonly SliceESource[]) => {
    const fetcher = new InMemoryResearchFetcher();
    // No cast: `SliceESource` is structurally `FetchedSource`, so the compiler accepts it directly. An assertion here
    // would be the thing that stopped mattering if the two ever diverged.
    fetcher.seed(question, sources);
    return fetcher;
  };
  const makeStorage = () => new InMemoryObjectStorage();

  test('the whole Slice E journey passes end to end, negatives included (every step ok, with evidence)', async () => {
    const { steps } = await runSliceEJourney({ product, owner, userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, ops: OPS, makeGateway, makeFetcher, makeStorage });
    const failures = steps.filter((s) => !s.ok).map((s) => `[${s.requirement}] ${s.step} — ${s.detail}`);
    expect(failures, failures.join('\n')).toHaveLength(0);
    // The journey must actually have run its full sequence — `bail()` returns early, so a short `steps` array is the
    // signature of a silently truncated run rather than a pass. Thirteen positive steps (CDR-065 §1's vertical, ending
    // with the revision RE-EXECUTING so "both versions retained" is proven by value) plus the four negatives of §4:
    // no-hollow-success, release-on-failure, fabricated citation, and unaffordable.
    expect(steps.length).toBe(17);
    expect(steps.every((s) => s.ok)).toBe(true);
  }, 180_000);
});
