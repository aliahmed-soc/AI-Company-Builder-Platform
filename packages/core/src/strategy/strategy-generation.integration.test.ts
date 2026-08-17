// ACBP-P3-001 / CDR-034 — real-PostgreSQL proof of generateStrategyOptions through the RESTRICTED role, driven by the
// P2-003 gateway with the deterministic FAKE provider + the strategy output validator. Proves: strategy is GATED —
// blocked until the understanding is confirmed (not_confirmed / no_understanding); a complete generation persists ONE
// immutable generation + its 16-field options + the strategy.generated audit (bounded, no content) + a metered usage
// row; the honest fewer-than-three path; the ADR-019 16-field/no-fabrication validation (a missing field persists
// NOTHING; the "unknown" labeled sentinel is accepted); a gateway failure / malformed output persists NOTHING; an audit
// failure rolls the whole generation back; non-member denial; cross-company isolation. Skips when ACBP_TEST_DATABASE_URL
// is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope } from '@acbp/database';
import { toModelId, STRATEGY_OPTION_FIELDS } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, strategyOutputValidator, type ResolvedProvider } from '../index.js';
import { generateStrategyOptions, getLatestStrategyGeneration } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

function resolved(behavior: FakeProviderBehavior): ResolvedProvider {
  return { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
}
/** A full 16-field option object (all fields present); `over` overrides individual fields. */
function option(over: Record<string, string> = {}): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f} value`;
  return { ...o, ...over };
}
// n GENUINELY-DISTINCT options — each differs on the distinctness axes (customer/offer/business_model), so the
// P3-002 similarity check keeps all of them. (Bare option() calls are near-duplicates that collapse to one.)
function distinctOptions(n: number, over: (i: number) => Record<string, string> = () => ({})): Record<string, string>[] {
  return Array.from({ length: n }, (_, i) => option({ customer: `customer-${i}`, offer: `offer-${i}`, business_model: `model-${i}`, ...over(i) }));
}
const optionsOutput = (opts: Record<string, string>[], extra: Record<string, unknown> = {}) => JSON.stringify({ options: opts, ...extra });

describe.skipIf(!hasTestDatabase)('strategy option generation (real PostgreSQL, restricted role) — ACBP-P3-001/CDR-034', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  async function seedUnderstanding(accountId: string, companyId: string, actorId: string, confirmed: boolean): Promise<string> {
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, 1, 'complete', 0.6, ${actorId}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    await sql`insert into understanding_items (account_id, company_id, document_id, item_class, content, confidence, source_ref) values (${accountId}::uuid, ${companyId}::uuid, ${doc}::uuid, 'fact', 'Sells specialty coffee.', 0.9, null)`.execute(owner.kysely);
    if (confirmed) {
      await sql`insert into understanding_confirmation_events (account_id, company_id, document_id, version, kind, actor_user_id, correction_ref, dependents_flagged) values (${accountId}::uuid, ${companyId}::uuid, ${doc}::uuid, 1, 'confirmed', ${actorId}::uuid, null, null)`.execute(owner.kysely);
    }
    return doc;
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
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const gatewayWith = (behavior: FakeProviderBehavior) => createModelGateway(product, { primary: resolved(behavior), estimateCost, validateOutput: strategyOutputValidator, config: { maxRetries: 0, maxReask: 0 } });
  const gensFor = async (companyId: string) => (await sql<{ id: string; status: string; option_count: number; similarity_check_result: string; understanding_version: number }>`select id, status, option_count, similarity_check_result, understanding_version from strategy_generations where company_id = ${companyId}::uuid`.execute(owner.kysely)).rows;
  const optsFor = async (generationId: string) => (await sql<{ ordinal: number; fields: Record<string, string> }>`select ordinal, fields from strategy_options where generation_id = ${generationId}::uuid order by ordinal`.execute(owner.kysely)).rows;

  test('GATED: no understanding → no_understanding; understanding present but unconfirmed → not_confirmed; nothing persisted', async () => {
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput([option(), option(), option()]) });
    // No understanding document at all.
    expect((await generateStrategyOptions(product, base(), { gateway: gw })).status).toBe('no_understanding');
    // Understanding present but NOT confirmed → strategy is blocked.
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, false);
    expect((await generateStrategyOptions(product, base(), { gateway: gw })).status).toBe('not_confirmed');
    expect(await gensFor(w.companyA1)).toHaveLength(0);
  });

  test('complete generation from a CONFIRMED understanding: one immutable generation + 16-field options + audit + metered usage', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput(distinctOptions(3, (i) => ({ description: ['Sell wholesale', 'Sell retail', 'Subscription'][i]! }))) });
    const r = await generateStrategyOptions(product, base(), { gateway: gw });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.generation.status).toBe('complete');
    expect(r.generation.optionCount).toBe(3);
    expect(r.generation.similarityCheckResult).toBe('distinct'); // 3 genuinely-distinct options pass (P3-002)
    expect(r.generation.options).toHaveLength(3);
    // Every option carries all 16 fields.
    for (const opt of r.generation.options) expect(Object.keys(opt.fields).sort()).toEqual([...STRATEGY_OPTION_FIELDS].sort());
    const gens = await gensFor(w.companyA1);
    expect(gens).toHaveLength(1);
    expect(await optsFor(gens[0]!.id)).toHaveLength(3);
    // Audited (bounded metadata, NO option content) + metered.
    const audit = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'strategy.generated').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.subject_id).toBe(gens[0]!.id);
    expect(audit[0]!.payload).toEqual({ understanding_version: 1, option_count: 3, similarity_check_result: 'distinct' });
    expect(JSON.stringify(audit[0]!.payload)).not.toContain('wholesale'); // no option content in audit
    expect((await sql<{ n: number }>`select count(*)::int as n from usage_events where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(1);
  });

  test('honest fewer-than-three: two options → status fewer_than_three, with the model reason retained', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput(distinctOptions(2), { fewer_reason: 'Only two distinct customers are viable for this idea.' }) });
    const r = await generateStrategyOptions(product, base(), { gateway: gw });
    expect(r.status === 'ok' && r.generation.status).toBe('fewer_than_three');
    if (r.status === 'ok') {
      expect(r.generation.fewerReason).toBe('Only two distinct customers are viable for this idea.');
      expect(r.generation.similarityCheckResult).toBe('insufficient_distinct');
      expect(r.generation.optionCount).toBe(2);
    }
  });

  test('fewer-than-three with NO model reason and NO duplicates → a factual reason is still recorded (never unexplained)', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    // Two genuinely-distinct options, no fewer_reason from the model, nothing to dedupe.
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput(distinctOptions(2)) });
    const r = await generateStrategyOptions(product, base(), { gateway: gw });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.generation.status).toBe('fewer_than_three');
    expect(r.generation.fewerReason).toBe('The model produced only 2 genuinely distinct options for this understanding.');
  });

  test('ADR-019 no-fabrication: an option missing a field persists NOTHING; the labeled "unknown" sentinel is accepted', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    // Missing a field (drop cost_range) → the validator rejects the whole output → generation_failed, nothing persisted.
    const missing = option();
    delete missing['cost_range'];
    const gwBad = gatewayWith({ kind: 'respond', output: optionsOutput([missing, option(), option()]) });
    expect((await generateStrategyOptions(product, base(), { gateway: gwBad })).status).toBe('generation_failed');
    expect(await gensFor(w.companyA1)).toHaveLength(0);
    // A field labeled "unknown" (ADR-019) is a LEGAL value → accepted.
    const gwOk = gatewayWith({ kind: 'respond', output: optionsOutput(distinctOptions(3, (i) => (i === 0 ? { cost_range: 'unknown' } : {}))) });
    const r = await generateStrategyOptions(product, base(), { gateway: gwOk });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.generation.options[0]!.fields.cost_range).toBe('unknown');
  });

  test('a gateway failure and a malformed output each persist NOTHING (no generation, no audit)', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    expect((await generateStrategyOptions(product, base(), { gateway: gatewayWith({ kind: 'fail', error: 'provider_unavailable' }) })).status).toBe('generation_failed');
    expect((await generateStrategyOptions(product, base(), { gateway: gatewayWith({ kind: 'respond', output: 'not json' }) })).status).toBe('generation_failed');
    expect(await gensFor(w.companyA1)).toHaveLength(0);
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'strategy.generated').execute()).toHaveLength(0);
  });

  test('audit-or-nothing: an in-tx audit failure rolls the whole generation + options back', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput([option(), option(), option()]) });
    await expect(generateStrategyOptions(product, base(), { gateway: gw }, { auditWriter: (_s: AuditScope) => Promise.reject(new Error('audit down')) })).rejects.toThrow();
    expect(await gensFor(w.companyA1)).toHaveLength(0);
    expect(await owner.kysely.selectFrom('strategy_options').selectAll().execute()).toHaveLength(0);
  });

  test('confirm gate is RE-VERIFIED at persist: an understanding corrected during the model call → stale_understanding, nothing persisted', async () => {
    const doc = await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput([option(), option(), option()]) });
    // Simulate a concurrent owner correction of the understanding between the read and the persist transaction.
    const beforePersist = async (): Promise<void> => {
      await sql`insert into understanding_confirmation_events (account_id, company_id, document_id, version, kind, actor_user_id, correction_ref, dependents_flagged) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${doc}::uuid, 1, 'corrected', ${w.aOwner}::uuid, 'ref', 1)`.execute(owner.kysely);
    };
    const r = await generateStrategyOptions(product, base(), { gateway: gw }, { beforePersist });
    expect(r.status).toBe('stale_understanding');
    expect(await gensFor(w.companyA1)).toHaveLength(0);
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'strategy.generated').execute()).toHaveLength(0);
  });

  test('a non-member is forbidden from generating and reading', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput([option(), option(), option()]) });
    const nonMember = { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 };
    expect((await generateStrategyOptions(product, nonMember, { gateway: gw })).status).toBe('forbidden');
    expect((await getLatestStrategyGeneration(product, nonMember)).status).toBe('forbidden');
    expect(await gensFor(w.companyA1)).toHaveLength(0);
  });

  test('MONEY: a viewer and a non-member are refused BEFORE the provider is called, not merely refused', async () => {
    // ACBP-API-008. This test exists because a mutation survived hosted CI run 31982475683: the FIRST of this use
    // case's two authorization checks was weakened from `strategy:generate` (owner) to `strategy:read`
    // (owner|viewer) and the entire suite still passed. Nothing was wrong with the other assertions — a viewer
    // still received `forbidden`, because the SECOND check, inside the persist transaction, still refused them.
    // What changed invisibly is that the paid provider call at step 2 now happened first.
    //
    // "Nothing was persisted" and "nothing was spent" are different claims, and every existing assertion here
    // proves only the first. A caller who is refused must never have cost the account money, so the counter is
    // the assertion and the returned status is the supporting detail, rather than the other way round.
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    let paidCalls = 0;
    const counted = (): ReturnType<typeof gatewayWith> => {
      const inner = gatewayWith({ kind: 'respond', output: optionsOutput(distinctOptions(3)) });
      return (request, options) => {
        paidCalls += 1;
        return inner(request, options);
      };
    };

    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect((await generateStrategyOptions(product, viewer, { gateway: counted() })).status).toBe('forbidden');
    expect(paidCalls, 'a VIEWER reached the paid provider before being refused').toBe(0);

    const nonMember = { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 };
    expect((await generateStrategyOptions(product, nonMember, { gateway: counted() })).status).toBe('forbidden');
    expect(paidCalls, 'a NON-MEMBER reached the paid provider before being refused').toBe(0);
    expect(await gensFor(w.companyA1)).toHaveLength(0);
  });

  test('reads (owner+viewer): getLatestStrategyGeneration returns the latest generation + options; cross-company isolation', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput(distinctOptions(3)) });
    await generateStrategyOptions(product, base(), { gateway: gw });
    // Viewer MAY read.
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    const read = await getLatestStrategyGeneration(product, viewer);
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.generation?.optionCount).toBe(3);
      expect(read.generation?.options).toHaveLength(3);
    }
    // Company A2 (same account, different company) sees NO strategy — cross-company isolation.
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 };
    expect(await getLatestStrategyGeneration(product, a2)).toEqual({ status: 'ok', generation: null });
  });

  // ── ACBP-P3-002: distinctness check (STRAT-001 — near-duplicates rejected honestly) ──────────────────────
  test('P3-002 near-duplicates rejected: cosmetic variants (same axes, different titles) collapse to one → insufficient_distinct + fewer_than_three + honest reason', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    // Three options identical on customer/offer/business_model — only description differs ("same plan, different titles").
    const nearDupes = [option({ description: 'Plan A' }), option({ description: 'Plan B reworded' }), option({ description: 'Plan C reworded' })];
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput(nearDupes) });
    const r = await generateStrategyOptions(product, base(), { gateway: gw });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.generation.status).toBe('fewer_than_three');
    expect(r.generation.similarityCheckResult).toBe('insufficient_distinct');
    expect(r.generation.optionCount).toBe(1); // only the first distinct representative is persisted
    // Honest reason (STRAT-001 "rejected honestly"), synthesized from the check — factual, not fabricated.
    expect(r.generation.fewerReason).toContain('near-duplicate');
    // Only the distinct set is stored; the near-duplicates were rejected, not persisted.
    const gens = await gensFor(w.companyA1);
    expect(await optsFor(gens[0]!.id)).toHaveLength(1);
    // The audit carries the real verdict (never 'pending').
    const audit = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'strategy.generated').execute();
    expect((audit[0]!.payload as { similarity_check_result: string }).similarity_check_result).toBe('insufficient_distinct');
    expect((audit[0]!.payload as { option_count: number }).option_count).toBe(1);
  });

  test('P3-002 mixed set: near-duplicates rejected, distinct representatives kept → distinct + complete', async () => {
    await seedUnderstanding(w.accountA, w.companyA1, w.aOwner, true);
    // 4 options: #0 and #1 are near-duplicates (same axes); #2, #3 are genuinely distinct → 3 distinct total.
    const mixed = [
      option({ customer: 'SMBs', offer: 'tool', business_model: 'subscription', description: 'keep-1' }),
      option({ customer: 'SMBs', offer: 'tool', business_model: 'subscription', description: 'dup-of-1' }),
      option({ customer: 'Enterprises', offer: 'service', business_model: 'contract', description: 'keep-2' }),
      option({ customer: 'Consumers', offer: 'app', business_model: 'freemium', description: 'keep-3' }),
    ];
    const gw = gatewayWith({ kind: 'respond', output: optionsOutput(mixed) });
    const r = await generateStrategyOptions(product, base(), { gateway: gw });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.generation.status).toBe('complete');
    expect(r.generation.similarityCheckResult).toBe('distinct');
    expect(r.generation.optionCount).toBe(3);
    expect(r.generation.options.map((o) => o.fields.description)).toEqual(['keep-1', 'keep-2', 'keep-3']); // dup rejected
  });
});
