// ACBP-P5-015 / CDR-065 — the runnable Slice E demo: `pnpm demo:slice-e`.
//
// Performs the M5 exit journey (preflight → queue → run → research document → provenance → completion → settlement →
// ledger → activity/audit → revision → lineage, then the negative set) against the configured PostgreSQL, printing
// each step and its evidence, and exiting NON-ZERO if any step does not hold. This is the backlog row's "Run demo
// script" verification procedure.
//
// The journey itself is `runSliceEJourney` in @acbp/test-support — the SAME implementation the CI suite asserts
// (packages/core/src/workers/slice-e.e2e.integration.test.ts) — so the demo can never drift from the guarantee.
// Everything inside the trust boundary is production code: the real @acbp/core use cases + the P2-003 gateway,
// @acbp/database, and the restricted `acbp_app` connection under FORCE RLS. Exactly three edges OUTSIDE that boundary
// are seamed — the model provider (deterministic FakeModelProvider), the research fetcher (in-memory), and object
// storage (in-memory). NO live model, NO real key, NO network, NO spend (CDR-065 §2-G3).
//
// Requires ACBP_TEST_DATABASE_URL (the same disposable database the integration suites use). Uses NO production
// credentials.
const url = process.env['ACBP_TEST_DATABASE_URL'];
if (!url) {
  console.error('demo:slice-e — ACBP_TEST_DATABASE_URL is required (point it at a disposable PostgreSQL, e.g. the CI test database).');
  process.exit(2);
}

const { createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceEJourney } = await import('@acbp/test-support');
const core = await import('@acbp/core');
const { toModelId } = await import('@acbp/contracts');
const { FakeModelProvider, InMemoryObjectStorage, InMemoryResearchFetcher } = await import('@acbp/adapters');

const {
  provisionPersonalAccount, createCompany, pauseCompany,
  createModelGateway, researchOutputValidator,
  createTask, planTask,
  preflightRun, reserveCredit, settleRun, readCreditLedger,
  startRun, succeedRun, failRun,
  runResearch, listRunArtifacts, completeTask,
  requestRevision, readArtifactLineage,
  getCompanyActivity,
} = core;

// The injected @acbp/core use cases (names match SliceEOps). Same wiring as the CI suite, so the demo can never drift.
const OPS = {
  createTask, planTask, preflightRun, startRun, reserveCredit, runResearch, listRunArtifacts,
  succeedRun, failRun, completeTask, settleRun, readCreditLedger, getCompanyActivity,
  requestRevision, readArtifactLineage,
};
const estimateCost = ({ inputTokens, outputTokens }) => inputTokens + outputTokens;

const EXPECTED_STEPS = 17;

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
  const makeGateway = (behavior) =>
    createModelGateway(product, { primary: { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) }, estimateCost, validateOutput: researchOutputValidator, config: { maxRetries: 0, maxReask: 0 } });
  const makeFetcher = (question, sources) => {
    const fetcher = new InMemoryResearchFetcher();
    fetcher.seed(question, sources);
    return fetcher;
  };
  const makeStorage = () => new InMemoryObjectStorage();

  await truncateFixtures(owner);
  const world = await seedTwoTenantWorld(owner, product, { provisionPersonalAccount, createCompany, pauseCompany });
  console.log('· seeded a company owner to drive the execution journey\n');

  const { steps } = await runSliceEJourney({ product, owner, userId: world.aOwner, accountId: world.accountA, companyId: world.companyA1, ops: OPS, makeGateway, makeFetcher, makeStorage });

  console.log('ACBP-P5-015 — Slice E: safe internal execution (preflight → run → document → ledger → revision)\n');
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
    console.log('\nSlice E demo PASSED — a research task was priced, run, documented with checked citations, completed, settled and revised; the ledger reconciles and the failure paths refuse honestly.');
    // Said in the demo output, not only in the CDR: a reader who sees seventeen green steps should not conclude more
    // than the run actually demonstrated (CDR-065 §2-G1, §5-G9).
    console.log('NOTE  the credit here is reserved by the JOURNEY, not automatically by the queue transition — no code wires that yet (CDR-065 §2-G1).');
    console.log('NOTE  this reconciles the credit LEDGER and the AUDIT trail. The founder-facing ACTIVITY feed shows nothing of this run: ACTIVITY_TYPES projects only company.* events (P6-008 owns that, with P6-009 for usage rollups).');
  } else {
    console.log('\nSlice E demo FAILED — see the FAIL steps above.');
  }
} catch (error) {
  exitCode = 1;
  console.error('\nSlice E demo FAILED with an unexpected error:', error instanceof Error ? error.message : String(error));
} finally {
  await teardown(owner, product).catch(() => undefined);
}
process.exit(exitCode);
