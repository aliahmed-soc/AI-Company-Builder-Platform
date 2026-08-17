// ACBP-P4-001 / CDR-039 — real-PostgreSQL proof of generateRoadmap through the RESTRICTED role, driven by the P2-003
// gateway with the deterministic FAKE provider. Proves: the PLANNING GATE (no decision → blocked; a REJECT decision →
// blocked, the load-bearing CDR-039 §7-G1 case; a later rejection RE-BLOCKS planning); a valid plan persists ONE
// version + its goals + milestones + ONE roadmap.generated in the SAME transaction and is surfaced on the read;
// partial honesty (a gateway failure and a malformed output each persist NOTHING; only a model-flagged output is
// `partial`); audit-or-nothing rollback; stale_decision when the decision changes during the model call; versioning
// (a second generation is version 2 superseding version 1); NO tasks are created (P4-003 owns that); owner+viewer may
// generate, a non-member is forbidden; cross-company isolation. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope, AuditWriteContext } from '@acbp/database';
import { toModelId, type AuditEvent } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, roadmapOutputValidator, type ResolvedProvider } from '../index.js';
import { generateRoadmap, getLatestRoadmap } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

function resolved(behavior: FakeProviderBehavior): ResolvedProvider {
  return { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
}
const planOutput = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    goals: [{ title: 'Reach first paying customer', description: 'Validate willingness to pay.' }],
    milestones: [
      { title: 'Ship the landing page', description: null, goal_ordinal: 0 },
      { title: 'Run ten discovery calls', description: null },
    ],
    ...over,
  });

