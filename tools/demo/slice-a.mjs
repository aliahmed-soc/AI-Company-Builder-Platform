// ACBP-P1-015 / CDR-021 — the runnable Slice A demo: `pnpm demo:slice-a`.
//
// Performs the M1 exit journey against the configured PostgreSQL, printing each step and its evidence, and
// exiting NON-ZERO if any step — including the closing live cross-tenant denial — does not hold. This is the
// backlog row's "Run demo script" verification procedure.
//
// The journey itself is `runSliceAJourney` in @acbp/test-support, the SAME implementation the CI suite
// asserts (apps/web/src/server/adversarial/slice-a.e2e.integration.test.ts), so the demo can never drift from
// the guarantee. Everything below the provider-SDK edge is production code: the real route handlers, the
// composed runtime, @acbp/core, @acbp/database and the restricted `acbp_app` connection under FORCE RLS.
//
// Requires ACBP_TEST_DATABASE_URL (the same database the integration suites use). Uses NO production
// credentials and never contacts a live Clerk instance: the provider SDK is stubbed at its edge via a Node
// module-resolution hook, while the production authentication boundary still runs in full.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const url = process.env['ACBP_TEST_DATABASE_URL'];
if (!url) {
  console.error('demo:slice-a — ACBP_TEST_DATABASE_URL is required (point it at a disposable PostgreSQL, e.g. the CI test database).');
  process.exit(2);
}

// Stub `@clerk/nextjs/server` before anything imports it. The stub supplies a VERIFIED primary email, so the
// production boundary's ACC-001 email-verification rule is genuinely exercised rather than bypassed.
register(pathToFileURL(new URL('./clerk-stub-loader.mjs', import.meta.url).pathname));

const { createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runSliceAJourney, APP_ROLE_TEST_PASSWORD } = await import('@acbp/test-support');
const { provisionPersonalAccount, createCompany, pauseCompany } = await import('@acbp/core');

const appUrl = new URL(url);
appUrl.username = 'acbp_app';
appUrl.password = APP_ROLE_TEST_PASSWORD;
process.env['APP_ENV'] = 'test';
process.env['DATABASE_APP_URL'] = appUrl.toString();
delete process.env['DATABASE_URL']; // the runtime must not be able to reach the owner connection
process.env['DATABASE_SSL'] = process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable';
process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] = 'pk_test_slice_a_synthetic';
process.env['CLERK_SECRET_KEY'] = 'sk_test_slice_a_synthetic';
process.env['CLERK_WEBHOOK_SIGNING_SECRET'] = 'whsec_slice_a_synthetic';
process.env['CLERK_WEBHOOK_INSTANCE_ID'] = 'ins_adversarial';

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
  console.log(`· product connection verified: role=${proof.currentUser} superuser=${proof.isSuperuser} bypassrls=${proof.bypassesRls}`);

  await truncateFixtures(owner);
  const world = await seedTwoTenantWorld(owner, product, { provisionPersonalAccount, createCompany, pauseCompany });
  console.log('· seeded a second, unrelated tenant to be denied at the end\n');

  const companies = await import('../../apps/web/src/app/api/companies/route.js');
  const company = await import('../../apps/web/src/app/api/companies/[companyId]/route.js');
  const activity = await import('../../apps/web/src/app/api/companies/[companyId]/activity/route.js');

  const setSession = (await import('./clerk-stub-state.mjs')).setSession;
  const { steps, companyId } = await runSliceAJourney({
    signInAs: async (internalUserId) => {
      const row = await owner.kysely.selectFrom('users').select('provider_user_id').where('id', '=', internalUserId).executeTakeFirstOrThrow();
      setSession(row.provider_user_id);
    },
    routes: { companiesGet: companies.GET, companiesPost: companies.POST, companyGet: company.GET, activityGet: activity.GET },
    owner,
    actorUserId: world.outsider,
    foreignCompanyId: world.companyB1,
    foreignCompanyName: 'Beta One',
    foreignAccountId: world.accountB,
  });

  console.log('ACBP-P1-015 — Slice A: secure company creation\n');
  for (const step of steps) {
    console.log(`${step.ok ? 'PASS' : 'FAIL'}  [${step.requirement}] ${step.step}`);
    console.log(`      ${step.detail}`);
    if (!step.ok) exitCode = 1;
  }
  const failures = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failures}/${steps.length} steps passed; company ${companyId ?? '(not created)'}`);
  console.log(exitCode === 0 ? '\nSlice A demo PASSED, including the live cross-tenant denial.' : '\nSlice A demo FAILED — see the FAIL steps above.');
} catch (error) {
  exitCode = 1;
  console.error('\nSlice A demo FAILED with an unexpected error:', error instanceof Error ? error.message : String(error));
} finally {
  await teardown(owner, product).catch(() => undefined);
}
process.exit(exitCode);
