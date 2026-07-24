// ACBP-P2-012 / CDR-031 — the runnable Slice B demo: `pnpm demo:slice-b`.
//
// Performs the M2/M3 exit journey (interview → adaptive follow-ups → classification → understanding → edit → confirm
// → correction → fallback-flag negative) against the configured PostgreSQL, printing each step and its evidence, and
// exiting NON-ZERO if any step does not hold. This is the backlog row's "Run demo script" verification procedure.
//
// The journey itself is `runSliceBJourney` in @acbp/test-support — the SAME implementation the CI suite asserts
// (packages/core/src/discovery/slice-b.e2e.integration.test.ts) — so the demo can never drift from the guarantee.
// Everything below the model-PROVIDER edge is production code: the real @acbp/core use cases + the P2-003 gateway,
// @acbp/database, and the restricted `acbp_app` connection under FORCE RLS. The provider edge is the deterministic
// FakeModelProvider — NO live model, NO real key, NO snapshot pin (CDR-026 §0/§3).
//
// Requires ACBP_TEST_DATABASE_URL (the same disposable database the integration suites use). Uses NO production
// credentials.
const url = process.env['ACBP_TEST_DATABASE_URL'];
if (!url) {
  console.error('demo:slice-b — ACBP_TEST_DATABASE_URL is required (point it at a disposable PostgreSQL, e.g. the CI test database).');
  process.exit(2);
}

const { createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceBJourney } = await import('@acbp/test-support');
const core = await import('@acbp/core');
const { toModelId } = await import('@acbp/contracts');
const { FakeModelProvider } = await import('@acbp/adapters');

const { provisionPersonalAccount, createCompany, pauseCompany, createModelGateway, interviewOutputValidator, understandingOutputValidator, startInterviewSession, suspendInterviewSession, resumeInterviewSession, getInterviewSession, addInterviewQuestion, generateAdaptiveBatch, evaluateAnswer, suggestAssumptionForSkip, getSessionQa, listMemoryItems, generateUnderstanding, recordUnderstandingReview, confirmUnderstanding, correctUnderstanding, isCurrentUnderstandingConfirmed } = core;

// The injected @acbp/core use cases (names match SliceBOps) + the fake-provider gateway factory. Same wiring as the
// CI suite, so the demo can never drift from the guarantee.
const OPS = { startInterviewSession, suspendInterviewSession, resumeInterviewSession, getInterviewSession, addInterviewQuestion, generateAdaptiveBatch, evaluateAnswer, suggestAssumptionForSkip, getSessionQa, listMemoryItems, generateUnderstanding, recordUnderstandingReview, confirmUnderstanding, correctUnderstanding, isCurrentUnderstandingConfirmed };
const estimateCost = ({ inputTokens, outputTokens }) => inputTokens + outputTokens;
const makeGateway = (validator, behavior) => createModelGateway(product, { primary: { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) }, estimateCost, validateOutput: validator === 'interview' ? interviewOutputValidator : understandingOutputValidator, config: { maxRetries: 0, maxReask: 0 } });

let owner;
let product;
let exitCode = 0;
try {
  owner = createOwnerFixtureClient();
  console.log('· preparing a disposable schema…');
  await resetSchema(owner);
  await enableAppLogin(owner);
  product = createRestrictedProductClient();
  const proof = await assertRestrictedRole(product);
  console.log(`· fixture's restricted connection verified: role=${proof.currentUser} superuser=${proof.isSuperuser} bypassrls=${proof.bypassesRls}`);

  await truncateFixtures(owner);
  const world = await seedTwoTenantWorld(owner, product, { provisionPersonalAccount, createCompany, pauseCompany });
  console.log('· seeded a company owner to drive the founder-discovery journey\n');

  const { steps } = await runSliceBJourney({ product, owner, userId: world.aOwner, accountId: world.accountA, companyId: world.companyA1, ops: OPS, makeGateway });

  console.log('ACBP-P2-012 — Slice B: confirmed understanding (interview → understanding → edit → confirm)\n');
  for (const step of steps) {
    console.log(`${step.ok ? 'PASS' : 'FAIL'}  [${step.requirement}] ${step.step}`);
    console.log(`      ${step.detail}`);
    if (!step.ok) exitCode = 1;
  }

  // Defense-in-depth (matches the CI suite): the journey must have run its FULL 13-step sequence, not a truncated one.
  if (steps.length !== 13) {
    exitCode = 1;
    console.log(`FAIL  [sequence] expected 13 journey steps, got ${steps.length} (a truncated run must not read as a pass)`);
  }
  const failures = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failures}/${steps.length} steps passed`);
  console.log(exitCode === 0 ? '\nSlice B demo PASSED — understanding generated, edited, confirmed, and a correction re-blocked planning; fallbacks stayed honest.' : '\nSlice B demo FAILED — see the FAIL steps above.');
} catch (error) {
  exitCode = 1;
  console.error('\nSlice B demo FAILED with an unexpected error:', error instanceof Error ? error.message : String(error));
} finally {
  await teardown(owner, product).catch(() => undefined);
}
process.exit(exitCode);
