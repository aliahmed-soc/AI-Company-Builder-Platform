// ACBP-P2-003 / CDR-026 — real-PostgreSQL proof of the model-gateway composition through the RESTRICTED role.
// Setup/seed runs on the owner connection; every gateway call meters through `acbp_app` under a company scope.
// Proves: a successful call writes exactly ONE ok usage event (correct company/account/provider/model/cost); an
// errored call is metered too (outcome=error + normalized category, zero tokens); a fallback call records
// provider=fallback + fallback_used; cross-company isolation (each row lands under its own company; a company-B
// scope cannot see company-A usage); and FAIL-CLOSED metering (a usage-write failure aborts the call, withholds
// the output, and leaves NO row). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import { toModelId, type ModelGatewayRequest } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, type ResolvedProvider } from '../index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

function resolved(name: string, script: FakeProviderBehavior[] | FakeProviderBehavior): ResolvedProvider {
  const opts = Array.isArray(script) ? { script } : { behavior: script };
  return { name, modelId: toModelId(`${name}-model`), modelVersion: 'v1', provider: new FakeModelProvider(opts) };
}

describe.skipIf(!hasTestDatabase)('model gateway composition (real PostgreSQL, restricted role) — ACBP-P2-003/CDR-026', () => {
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

  const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens * 5 + outputTokens * 7;

  function request(accountId: string, companyId: string, over: Partial<ModelGatewayRequest> = {}): ModelGatewayRequest {
    return { taskClass: 'extraction', templateRef: 'tmpl@1', contextParts: [{ role: 'user', content: 'go' }], timeoutClass: 'interactive', companyId, accountId, correlationId: 'corr-int', ...over };
  }
  const usageRows = (companyId: string) => owner.kysely.selectFrom('usage_events').selectAll().where('company_id', '=', companyId).execute();

  test('a successful call writes exactly one ok usage event under the company scope', async () => {
    const gw = createModelGateway(product, { primary: resolved('primary', { kind: 'respond', output: 'result', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }), estimateCost });
    const res = await gw(request(w.accountA, w.companyA1));
    expect(res.outcome).toBe('ok');
    expect(res.validatedOutput).toBe('result');
    const rows = await usageRows(w.companyA1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: w.accountA,
      company_id: w.companyA1,
      kind: 'model_call',
      provider: 'primary',
      model: 'primary-model@v1',
      task_class: 'extraction',
      outcome: 'ok',
      error_category: null,
      input_tokens: 3,
      output_tokens: 2,
      estimated_cost_micros: 3 * 5 + 2 * 7,
      fallback_used: false,
      correlation_id: 'corr-int',
    });
  });

  test('a persisted usage row carries no prompt/context content (row-level redaction)', async () => {
    // The append-only ledger has no content column by construction; prove it directly — a canary planted in the
    // request context must NOT appear anywhere in the serialized persisted row.
    const canary = 'PLANTED-CONTEXT-CANARY-int-7c1f';
    const gw = createModelGateway(product, { primary: resolved('primary', { kind: 'respond', output: 'result' }), estimateCost });
    const res = await gw(request(w.accountA, w.companyA1, { contextParts: [{ role: 'user', content: `secret ${canary}` }] }));
    expect(res.outcome).toBe('ok');
    const rows = await usageRows(w.companyA1);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(canary);
  });

  test('an errored call is metered too (outcome=error + normalized category, zero tokens)', async () => {
    const gw = createModelGateway(product, { primary: resolved('primary', { kind: 'fail', error: 'content_refused' }), estimateCost, config: { maxRetries: 0 } });
    const res = await gw(request(w.accountA, w.companyA1));
    expect(res.outcome).toBe('error');
    expect(res.errorCategory).toBe('content_refused');
    const rows = await usageRows(w.companyA1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'error', error_category: 'content_refused', input_tokens: 0, output_tokens: 0, estimated_cost_micros: 0 });
  });

  test('a fallback call records provider=fallback + fallback_used', async () => {
    const gw = createModelGateway(product, {
      primary: resolved('primary', { kind: 'fail', error: 'provider_unavailable' }),
      fallback: resolved('fallback', { kind: 'respond', output: 'from-fallback' }),
      estimateCost,
      config: { maxRetries: 0 },
    });
    const res = await gw(request(w.accountA, w.companyA1, { taskClass: 'extraction' }));
    expect(res.outcome).toBe('ok');
    const rows = await usageRows(w.companyA1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'fallback', model: 'fallback-model@v1', fallback_used: true, outcome: 'ok' });
  });

  test('cross-company isolation: each call meters under its OWN company; a B-scope read cannot see A usage', async () => {
    const gw = createModelGateway(product, { primary: resolved('primary', { kind: 'respond', output: 'x' }), estimateCost });
    await gw(request(w.accountA, w.companyA1));
    await gw(request(w.accountB, w.companyB1));
    expect(await usageRows(w.companyA1)).toHaveLength(1);
    expect(await usageRows(w.companyB1)).toHaveLength(1);
    // Under a company-B tenant scope, company-A usage is invisible (dual-keyed RLS).
    const { withTenantTransaction } = await import('@acbp/database');
    const visibleToB = await withTenantTransaction(product, { accountId: w.accountB, companyId: w.companyB1 }, async (scope) => scope.db.selectFrom('usage_events').selectAll().execute());
    expect(visibleToB.every((r) => r.company_id === w.companyB1)).toBe(true);
    expect(visibleToB).toHaveLength(1);
  });

  test('FAIL-CLOSED metering: a usage-write failure aborts the call, withholds the output, and leaves no row', async () => {
    // A non-existent company id makes the usage insert violate the company FK → the metering tx rolls back and
    // the gateway rethrows. The model "call" happened (fake responded) but the output is deliberately withheld.
    const badCompany = '00000000-0000-0000-0000-0000000000ff';
    const gw = createModelGateway(product, { primary: resolved('primary', { kind: 'respond', output: 'withheld' }), estimateCost });
    await expect(gw(request(w.accountA, badCompany))).rejects.toThrow();
    expect(await usageRows(badCompany)).toHaveLength(0);
    // And nothing leaked into a real company either.
    expect(await usageRows(w.companyA1)).toHaveLength(0);
  });
});
