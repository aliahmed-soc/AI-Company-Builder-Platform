// ACBP-P6-012 / CDR-077 — the runnable Slice F demo: `pnpm demo:slice-f`.
//
// Performs the M6 exit journey (a policy block → an approval that cannot buy past it → a modified payload refused →
// the exact payload authorized → a duplicate delivery suppressed on three surfaces → an emergency stop that
// outranks a live approval → review-to-resume → a lost worker reclaimed and retried → the totals reconciling)
// against the configured PostgreSQL, printing each step and its evidence, and exiting NON-ZERO if any step does not
// hold. This is the backlog row's "Run demo script" verification procedure.
//
// The journey itself is `runSliceFJourney` in @acbp/test-support — the SAME implementation the CI suite asserts
// (packages/core/src/tools/slice-f.e2e.integration.test.ts) — so the demo can never drift from the guarantee.
// Everything inside the trust boundary is production code: the real @acbp/core use cases, @acbp/database, and the
// restricted `acbp_app` connection under FORCE RLS. Exactly ONE edge outside that boundary is seamed — the model
// provider (deterministic FakeModelProvider), which exists here only to produce billable usage for the
// reconciliation step. NO live model, NO real key, NO network, NO spend.
//
// Requires ACBP_TEST_DATABASE_URL (the same disposable database the integration suites use). Uses NO production
// credentials.
const url = process.env['ACBP_TEST_DATABASE_URL'];
if (!url) {
  console.error('demo:slice-f — ACBP_TEST_DATABASE_URL is required (point it at a disposable PostgreSQL, e.g. the CI test database).');
  process.exit(2);
}

const { createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceFJourney } = await import('@acbp/test-support');
const core = await import('@acbp/core');
const { toModelId } = await import('@acbp/contracts');
const { FakeModelProvider } = await import('@acbp/adapters');
const { createTestLogger, SUPPRESSION_EVENT } = await import('@acbp/observability');

const {
  provisionPersonalAccount, createCompany, pauseCompany,
  createModelGateway,
  initializeCompanyPolicy,
  createTask, planTask,
  startRun, reclaimLostRuns,
  dispatchToolCall,
  requestApproval, decideApproval,
  activateStop, clearStop, reviewHeldWork,
  enqueueJob,
  rebuildAccountUsageRollup, reconcileAccountUsageRollup,
} = core;

// The injected @acbp/core use cases (names match SliceFOps). Same wiring as the CI suite, so the demo cannot drift.
const OPS = {
  initializeCompanyPolicy,
  createTask, planTask,
  startRun, reclaimLostRuns,
  dispatchToolCall,
  requestApproval, decideApproval,
  activateStop, clearStop, reviewHeldWork,
  enqueueJob,
  rebuildAccountUsageRollup, reconcileAccountUsageRollup,
};

const BEHAVIOR = { kind: 'respond', output: 'result', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
const estimateCost = ({ inputTokens, outputTokens }) => inputTokens * 5 + outputTokens * 7;

const EXPECTED_STEPS = 10;

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

  // Built AFTER `product` exists, because the gateway meters through that connection.
  const makeGateway = (logger) =>
    createModelGateway(product, { primary: { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior: BEHAVIOR }) }, estimateCost, logger });
  const makeLogger = () => createTestLogger();

  await truncateFixtures(owner);
  const world = await seedTwoTenantWorld(owner, product, { provisionPersonalAccount, createCompany, pauseCompany });
  console.log('· seeded a company owner, with a SIBLING company in the same account\n');

  const { steps } = await runSliceFJourney({
    product,
    owner,
    userId: world.aOwner,
    accountId: world.accountA,
    companyId: world.companyA1,
    siblingCompanyId: world.companyA2,
    ops: OPS,
    makeGateway,
    makeLogger,
    suppressionEvent: SUPPRESSION_EVENT,
  });

  console.log('ACBP-P6-012 — Slice F: safety and recovery (policy block → approval binding → emergency stop → duplicate delivery → worker recovery → reconciliation)\n');
  for (const step of steps) {
    console.log(`${step.ok ? 'PASS' : 'FAIL'}  [${step.requirement}] ${step.step}`);
    console.log(`      ${step.detail}`);
    if (!step.ok) exitCode = 1;
  }

  // Defense-in-depth (matches the CI suite): the journey must have run its FULL sequence, not a truncated one.
  // `bail()` returns early, so a short run would otherwise print only passes and read as a success.
  if (steps.length !== EXPECTED_STEPS) {
    exitCode = 1;
    console.log(`FAIL  [sequence] expected ${EXPECTED_STEPS} journey steps, got ${steps.length} (a truncated run must not read as a pass)`);
  }
  const failures = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failures}/${steps.length} steps passed`);
  if (exitCode === 0) {
    console.log('\nSlice F demo PASSED — a disallowed action was blocked, a modified payload was refused, an emergency stop outranked a live approval, a re-delivery took effect once, a lost worker was reclaimed and retried, and the account totals reconcile exactly.');
    // Said in the demo output, not only in the CDR: a reader who sees ten green steps should not conclude more than
    // the run actually demonstrated (CDR-077 §4).
    console.log('NOTE  NO EXTERNAL ACTION EVER EXECUTED. No tool implementation exists; "the approved action ran" means the chokepoint authorized it and spent the approval — the only execution instant that exists today (CDR-069 §1-G7).');
    console.log('NOTE  ONE stop scope is exercised (`company`). The per-scope enforcement matrix is the stop suite; `capability` and `integration` are refused by name and enforce nothing (CDR-072 §1-G10).');
    console.log('NOTE  policy RULES were installed on the owner connection — no product surface authors them yet (CDR-077 §G4).');
  } else {
    console.log('\nSlice F demo FAILED — see the FAIL steps above.');
  }
} catch (error) {
  exitCode = 1;
  console.error('\nSlice F demo FAILED with an unexpected error:', error instanceof Error ? error.message : String(error));
} finally {
  await teardown(owner, product).catch(() => undefined);
}
process.exit(exitCode);
