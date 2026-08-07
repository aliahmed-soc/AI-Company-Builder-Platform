// ACBP-P7-009 / CDR-085 — the runnable MVP loop demo: `pnpm demo:mvp-loop`.
//
// Carries ONE company the whole way — the founder's typed answer → memory → understanding → confirmation →
// strategy → decision → roadmap → planned tasks → THE PLANNED TASK RUNNING → a cited document → completion →
// settlement → a revision that re-executes → and a final walk back down the chain from the revised document to the
// account — printing each step and its evidence, and exiting NON-ZERO if any step does not hold. This is the
// backlog row's "Run demo script" verification procedure.
//
// The journey itself is `runMvpLoopJourney` in @acbp/test-support — the SAME implementation the CI suite asserts
// (packages/core/src/workers/mvp-loop.e2e.integration.test.ts) — so the demo can never drift from the guarantee.
// Everything inside the trust boundary is production code: the real @acbp/core use cases, @acbp/database, and the
// restricted `acbp_app` connection under FORCE RLS. Exactly THREE edges outside that boundary are seamed — the
// model provider (deterministic FakeModelProvider), the research fetcher, and object storage. NO live model, NO
// real key, NO network, NO spend.
//
// Requires ACBP_TEST_DATABASE_URL (the same disposable database the integration suites use). Uses NO production
// credentials.
const url = process.env['ACBP_TEST_DATABASE_URL'];
if (!url) {
  console.error('demo:mvp-loop — ACBP_TEST_DATABASE_URL is required (point it at a disposable PostgreSQL, e.g. the CI test database).');
  process.exit(2);
}

const { createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runMvpLoopJourney } = await import('@acbp/test-support');
const core = await import('@acbp/core');
const { toModelId } = await import('@acbp/contracts');
const { FakeModelProvider, InMemoryObjectStorage, InMemoryResearchFetcher } = await import('@acbp/adapters');

const {
  provisionPersonalAccount, createCompany, pauseCompany,
  createModelGateway,
  interviewOutputValidator, understandingOutputValidator, strategyOutputValidator, roadmapOutputValidator, taskPlanOutputValidator, researchOutputValidator,
  startInterviewSession, addInterviewQuestion, evaluateAnswer,
  listMemoryItems,
  generateUnderstanding, confirmUnderstanding, isCurrentUnderstandingConfirmed,
  generateStrategyOptions, recordStrategyDecision, recordDecision,
  generateRoadmap, generateTasks,
  planTask,
  preflightRun, reserveCredit, settleRun,
  startRun, succeedRun,
  listRunArtifacts, completeTask, requestRevision, readArtifactLineage,
  runResearch,
} = core;

// The injected @acbp/core use cases (names match MvpLoopOps). Same wiring as the CI suite, so the demo cannot drift.
const OPS = {
  startInterviewSession, addInterviewQuestion, evaluateAnswer,
  listMemoryItems,
  generateUnderstanding, confirmUnderstanding, isCurrentUnderstandingConfirmed,
  generateStrategyOptions, recordStrategyDecision, recordDecision,
  generateRoadmap, generateTasks,
  planTask,
  preflightRun, startRun, reserveCredit,
  runResearch, listRunArtifacts,
  succeedRun, completeTask, settleRun,
  requestRevision, readArtifactLineage,
};

const estimateCost = ({ inputTokens, outputTokens }) => inputTokens + outputTokens;

const EXPECTED_STEPS = 11;

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
  const makeGateway = (validator, behavior, opts = {}) => {
    const primary = { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
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
  const makeFetcher = (question, sources) => {
    const fetcher = new InMemoryResearchFetcher();
    fetcher.seed(question, sources);
    return fetcher;
  };
  const makeStorage = () => new InMemoryObjectStorage();

  await truncateFixtures(owner);
  const world = await seedTwoTenantWorld(owner, product, { provisionPersonalAccount, createCompany, pauseCompany });
  console.log('· seeded a company owner, plus an UNRELATED second account the loop must never touch\n');

  const { steps } = await runMvpLoopJourney({
    product,
    owner,
    userId: world.aOwner,
    accountId: world.accountA,
    companyId: world.companyA1,
    foreignAccountId: world.accountB,
    ops: OPS,
    makeGateway,
    makeFetcher,
    makeStorage,
  });

  console.log('ACBP-P7-009 — the MVP loop: one company, from the founder’s first answer to a revised document that still descends from their account\n');
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
    console.log('\nMVP loop demo PASSED — the document the founder revised descends, hop by hop, from the answer they typed: no stage was skipped, the task that ran was the one planning produced, and nothing reached the unrelated account.');
    // Said in the demo output, not only in the CDR: a reader who sees eleven green steps should not conclude more
    // than the run actually demonstrated (CDR-085 §4).
    console.log('NOTE  THIS RUN IS HEADLESS. It drives use cases, not a browser, so it does NOT show that a founder could complete this loop in the UI. The staging-real half of ACBP-P7-009 depends on ACBP-P7-006 and is not covered here.');
    console.log('NOTE  The mechanisms are NOT re-proven here. Distinctness, phase bounding, citation certification, settlement and the negative sets belong to Slices B–E; this run asserts only that they COMPOSE (CDR-085 §2).');
    console.log('NOTE  Two hops ran on the OWNER connection because NO use case implements them: `planned→queued` and `queued→running` (CDR-065 §3-G5c). They are preconditions, not demonstrations.');
  } else {
    console.log('\nMVP loop demo FAILED — see the FAIL steps above.');
  }
} catch (error) {
  exitCode = 1;
  console.error('\nMVP loop demo FAILED with an unexpected error:', error instanceof Error ? error.message : String(error));
} finally {
  await teardown(owner, product).catch(() => undefined);
}
process.exit(exitCode);
