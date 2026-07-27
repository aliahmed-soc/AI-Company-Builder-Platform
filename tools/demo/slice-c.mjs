// ACBP-P3-007 / CDR-045 — the runnable Slice C demo: `pnpm demo:slice-c`.
//
// Performs the M3 exit journey (confirmed understanding → three distinct options → advisory comparison → owner
// selection → immutable decision) against the configured PostgreSQL, INCLUDING both negatives the backlog names by
// hand — the distinctness rejection demo and record-failure-blocks — printing each step and its evidence, and exiting
// NON-ZERO if any step does not hold. This is the backlog row's "Run demo script" verification procedure.
//
// The journey itself is `runSliceCJourney` in @acbp/test-support — the SAME implementation the CI suite asserts
// (packages/core/src/strategy/slice-c.e2e.integration.test.ts) — so the demo can never drift from the guarantee.
// Everything below the model-PROVIDER edge is production code: the real @acbp/core use cases + the P2-003 gateway,
// @acbp/database, and the restricted `acbp_app` connection under FORCE RLS. The provider edge is the deterministic
// FakeModelProvider — NO live model, NO real key, NO snapshot pin (CDR-026 §0/§3).
//
// Requires ACBP_TEST_DATABASE_URL (the same disposable database the integration suites use). Uses NO production
// credentials.
const url = process.env['ACBP_TEST_DATABASE_URL'];
if (!url) {
  console.error('demo:slice-c — ACBP_TEST_DATABASE_URL is required (point it at a disposable PostgreSQL, e.g. the CI test database).');
  process.exit(2);
}

const { createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceCJourney } = await import('@acbp/test-support');
const core = await import('@acbp/core');
const { toModelId } = await import('@acbp/contracts');
const { FakeModelProvider } = await import('@acbp/adapters');

const {
  provisionPersonalAccount, createCompany, pauseCompany,
  createModelGateway, understandingOutputValidator, strategyOutputValidator, strategyRecommendationValidator,
  generateUnderstanding, confirmUnderstanding,
  generateStrategyOptions, getLatestStrategyGeneration, recommendStrategy, recordStrategyDecision, recordDecision,
} = core;

// The injected @acbp/core use cases (names match SliceCOps) + the fake-provider gateway factory. Same wiring as the
// CI suite, so the demo can never drift from the guarantee.
const OPS = { generateUnderstanding, confirmUnderstanding, generateStrategyOptions, getLatestStrategyGeneration, recommendStrategy, recordStrategyDecision, recordDecision };
const estimateCost = ({ inputTokens, outputTokens }) => inputTokens + outputTokens;

const validatorFor = (validator) => {
  if (validator === 'understanding') return understandingOutputValidator;
  if (validator === 'strategy') return strategyOutputValidator;
  return strategyRecommendationValidator;
};
const makeGateway = (validator, behavior) =>
  createModelGateway(product, { primary: { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) }, estimateCost, validateOutput: validatorFor(validator), config: { maxRetries: 0, maxReask: 0 } });

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
  console.log('· seeded a company owner (plus a second company to isolate the negatives)\n');

  const { steps } = await runSliceCJourney({ product, owner, userId: world.aOwner, accountId: world.accountA, companyId: world.companyA1, negativeCompanyId: world.companyA2, ops: OPS, makeGateway });

  console.log('ACBP-P3-007 — Slice C: strategy selection (understanding → options → compare → select → decision)\n');
  for (const step of steps) {
    console.log(`${step.ok ? 'PASS' : 'FAIL'}  [${step.requirement}] ${step.step}`);
    console.log(`      ${step.detail}`);
    if (!step.ok) exitCode = 1;
  }

  // Defense-in-depth (matches the CI suite): the journey must have run its FULL 10-step sequence, not a truncated
  // one. `bail()` returns early, so a short run would otherwise print only passes and read as a success — and the two
  // negatives are the LAST steps, so a truncated run is exactly how they would go missing unnoticed.
  if (steps.length !== 10) {
    exitCode = 1;
    console.log(`FAIL  [sequence] expected 10 journey steps, got ${steps.length} (a truncated run must not read as a pass)`);
  }
  const failures = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failures}/${steps.length} steps passed`);
  console.log(exitCode === 0 ? '\nSlice C demo PASSED — three distinct options compared, the owner selected, the decision recorded; near-duplicates collapsed honestly and a failed audit write blocked the record.' : '\nSlice C demo FAILED — see the FAIL steps above.');
} catch (error) {
  exitCode = 1;
  console.error('\nSlice C demo FAILED with an unexpected error:', error instanceof Error ? error.message : String(error));
} finally {
  await teardown(owner, product).catch(() => undefined);
}
process.exit(exitCode);
