// ACBP-P3-003 / CDR-036 — real-PostgreSQL proof of recommendStrategy through the RESTRICTED role, driven by the P2-003
// gateway with the deterministic FAKE provider + the recommendation validator. Proves: a valid recommendation persists
// ONE immutable row + is surfaced on the read; STRAT-004 deny-by-default (honest abstain, blank rationale, out-of-range
// ordinal → nothing persisted, recommendation null); a gateway failure / malformed output → recommendation_failed
// (nothing persisted); NEVER auto-selects (only a strategy_recommendations row is written — no selection/decision);
// append-only / latest-wins; owner+viewer allowed / non-member forbidden; not_found; cross-company isolation. Skips when
// ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { toModelId, STRATEGY_OPTION_FIELDS } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, strategyRecommendationValidator, type ResolvedProvider } from '../index.js';
import { recommendStrategy, getLatestStrategyGeneration } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

function resolved(behavior: FakeProviderBehavior): ResolvedProvider {
  return { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
}
function optionFields(i: number): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f}-v`;
  return { ...o, customer: `customer-${i}`, offer: `offer-${i}`, business_model: `model-${i}` };
}
const recOutput = (over: Record<string, unknown> = {}) => JSON.stringify({ recommended_ordinal: 1, rationale: 'Best fit for the target customer.', sensitivities: 'Changes if the budget assumption is wrong.', ...over });

describe.skipIf(!hasTestDatabase)('strategy recommendation (real PostgreSQL, restricted role) — ACBP-P3-003/CDR-036', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let genA = '';

  // Seed a generation with `n` distinct options for a company (owner/superuser bypasses RLS).
  async function seedGeneration(accountId: string, companyId: string, actorId: string, n: number): Promise<string> {
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, 1, 'complete', 0.6, ${actorId}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, similarity_check_result, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${doc}::uuid, 1, 'complete', ${n}, 'distinct', ${actorId}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    for (let i = 0; i < n; i += 1) {
      await sql`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountId}::uuid, ${companyId}::uuid, ${gen}::uuid, ${i}, ${JSON.stringify(optionFields(i))}::jsonb)`.execute(owner.kysely);
    }
    return gen;
  }

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
    genA = await seedGeneration(w.accountA, w.companyA1, w.aOwner, 3);
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const gatewayWith = (behavior: FakeProviderBehavior) => createModelGateway(product, { primary: resolved(behavior), estimateCost, validateOutput: strategyRecommendationValidator, config: { maxRetries: 0, maxReask: 0 } });
  const recsFor = async (generationId: string) => (await sql<{ id: string; recommended_option_id: string; rationale: string }>`select id, recommended_option_id, rationale from strategy_recommendations where generation_id = ${generationId}::uuid order by created_at`.execute(owner.kysely)).rows;

  test('a valid recommendation persists ONE immutable row referencing the option + is surfaced on the read', async () => {
    const gw = gatewayWith({ kind: 'respond', output: recOutput({ recommended_ordinal: 1 }) });
    const r = await recommendStrategy(product, { ...base(), generationId: genA }, { gateway: gw });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.recommendation).not.toBeNull();
    expect(r.recommendation?.recommendedOrdinal).toBe(1);
    expect(r.recommendation?.rationale).toBe('Best fit for the target customer.');
    expect(r.recommendation?.sensitivities).toBe('Changes if the budget assumption is wrong.');
    const rows = await recsFor(genA);
    expect(rows).toHaveLength(1);
    // NEVER auto-selects: exactly ONE strategy_recommendations row is written; nothing else. Metered.
    expect((await sql<{ n: number }>`select count(*)::int as n from usage_events where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(1);
    // Surfaced on the read (latest-wins).
    const read = await getLatestStrategyGeneration(product, base());
    expect(read.status === 'ok' && read.generation?.recommendation?.recommendedOrdinal).toBe(1);
  });

  test('DENY-BY-DEFAULT: honest abstain, blank rationale, and out-of-range ordinal each persist NOTHING (recommendation null)', async () => {
    for (const output of [recOutput({ recommended_ordinal: null }), recOutput({ rationale: '   ' }), recOutput({ recommended_ordinal: 9 })]) {
      const r = await recommendStrategy(product, { ...base(), generationId: genA }, { gateway: gatewayWith({ kind: 'respond', output }) });
      expect(r.status === 'ok' && r.recommendation).toBeNull();
    }
    expect(await recsFor(genA)).toHaveLength(0);
  });

  test('a gateway failure and a malformed output each → recommendation_failed (nothing persisted)', async () => {
    expect((await recommendStrategy(product, { ...base(), generationId: genA }, { gateway: gatewayWith({ kind: 'fail', error: 'provider_unavailable' }) })).status).toBe('recommendation_failed');
    expect((await recommendStrategy(product, { ...base(), generationId: genA }, { gateway: gatewayWith({ kind: 'respond', output: 'not json' }) })).status).toBe('recommendation_failed');
    expect(await recsFor(genA)).toHaveLength(0);
  });

  test('not_found: recommending over a generation id that is absent / invisible', async () => {
    const foreign = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(owner.kysely)).rows[0]!.id;
    expect((await recommendStrategy(product, { ...base(), generationId: foreign }, { gateway: gatewayWith({ kind: 'respond', output: recOutput() }) })).status).toBe('not_found');
  });

  test('authz: a viewer is REFUSED (PM ruling 2026-08-14); a non-member is forbidden', async () => {
    // NARROWED by the ACBP-API-004 PM ruling: `strategy:recommend` is owner-only. A viewer READS; commissioning a
    // recommendation spends account budget on a model call, and that is an owner action.
    //
    // THIS ASSERTION WAS INVERTED DELIBERATELY, not bent to make a red build green. It previously asserted the
    // viewer MAY recommend, which was correct under the old grant. The ruling changed the intended behaviour, so
    // the test changes with it — and this comment exists so a later reader sees a decision rather than a fix.
    //
    // It is also the test that corrected me: I claimed the narrowing broke nothing, having read a LOCAL run where
    // this suite is skipIf-gated and skipped. Hosted CI ran it and disagreed. Skipped is not green.
    //
    // THE `forbidden` ON ITS OWN IS NOT ENOUGH, and this is the ACBP-API-008 addition. There are two
    // authorization checks on this path: one before the model call and one inside the persist transaction. Weaken
    // only the FIRST and the caller still receives `forbidden` from the second — while the paid provider call has
    // already happened in between. Every assertion that reads the returned status alone is satisfied by that
    // world, so the counter below is the part that can tell the two apart.
    let paidCalls = 0;
    const counted = (): ReturnType<typeof gatewayWith> => {
      const inner = gatewayWith({ kind: 'respond', output: recOutput() });
      return (request, options) => {
        paidCalls += 1;
        return inner(request, options);
      };
    };

    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, generationId: genA };
    expect((await recommendStrategy(product, viewer, { gateway: counted() })).status).toBe('forbidden');
    expect(paidCalls, 'a VIEWER reached the paid provider before being refused').toBe(0);

    const nonMember = { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, generationId: genA };
    expect((await recommendStrategy(product, nonMember, { gateway: counted() })).status).toBe('forbidden');
    expect(paidCalls, 'a NON-MEMBER reached the paid provider before being refused').toBe(0);
  });

  test('append-only / latest-wins: a second recommendation is a new row and the read surfaces the latest', async () => {
    await recommendStrategy(product, { ...base(), generationId: genA }, { gateway: gatewayWith({ kind: 'respond', output: recOutput({ recommended_ordinal: 0, rationale: 'first pick' }) }) });
    await recommendStrategy(product, { ...base(), generationId: genA }, { gateway: gatewayWith({ kind: 'respond', output: recOutput({ recommended_ordinal: 2, rationale: 'second pick' }) }) });
    expect(await recsFor(genA)).toHaveLength(2);
    const read = await getLatestStrategyGeneration(product, base());
    expect(read.status === 'ok' && read.generation?.recommendation?.recommendedOrdinal).toBe(2);
    expect(read.status === 'ok' && read.generation?.recommendation?.rationale).toBe('second pick');
  });

  test('cross-company isolation: a company A2 recommendation attempt cannot see company A1 generation', async () => {
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2, generationId: genA };
    expect((await recommendStrategy(product, a2, { gateway: gatewayWith({ kind: 'respond', output: recOutput() }) })).status).toBe('not_found');
    expect(await recsFor(genA)).toHaveLength(0);
  });
});
