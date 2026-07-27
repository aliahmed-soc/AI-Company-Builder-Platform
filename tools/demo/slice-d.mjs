// ACBP-P4-007 / CDR-044 — the runnable Slice D demo: `pnpm demo:slice-d`.
//
// Performs the M4 exit journey (confirmed understanding → strategy → selection → decision → roadmap → tasks → board →
// detail → controls) against the configured PostgreSQL, printing each step and its evidence, and exiting NON-ZERO if
// any step does not hold. This is the backlog row's "Run demo script" verification procedure.
//
// The journey itself is `runSliceDJourney` in @acbp/test-support — the SAME implementation the CI suite asserts
// (packages/core/src/planning/slice-d.e2e.integration.test.ts) — so the demo can never drift from the guarantee.
// Everything below the model-PROVIDER edge is production code: the real @acbp/core use cases + the P2-003 gateway,
// @acbp/database, and the restricted `acbp_app` connection under FORCE RLS. The provider edge is the deterministic
// FakeModelProvider — NO live model, NO real key, NO snapshot pin (CDR-026 §0/§3).
//
// Requires ACBP_TEST_DATABASE_URL (the same disposable database the integration suites use). Uses NO production
// credentials.
const url = process.env['ACBP_TEST_DATABASE_URL'];
if (!url) {
  console.error('demo:slice-d — ACBP_TEST_DATABASE_URL is required (point it at a disposable PostgreSQL, e.g. the CI test database).');
  process.exit(2);
}

const { createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceDJourney } = await import('@acbp/test-support');
const core = await import('@acbp/core');
const { toModelId } = await import('@acbp/contracts');
const { FakeModelProvider } = await import('@acbp/adapters');

const {
  provisionPersonalAccount, createCompany, pauseCompany,
  createModelGateway, understandingOutputValidator, strategyOutputValidator, roadmapOutputValidator, taskPlanOutputValidator,
  generateUnderstanding, confirmUnderstanding,
  generateStrategyOptions, recordStrategyDecision, recordDecision,
  generateRoadmap, generateTasks,
  planTask, addTaskDependency, getTaskBoard, getTaskDetail, repeatTask, deleteTask,
} = core;

// The injected @acbp/core use cases (names match SliceDOps) + the fake-provider gateway factory. Same wiring as the
// CI suite, so the demo can never drift from the guarantee.
const OPS = { generateUnderstanding, confirmUnderstanding, generateStrategyOptions, recordStrategyDecision, recordDecision, generateRoadmap, generateTasks, planTask, addTaskDependency, getTaskBoard, getTaskDetail, repeatTask, deleteTask };
const estimateCost = ({ inputTokens, outputTokens }) => inputTokens + outputTokens;

// `taskPlan` is a FACTORY over the roadmap's milestone count — a task naming a milestone ordinal that does not exist
// is the STRAT-005 phase-boundary violation P4-003 rejects, so the journey passes the count it actually generated.
const validatorFor = (validator, opts) => {
  if (validator === 'understanding') return understandingOutputValidator;
  if (validator === 'strategy') return strategyOutputValidator;
  if (validator === 'roadmap') return roadmapOutputValidator;
  return taskPlanOutputValidator(opts?.milestoneCount ?? 0);
};
const makeGateway = (validator, behavior, opts) =>
  createModelGateway(product, { primary: { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) }, estimateCost, validateOutput: validatorFor(validator, opts), config: { maxRetries: 0, maxReask: 0 } });

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
  console.log('· seeded a company owner to drive the planned-work journey\n');

  const { steps } = await runSliceDJourney({ product, owner, userId: world.aOwner, accountId: world.accountA, companyId: world.companyA1, ops: OPS, makeGateway });

  console.log('ACBP-P4-007 — Slice D: planned work (strategy → roadmap → milestones → tasks → states)\n');
  for (const step of steps) {
    console.log(`${step.ok ? 'PASS' : 'FAIL'}  [${step.requirement}] ${step.step}`);
    console.log(`      ${step.detail}`);
    if (!step.ok) exitCode = 1;
  }

  // Defense-in-depth (matches the CI suite): the journey must have run its FULL 14-step sequence, not a truncated one.
  // `bail()` returns early, so a short run would otherwise print only passes and read as a success.
  if (steps.length !== 14) {
    exitCode = 1;
    console.log(`FAIL  [sequence] expected 14 journey steps, got ${steps.length} (a truncated run must not read as a pass)`);
  }
  const failures = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failures}/${steps.length} steps passed`);
  console.log(exitCode === 0 ? '\nSlice D demo PASSED — strategy selected, decision recorded, roadmap and tasks planned, board states and controls behaving, trail verified.' : '\nSlice D demo FAILED — see the FAIL steps above.');
} catch (error) {
  exitCode = 1;
  console.error('\nSlice D demo FAILED with an unexpected error:', error instanceof Error ? error.message : String(error));
} finally {
  await teardown(owner, product).catch(() => undefined);
}
process.exit(exitCode);
