// ACBP-P6-012 / CDR-077 — the Slice F E2E integration suite (M6 milestone exit). Drives `runSliceFJourney` — the
// SAME implementation the runnable `pnpm demo:slice-f` uses, so the demo can never drift from this guarantee —
// against the real isolated PostgreSQL under the restricted `acbp_app` role (dual-keyed FORCE RLS).
//
// The safety-and-recovery vertical: a policy block → an approval that cannot buy past it → a modified payload
// refused → the exact payload authorized → a duplicate delivery suppressed on three surfaces → an emergency stop
// that outranks a live approval → review-to-resume → a lost worker reclaimed and retried → the account's usage
// totals reconciling after all of it.
//
// WHY IT LIVES IN `tools/`: the dispatcher is where four of the six scenarios are actually decided. The mechanisms
// themselves are proven in their own suites (CDR-077 §2); what this file asserts is that they COMPOSE.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { createTestLogger, SUPPRESSION_EVENT, type Logger } from '@acbp/observability';
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
  runSliceFJourney,
  type SliceFOps,
  type SliceFLogCapture,
  type TwoTenantWorld,
} from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun, reclaimLostRuns } from '../runs/index.js';
import { initializeCompanyPolicy } from '../policy/index.js';
import { requestApproval, decideApproval } from '../approvals/index.js';
import { activateStop, clearStop, reviewHeldWork } from '../stops/index.js';
import { enqueueJob } from '../jobs/index.js';
import { rebuildAccountUsageRollup, reconcileAccountUsageRollup } from '../usage/index.js';
import { createModelGateway, type ResolvedProvider } from '../index.js';
import { dispatchToolCall } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/**
 * The injected @acbp/core use cases (names match SliceFOps exactly).
 *
 * ANNOTATED, never cast. `as unknown as SliceFOps` would compile whatever was written here, including a journey
 * that had the wrong field name for a DTO — the exact class of bug two earlier slices shipped to CI. The
 * annotation is what makes the structural types in the journey load-bearing.
 */
const OPS: SliceFOps = {
  initializeCompanyPolicy,
  createTask,
  planTask,
  startRun,
  dispatchToolCall,
  requestApproval,
  decideApproval,
  activateStop,
  clearStop,
  reviewHeldWork,
  reclaimLostRuns,
  enqueueJob,
  rebuildAccountUsageRollup,
  reconcileAccountUsageRollup,
};

/** Deterministic tokens, so the reconciliation step compares real numbers rather than zeroes. */
const BEHAVIOR: FakeProviderBehavior = { kind: 'respond', output: 'result', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens * 5 + outputTokens * 7;

describe.skipIf(!hasTestDatabase)('Slice F — safety and recovery E2E (real PostgreSQL, restricted role) — ACBP-P6-012/CDR-077', () => {
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

  /** A gateway on the deterministic fake provider, metering through the restricted connection. */
  const makeGateway = (logger: unknown) => {
    const primary: ResolvedProvider = { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior: BEHAVIOR }) };
    // The journey hands the logger back as `unknown` — test-support does not depend on @acbp/observability, so it
    // cannot name the type. Narrowed here, where the value was created and its type is known.
    return createModelGateway(product, { primary, estimateCost, logger: logger as Logger });
  };
  const makeLogger = (): SliceFLogCapture => createTestLogger();

  test('the whole Slice F journey passes end to end (every step ok, with evidence)', async () => {
    const { steps } = await runSliceFJourney({
      product,
      owner,
      userId: w.aOwner,
      accountId: w.accountA,
      companyId: w.companyA1,
      siblingCompanyId: w.companyA2,
      ops: OPS,
      makeGateway,
      makeLogger,
      suppressionEvent: SUPPRESSION_EVENT,
    });
    const failures = steps.filter((s) => !s.ok).map((s) => `[${s.requirement}] ${s.step} — ${s.detail}`);
    expect(failures, failures.join('\n')).toHaveLength(0);
    // The journey must actually have run its full sequence — `bail()` returns early, so a short `steps` array is
    // the signature of a silently truncated run rather than a pass. Ten steps: the control, then the five
    // scenarios the backlog names, then M6's sixth criterion.
    expect(steps.length).toBe(10);
    expect(steps.every((s) => s.ok)).toBe(true);
  }, 180_000);
});
