// ACBP-P5-007 / CDR-062 — the strategy worker end to end, against a REAL database.
//
// The claim under test is WORK-003's failure clause: **"insufficient input = specific request"**. Tested through the
// USE CASE, because a contract nobody calls enforces nothing — and the ask path asserts that NO artifact was written,
// since filing a question as a document would put a request for information into the founder's library next to their
// actual work product.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { InMemoryObjectStorage } from '@acbp/adapters';
import type { DatabaseClient } from '@acbp/database';
import type { ModelGatewayRequest, ModelGatewayResult } from '@acbp/contracts';
import { STRATEGY_OPTION_FIELDS, UNKNOWN_FIELD, parseComparisonOutput } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { runStrategyComparison } from './comparison.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const QUESTION = 'Compare subscription and marketplace models for an independent gym platform.';
const UNDERSTANDING = '- [fact] The founder runs three gyms in Manchester.';

const fields = (over: Record<string, string> = {}): Record<string, string> => {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f}-value`;
  return { ...o, ...over };
};
const model = (name: string, over: Record<string, string> = {}) => ({ name, fields: fields(over) });
const comparison = (models: unknown[]) => ({ kind: 'comparison', models });
const request = (field: string) => ({ field, why: `The comparison needs ${field}.`, example: `e.g. a concrete ${field}` });

function gatewayReturning(output: unknown, outcome: ModelGatewayResult['outcome'] = 'ok') {
  const calls: ModelGatewayRequest[] = [];
  const fn = (req: ModelGatewayRequest): Promise<ModelGatewayResult> => {
    calls.push(req);
    if (outcome !== 'ok') return Promise.resolve({ outcome, provider: 'fake', model: 'fake', modelVersion: 'fake@1', fallbackUsed: false, latencyMs: 1 } as ModelGatewayResult);
    const parsed = parseComparisonOutput(output);
    return Promise.resolve({ outcome: 'ok', validatedOutput: parsed.ok ? parsed.outcome : output, provider: 'fake', model: 'fake', modelVersion: 'fake@1', fallbackUsed: false, latencyMs: 1 } as ModelGatewayResult);
  };
  return { fn, calls };
}

describe.skipIf(!hasTestDatabase)('the strategy worker (real PostgreSQL) — ACBP-P5-007/CDR-062', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let storage: InMemoryObjectStorage;
  let runId = '';

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
    storage = new InMemoryObjectStorage();
    const task = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, task_type, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'running', 'compare models', 'business_model_comparison', ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    runId = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${task}::uuid, 1) returning id`.execute(owner.kysely)).rows[0]!.id;
  }, 60_000);

  const params = (over: Record<string, unknown> = {}) => ({
    userId: w.aOwner,
    accountId: w.accountA,
    companyId: w.companyA1,
    runId,
    question: QUESTION,
    understanding: UNDERSTANDING,
    workerVersion: 1,
    modelVersion: 'fake@1',
    ...over,
  });

  async function artifactCount(): Promise<number> {
    const r = await sql<{ n: string }>`select count(*)::text as n from artifacts`.execute(owner.kysely);
    return Number(r.rows[0]!.n);
  }

  describe('the comparison path', () => {
    test('persists a markdown artifact meeting the STRAT-002 standard', async () => {
      const gateway = gatewayReturning(comparison([model('Subscription'), model('Marketplace')]));
      const result = await runStrategyComparison(product, params(), { gateway: gateway.fn, storage });

      expect(result).toMatchObject({ status: 'ok', modelsCompared: 2 });
      if (result.status !== 'ok') return;
      expect(result.artifact.workerId).toBe('strategy');
      expect(result.artifact.format).toBe('markdown');
      expect(await artifactCount()).toBe(1);

      const stored = await storage.get(result.artifact.objectKey as never);
      const markdown = new TextDecoder().decode(stored.body as Uint8Array);
      expect(markdown).toContain('## Subscription');
      expect(markdown).toContain('## Marketplace');
      // All sixteen fields rendered, for every model.
      for (const field of STRATEGY_OPTION_FIELDS) expect(markdown).toContain(`**${field}**`);
    });

    test('a field marked `unknown` is rendered, not hidden — a document must not look more complete than its analysis', async () => {
      const gateway = gatewayReturning(comparison([model('Subscription', { cost_range: UNKNOWN_FIELD }), model('Marketplace')]));
      const result = await runStrategyComparison(product, params(), { gateway: gateway.fn, storage });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      const stored = await storage.get(result.artifact.objectKey as never);
      expect(new TextDecoder().decode(stored.body as Uint8Array)).toContain(`**cost_range**: ${UNKNOWN_FIELD}`);
    });
  });

  describe('"insufficient input = specific request" (WORK-003)', () => {
    test('a specific request is a COMPLETE outcome — and writes no artifact', async () => {
      const gateway = gatewayReturning({ kind: 'insufficient_input', missing: [request('target customer'), request('price point')] });
      const result = await runStrategyComparison(product, params(), { gateway: gateway.fn, storage });

      expect(result.status).toBe('needs_input');
      if (result.status !== 'needs_input') return;
      expect(result.missing).toHaveLength(2);
      // The founder gets what is needed, why, and what a usable answer looks like — not "insufficient information".
      expect(result.missing[0]).toMatchObject({ field: 'target customer' });
      expect(result.missing[0]?.why.length).toBeGreaterThan(0);
      expect(result.missing[0]?.example.length).toBeGreaterThan(0);

      // A question is not a produced document.
      expect(await artifactCount()).toBe(0);
      expect(storage.keys()).toEqual([]);
    });

    test('the SHRUG is refused — "insufficient_input" with nothing asked for is not a specific request', async () => {
      const gateway = gatewayReturning({ kind: 'insufficient_input', missing: [] });
      expect(await runStrategyComparison(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'unusable_output', reason: 'vague_request' });
      expect(await artifactCount()).toBe(0);
    });

    test('a VAGUE request is refused — each item must say what, why and what good looks like', async () => {
      const gateway = gatewayReturning({ kind: 'insufficient_input', missing: [{ field: 'more information', why: '', example: '' }] });
      expect(await runStrategyComparison(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'unusable_output', reason: 'vague_request' });
      expect(await artifactCount()).toBe(0);
    });
  });

  describe('the padding and guessing paths are closed', () => {
    test('ONE model is not a comparison — the smallest form of padding', async () => {
      const gateway = gatewayReturning(comparison([model('Subscription')]));
      expect(await runStrategyComparison(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'unusable_output', reason: 'not_a_comparison' });
      expect(await artifactCount()).toBe(0);
    });

    test('two labels for one model is not a comparison either', async () => {
      const gateway = gatewayReturning(comparison([model('Subscription'), model('subscription ')]));
      expect(await runStrategyComparison(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'unusable_output', reason: 'duplicate_model' });
      expect(await artifactCount()).toBe(0);
    });

    test('a model short of the sixteen fields persists nothing', async () => {
      const partial = fields();
      delete partial['success_metrics'];
      const gateway = gatewayReturning(comparison([{ name: 'Subscription', fields: partial }, model('Marketplace')]));
      expect(await runStrategyComparison(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'unusable_output', reason: 'incomplete_fields', index: 0 });
      expect(await artifactCount()).toBe(0);
    });
  });

  describe('failures and authority', () => {
    test('a blank question is refused before the model is called', async () => {
      const gateway = gatewayReturning(comparison([model('A'), model('B')]));
      expect(await runStrategyComparison(product, params({ question: '   ' }), { gateway: gateway.fn, storage })).toMatchObject({ status: 'blank_question' });
      expect(gateway.calls).toHaveLength(0);
    });

    test('a gateway failure persists nothing', async () => {
      const gateway = gatewayReturning(null, 'error');
      expect(await runStrategyComparison(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'generation_failed' });
      expect(await artifactCount()).toBe(0);
    });

    test('a storage write that lies about succeeding fails the run', async () => {
      storage.dropNextPut();
      const gateway = gatewayReturning(comparison([model('A'), model('B')]));
      expect(await runStrategyComparison(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'persist_failed' });
      expect(await artifactCount()).toBe(0);
    });

    test("another company's owner cannot write a comparison into this company", async () => {
      const gateway = gatewayReturning(comparison([model('A'), model('B')]));
      expect(await runStrategyComparison(product, params({ userId: w.bOwner }), { gateway: gateway.fn, storage })).toMatchObject({ status: 'persist_failed', reason: 'forbidden' });
      expect(await artifactCount()).toBe(0);
      expect(storage.keys()).toEqual([]);
    });

    test('this worker never fetches external content — the prompt carries only internal material', async () => {
      // The backlog's security column is "Internal tools only". Stated as a property here so a future edit that
      // added a fetch to this worker would have to delete an assertion rather than merely slip past a comment.
      const gateway = gatewayReturning(comparison([model('A'), model('B')]));
      await runStrategyComparison(product, params(), { gateway: gateway.fn, storage });
      const prompt = gateway.calls[0]?.contextParts.map((p) => p.content).join('\n') ?? '';
      expect(prompt).toContain(UNDERSTANDING);
      expect(prompt).not.toContain('untrusted source material');
      expect(prompt).not.toContain('Retrieved sources');
    });
  });
});