describe.skipIf(!hasTestDatabase)('roadmap generation (real PostgreSQL, restricted role) — ACBP-P4-001/CDR-039', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let generationA = '';
  let selectionA = '';

  /** Seed the strategy chain a decision hangs off (owner/superuser bypasses RLS). */
  async function seedStrategyChain(accountId: string, companyId: string, actorId: string): Promise<{ generation: string; selection: string }> {
    const k = owner.kysely;
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, 1, 'complete', 0.6, ${actorId}::uuid) returning id`.execute(k)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, similarity_check_result, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${doc}::uuid, 1, 'complete', 3, 'distinct', ${actorId}::uuid) returning id`.execute(k)).rows[0]!.id;
    const opt = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountId}::uuid, ${companyId}::uuid, ${gen}::uuid, 0, ${JSON.stringify({ customer: 'small clinics', offer: 'scheduling', business_model: 'subscription' })}::jsonb) returning id`.execute(k)).rows[0]!.id;
    const sel = (await sql<{ id: string }>`insert into strategy_selections (account_id, company_id, generation_id, mode, selected_option_id, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${gen}::uuid, 'select', ${opt}::uuid, ${actorId}::uuid) returning id`.execute(k)).rows[0]!.id;
    return { generation: gen, selection: sel };
  }
  /** Record a decision of the given mode directly (the P3-005 use case is exercised by its own suite). */
  async function seedDecision(mode: string, accountId = w.accountA, companyId = w.companyA1, generation = generationA, selection = selectionA): Promise<string> {
    return (
      await sql<{ id: string }>`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${generation}::uuid, ${selection}::uuid, ${mode}, 1, ${w.aOwner}::uuid) returning id`.execute(owner.kysely)
    ).rows[0]!.id;
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
    const chain = await seedStrategyChain(w.accountA, w.companyA1, w.aOwner);
    generationA = chain.generation;
    selectionA = chain.selection;
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const gatewayWith = (behavior: FakeProviderBehavior) => createModelGateway(product, { primary: resolved(behavior), estimateCost, validateOutput: roadmapOutputValidator, config: { maxRetries: 0, maxReask: 0 } });
  const okGateway = (over: Record<string, unknown> = {}) => gatewayWith({ kind: 'respond', output: planOutput(over) });
  const roadmapsFor = async () => (await sql<{ id: string; version: number; status: string; origin: string; supersedes_roadmap_id: string | null }>`select id, version, status, origin, supersedes_roadmap_id from roadmaps where company_id = ${w.companyA1}::uuid order by version`.execute(owner.kysely)).rows;
  const auditCount = async () => (await sql<{ n: number }>`select count(*)::int as n from audit_events where name = 'roadmap.generated'`.execute(owner.kysely)).rows[0]!.n;

  test('THE GATE: with no decision recorded, planning is blocked and nothing is persisted (J-08)', async () => {
    const r = await generateRoadmap(product, base(), { gateway: okGateway() });
    expect(r.status).toBe('no_decision');
    expect(await roadmapsFor()).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('THE GATE (CDR-039 §7-G1): a REJECT decision does NOT unlock planning — a decision merely EXISTING is not enough', async () => {
    await seedDecision('reject');
    const r = await generateRoadmap(product, base(), { gateway: okGateway() });
    expect(r.status).toBe('decision_rejected');
    expect(await roadmapsFor()).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('a positive decision unlocks planning: ONE version + goals + milestones + ONE audit event, surfaced on the read', async () => {
    await seedDecision('select');
    const r = await generateRoadmap(product, base(), { gateway: okGateway() });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.roadmap.version).toBe(1);
    expect(r.roadmap.origin).toBe('generated');
    expect(r.roadmap.status).toBe('complete');
    expect(r.roadmap.supersedesRoadmapId).toBeNull();
    expect(r.roadmap.goals).toHaveLength(1);
    expect(r.roadmap.milestones).toHaveLength(2);
    // Ordinals are platform-assigned and sequential (ROAD-001 "target sequencing" — order, never dates).
    expect(r.roadmap.milestones.map((m) => m.ordinal)).toEqual([0, 1]);
    // The linked milestone resolves to a real goal of THIS version; the unlinked one stays null (CDR-039 §7-G5).
    expect(r.roadmap.milestones[0]?.goalId).toBe(r.roadmap.goals[0]?.goalId);
    expect(r.roadmap.milestones[1]?.goalId).toBeNull();
    expect(await auditCount()).toBe(1);
    // Metered by the gateway (the use case writes no usage code).
    expect((await sql<{ n: number }>`select count(*)::int as n from usage_events where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(1);
    const read = await getLatestRoadmap(product, base());
    expect(read.status === 'ok' && read.roadmap?.roadmapId).toBe(r.roadmap.roadmapId);
  });

  test('a later REJECTION re-blocks planning (latest-wins, the confirmed && !corrected precedent)', async () => {
    await seedDecision('select');
    expect((await generateRoadmap(product, base(), { gateway: okGateway() })).status).toBe('ok');
    await seedDecision('reject');
    expect((await generateRoadmap(product, base(), { gateway: okGateway() })).status).toBe('decision_rejected');
    // The already-generated version is retained — a rejection blocks NEW planning, it does not erase history.
    expect(await roadmapsFor()).toHaveLength(1);
  });

  test('PARTIAL HONESTY: a gateway failure and a malformed output each persist NOTHING (never a "partial" roadmap)', async () => {
    await seedDecision('select');
    expect((await generateRoadmap(product, base(), { gateway: gatewayWith({ kind: 'fail', error: 'provider_unavailable' }) })).status).toBe('generation_failed');
    expect((await generateRoadmap(product, base(), { gateway: gatewayWith({ kind: 'respond', output: 'not json' }) })).status).toBe('generation_failed');
    // An empty plan is not an honest partial either.
    expect((await generateRoadmap(product, base(), { gateway: gatewayWith({ kind: 'respond', output: JSON.stringify({ goals: [], milestones: [] }) }) })).status).toBe('generation_failed');
    expect(await roadmapsFor()).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('PARTIAL HONESTY: a model-flagged partial IS persisted, labeled partial', async () => {
    await seedDecision('select');
    const r = await generateRoadmap(product, base(), { gateway: okGateway({ partial: true }) });
    expect(r.status === 'ok' && r.roadmap.status).toBe('partial');
    expect(r.status === 'ok' && r.roadmap.modelFlaggedPartial).toBe(true);
    expect((await roadmapsFor())[0]!.status).toBe('partial');
  });

  test('audit-or-nothing: a forced audit failure rolls the whole version (and its goals/milestones) back', async () => {
    await seedDecision('select');
    const failingAudit = (_s: AuditScope, _e: AuditEvent, _c?: AuditWriteContext): Promise<string> => Promise.reject(new Error('audit boom'));
    await expect(generateRoadmap(product, base(), { gateway: okGateway() }, { auditWriter: failingAudit })).rejects.toThrow();
    expect(await roadmapsFor()).toHaveLength(0);
    expect((await sql<{ n: number }>`select count(*)::int as n from goals`.execute(owner.kysely)).rows[0]!.n).toBe(0);
    expect((await sql<{ n: number }>`select count(*)::int as n from milestones`.execute(owner.kysely)).rows[0]!.n).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  test('stale_decision: a decision recorded DURING the model call is never planned over', async () => {
    await seedDecision('select');
    const r = await generateRoadmap(product, base(), { gateway: okGateway() }, { beforePersist: async () => void (await seedDecision('reject')) });
    expect(r.status).toBe('stale_decision');
    expect(await roadmapsFor()).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('versioning: a second generation is version 2 and supersedes version 1; the read surfaces the latest', async () => {
    await seedDecision('select');
    expect((await generateRoadmap(product, base(), { gateway: okGateway() })).status).toBe('ok');
    const second = await generateRoadmap(product, base(), { gateway: okGateway({ goals: [{ title: 'Revised goal', description: null }], milestones: [{ title: 'Revised milestone', description: null }] }) });
    expect(second.status === 'ok' && second.roadmap.version).toBe(2);
    const rows = await roadmapsFor();
    expect(rows.map((x) => x.version)).toEqual([1, 2]);
    expect(rows[1]!.supersedes_roadmap_id).toBe(rows[0]!.id);
    const read = await getLatestRoadmap(product, base());
    expect(read.status === 'ok' && read.roadmap?.version).toBe(2);
    expect(read.status === 'ok' && read.roadmap?.goals[0]?.title).toBe('Revised goal');
  });

  test('FAILS CLOSED when the decided content cannot be resolved — the model is never asked to plan from nothing', async () => {
    // A decision whose option carries no fields leaves nothing to plan from. Planning from a bare mode + version line
    // would produce a fabricated roadmap that persists as a normal one (ADR-019) — so the gate reports no usable
    // decision instead. This is what the empty-`{}` fixture in a sibling suite tripped over: the behaviour is correct.
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA2}::uuid, 1, 'complete', 0.6, ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA2}::uuid, ${doc}::uuid, 1, 'complete', 3, ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    const opt = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${w.accountA}::uuid, ${w.companyA2}::uuid, ${gen}::uuid, 0, '{}'::jsonb) returning id`.execute(owner.kysely)).rows[0]!.id;
    const sel = (await sql<{ id: string }>`insert into strategy_selections (account_id, company_id, generation_id, mode, selected_option_id, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA2}::uuid, ${gen}::uuid, 'select', ${opt}::uuid, ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    await seedDecision('select', w.accountA, w.companyA2, gen, sel);
    const r = await generateRoadmap(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 }, { gateway: okGateway() });
    // NOT `no_decision`: a decision IS recorded, only its content is unresolvable — telling the owner to record a
    // decision they already recorded would be dishonest. It is a generation that cannot happen.
    expect(r.status).toBe('generation_failed');
    expect((await sql<{ n: number }>`select count(*)::int as n from roadmaps where company_id = ${w.companyA2}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(0);
  });

  test('P4-001 plans NO tasks (task generation is P4-003)', async () => {
    await seedDecision('select');
    await generateRoadmap(product, base(), { gateway: okGateway() });
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(0);
  });

  test('authz: a viewer may READ but is REFUSED generation (PM ruling 2026-08-14); a non-member is forbidden on both', async () => {
    // NARROWED by ACBP-API-004: `roadmap:generate` is owner-only, `roadmap:read` is NOT. That split is the whole
    // point of the ruling — narrowing who may COMMISSION a plan does not narrow who may SEE it — so this test now
    // pins both halves in one place, which is where a future widening would have to argue with itself.
    //
    // THE `forbidden` ON ITS OWN IS NOT ENOUGH (ACBP-API-008). Two authorization checks guard this path — one
    // before the model call, one inside the persist transaction — so weakening only the first still returns
    // `forbidden` from the second, with a paid provider call already made in between. The counter is what
    // distinguishes "refused" from "refused after we paid for it".
    await seedDecision('select');
    let paidCalls = 0;
    const counted = (): ReturnType<typeof okGateway> => {
      const inner = okGateway();
      return (request, options) => {
        paidCalls += 1;
        return inner(request, options);
      };
    };

    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect((await generateRoadmap(product, viewer, { gateway: counted() })).status).toBe('forbidden');
    expect(paidCalls, 'a VIEWER reached the paid provider before being refused').toBe(0);
    expect((await getLatestRoadmap(product, viewer)).status, 'reading the plan is still a member action').toBe('ok');

    const nonMember = { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 };
    expect((await generateRoadmap(product, nonMember, { gateway: counted() })).status).toBe('forbidden');
    expect(paidCalls, 'a NON-MEMBER reached the paid provider before being refused').toBe(0);
    expect((await getLatestRoadmap(product, nonMember)).status).toBe('forbidden');
  });

  test('cross-company isolation: company A2 has its own (absent) decision — planning there is blocked, and A1 is unaffected', async () => {
    await seedDecision('select');
    await generateRoadmap(product, base(), { gateway: okGateway() });
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 };
    expect((await generateRoadmap(product, a2, { gateway: okGateway() })).status).toBe('no_decision');
    expect((await getLatestRoadmap(product, a2)).status === 'ok' && (await getLatestRoadmap(product, a2)).status).toBe('ok');
    const read = await getLatestRoadmap(product, a2);
    expect(read.status === 'ok' && read.roadmap).toBeNull();
    expect(await roadmapsFor()).toHaveLength(1);
  });
});
