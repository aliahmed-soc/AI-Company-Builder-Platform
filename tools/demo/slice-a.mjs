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

const url = process.env['ACBP_TEST_DATABASE_URL'];
if (!url) {
  console.error('demo:slice-a — ACBP_TEST_DATABASE_URL is required (point it at a disposable PostgreSQL, e.g. the CI test database).');
  process.exit(2);
}

// Install the resolution hook before anything imports a route module: it stubs `@clerk/nextjs/server` (the
// stub supplies a VERIFIED primary email, so the production boundary's ACC-001 rule is genuinely exercised
// rather than bypassed) and resolves the `@/…` alias the route modules import through. Pass the URL object —
// `pathToFileURL` on a URL's `pathname` doubles the drive letter on Windows.
register(new URL('./clerk-stub-loader.mjs', import.meta.url));

const { createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, runtimeConnectionRoles, configureRouteRuntimeEnv, runSliceAJourney } = await import('@acbp/test-support');
const { provisionPersonalAccount, createCompany, pauseCompany } = await import('@acbp/core');

// The SAME wiring the CI suites use — including removing DATABASE_URL, so the runtime cannot reach the owner
// connection. Owned by the harness so the demo can never drift from the suites' configuration.
configureRouteRuntimeEnv();

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
    foreignCompanyName: world.companyNames[2],
    foreignAccountId: world.accountB,
  });

  console.log('ACBP-P1-015 — Slice A: secure company creation\n');
  for (const step of steps) {
    console.log(`${step.ok ? 'PASS' : 'FAIL'}  [${step.requirement}] ${step.step}`);
    console.log(`      ${step.detail}`);
    if (!step.ok) exitCode = 1;
  }
  // Positive evidence about the ROUTE RUNTIME's own pool, not the fixture's: after serving the journey it
  // must hold connections, and every one of them must be the restricted role.
  const backends = await runtimeConnectionRoles(owner, ['acbp-adversarial-fixture', 'acbp-adversarial-app']);
  const runtimeRestricted = backends.length > 0 && backends.every((b) => b.role === 'acbp_app');
  console.log(`${runtimeRestricted ? 'PASS' : 'FAIL'}  [NFR-001] route runtime connected as the restricted role`);
  console.log(`      ${String(backends.length)} runtime backend(s): ${backends.map((b) => b.role).join(', ') || 'none'}`);
  if (!runtimeRestricted) exitCode = 1;

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
