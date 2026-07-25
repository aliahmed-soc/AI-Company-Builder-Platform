// ACBP-P4-001 / CDR-039 — real-PostgreSQL proof of editRoadmap (ROAD-002) through the RESTRICTED role. No model call:
// the OWNER authors the revision. Proves: an edit creates a NEW version with author + reason and never mutates the
// previous one ("Versions retained"); affected OPEN tasks are flagged for review while closed tasks and tasks tied to
// other versions are NOT; the version guard refuses an edit against a stale version; a missing/blank/over-long reason
// and a malformed plan are `invalid`; OWNER-ONLY (a viewer and a non-member are forbidden); "version write failure
// blocks the edit rather than losing history" (a forced audit failure leaves the previous version intact and no flags);
// cross-company isolation. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope, AuditWriteContext } from '@acbp/database';
import { toModelId, EDIT_REASON_MAX, type AuditEvent } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, roadmapOutputValidator, type ResolvedProvider } from '../index.js';
import { generateRoadmap, editRoadmap, getLatestRoadmap } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

function resolved(behavior: FakeProviderBehavior): ResolvedProvider {
  return { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
}
const PLAN = JSON.stringify({
  goals: [{ title: 'Reach first paying customer', description: null }],
  milestones: [{ title: 'Ship the landing page', description: null, goal_ordinal: 0 }],
});
const REVISED = JSON.stringify({
  goals: [{ title: 'Reach ten paying customers', description: 'after the pricing change' }],
  milestones: [{ title: 'Launch paid tier', description: null, goal_ordinal: 0 }],
});

describe.skipIf(!hasTestDatabase)('roadmap edit / ROAD-002 (real PostgreSQL, restricted role) — ACBP-P4-001/CDR-039', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let v1 = '';

  async function seedDecisionChain(accountId: string, companyId: string, actorId: string): Promise<void> {
    const k = owner.kysely;
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, 1, 'complete', 0.6, ${actorId}::uuid) returning id`.execute(k)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${doc}::uuid, 1, 'complete', 3, ${actorId}::uuid) returning id`.execute(k)).rows[0]!.id;
    // Real decided content: generation FAILS CLOSED when the decided option has no fields (CDR-039 §7 / LOW-6 — the
    // model must never be asked to plan from nothing), so an empty `{}` fixture would not be a usable decision.
    const opt = (await sql<{ id: string }>`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountId}::uuid, ${companyId}::uuid, ${gen}::uuid, 0, ${JSON.stringify({ customer: 'small clinics', offer: 'scheduling', business_model: 'subscription' })}::jsonb) returning id`.execute(k)).rows[0]!.id;
    const sel = (await sql<{ id: string }>`insert into strategy_selections (account_id, company_id, generation_id, mode, selected_option_id, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${gen}::uuid, 'select', ${opt}::uuid, ${actorId}::uuid) returning id`.execute(k)).rows[0]!.id;
    await sql`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${gen}::uuid, ${sel}::uuid, 'select', 1, ${actorId}::uuid)`.execute(k);
  }

  /** Create a task in `state` against the given milestone (owner client; tasks.milestone_id is now FK-checked). */
  async function seedTask(milestoneId: string | null, state: string): Promise<string> {
    return (
      await sql<{ id: string }>`insert into tasks (account_id, company_id, milestone_id, title, state, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${milestoneId}, ${'t-' + state}, ${state}, ${w.aOwner}::uuid) returning id`.execute(owner.kysely)
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
    await seedDecisionChain(w.accountA, w.companyA1, w.aOwner);
    const gw = createModelGateway(product, { primary: resolved({ kind: 'respond', output: PLAN }), estimateCost, validateOutput: roadmapOutputValidator, config: { maxRetries: 0, maxReask: 0 } });
    const gen = await generateRoadmap(product, base(), { gateway: gw });
    if (gen.status !== 'ok') throw new Error(`setup generation failed: ${gen.status}`);
    v1 = gen.roadmap.roadmapId;
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const roadmapsFor = async () => (await sql<{ id: string; version: number; origin: string; edit_reason: string | null; supersedes_roadmap_id: string | null; created_by_user_id: string }>`select id, version, origin, edit_reason, supersedes_roadmap_id, created_by_user_id from roadmaps where company_id = ${w.companyA1}::uuid order by version`.execute(owner.kysely)).rows;
  const flagsFor = async () => (await sql<{ task_id: string; roadmap_id: string }>`select task_id, roadmap_id from task_review_flags`.execute(owner.kysely)).rows;
  const editAuditCount = async () => (await sql<{ n: number }>`select count(*)::int as n from audit_events where name = 'roadmap.edited'`.execute(owner.kysely)).rows[0]!.n;
  const milestoneOf = async (roadmapId: string) => (await sql<{ id: string }>`select id from milestones where roadmap_id = ${roadmapId}::uuid order by ordinal limit 1`.execute(owner.kysely)).rows[0]!.id;

  test('an edit creates a NEW version with author + reason; the previous version is untouched (Versions retained)', async () => {
    const r = await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: REVISED, reason: '  pricing changed after ten calls  ' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.roadmap.version).toBe(2);
    expect(r.roadmap.origin).toBe('edited');
    expect(r.roadmap.editReason).toBe('pricing changed after ten calls'); // trimmed
    expect(r.roadmap.supersedesRoadmapId).toBe(v1);
    expect(r.roadmap.goals[0]?.title).toBe('Reach ten paying customers');
    const rows = await roadmapsFor();
    expect(rows.map((x) => x.version)).toEqual([1, 2]);
    // Version 1 is intact and still carries its own (generated, reason-less) identity.
    expect(rows[0]!.origin).toBe('generated');
    expect(rows[0]!.edit_reason).toBeNull();
    expect(rows[1]!.created_by_user_id).toBe(w.aOwner); // ROAD-002 "with author"
    expect(await editAuditCount()).toBe(1);
    const read = await getLatestRoadmap(product, base());
    expect(read.status === 'ok' && read.roadmap?.version).toBe(2);
  });

  test('ROAD-002: affected OPEN tasks are flagged; CLOSED tasks and tasks on other versions are NOT', async () => {
    const m1 = await milestoneOf(v1);
    const openTask = await seedTask(m1, 'planned');
    const closedTask = await seedTask(m1, 'completed');
    const unlinkedTask = await seedTask(null, 'planned');
    const r = await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: REVISED, reason: 'scope cut' });
    expect(r.status === 'ok' && r.flaggedTaskCount).toBe(1);
    const flags = await flagsFor();
    expect(flags).toHaveLength(1);
    expect(flags[0]!.task_id).toBe(openTask);
    // The flag names the NEW version (the one whose creation caused the review).
    expect(r.status === 'ok' && flags[0]!.roadmap_id).toBe(r.status === 'ok' ? r.roadmap.roadmapId : '');
    expect(flags.map((f) => f.task_id)).not.toContain(closedTask);
    expect(flags.map((f) => f.task_id)).not.toContain(unlinkedTask);
  });

  test('version guard: editing a SUPERSEDED version is refused; nothing is written', async () => {
    const first = await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: REVISED, reason: 'first revision' });
    expect(first.status).toBe('ok');
    // v1 is no longer current — a second edit against it is a stale view (API-CONTRACTS "version-guarded").
    const stale = await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: REVISED, reason: 'second revision' });
    expect(stale.status).toBe('stale_version');
    expect(await roadmapsFor()).toHaveLength(2);
    expect(await editAuditCount()).toBe(1);
  });

  test('ROAD-002 "record rationale": a missing/blank/over-long reason is invalid; so is a malformed plan', async () => {
    for (const reason of [undefined, null, '   ', 'x'.repeat(EDIT_REASON_MAX + 1), 42]) {
      expect((await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: REVISED, reason })).status).toBe('invalid');
    }
    // An owner edit passes the SAME deny-by-default parser a model output must pass.
    expect((await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: 'not json', reason: 'r' })).status).toBe('invalid');
    expect((await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: JSON.stringify({ goals: [], milestones: [] }), reason: 'r' })).status).toBe('invalid');
    expect(await roadmapsFor()).toHaveLength(1);
    expect(await editAuditCount()).toBe(0);
  });

  test('OWNER-ONLY: a viewer is forbidden (even though a viewer may generate); a non-member is forbidden', async () => {
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, expectedRoadmapId: v1, plan: REVISED, reason: 'r' };
    expect((await editRoadmap(product, viewer)).status).toBe('forbidden');
    const nonMember = { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, expectedRoadmapId: v1, plan: REVISED, reason: 'r' };
    expect((await editRoadmap(product, nonMember)).status).toBe('forbidden');
    // AUTHZ BEFORE VALIDATION: an unauthorized caller with a bad reason still learns only `forbidden`.
    expect((await editRoadmap(product, { ...viewer, reason: '   ' })).status).toBe('forbidden');
    expect(await roadmapsFor()).toHaveLength(1);
  });

  test('"version write failure blocks the edit rather than losing history": a forced audit failure rolls everything back', async () => {
    const m1 = await milestoneOf(v1);
    await seedTask(m1, 'planned');
    const failingAudit = (_s: AuditScope, _e: AuditEvent, _c?: AuditWriteContext): Promise<string> => Promise.reject(new Error('audit boom'));
    await expect(editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: REVISED, reason: 'r' }, {}, { auditWriter: failingAudit })).rejects.toThrow();
    // No new version, no flags — and version 1 survives untouched.
    const rows = await roadmapsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(v1);
    expect(await flagsFor()).toHaveLength(0);
    expect(await editAuditCount()).toBe(0);
  });

  test('THE GATE applies to EDITS too: after a REJECT decision, an edit is blocked (a rejection cannot be side-stepped by revising)', async () => {
    // An edit AUTHORS the new CURRENT plan — that is planning, so CDR-039 §7-G1 gates it exactly like generation.
    await sql`insert into decisions (account_id, company_id, generation_id, selection_id, mode, understanding_version, created_by_user_id) select account_id, company_id, generation_id, selection_id, 'reject', understanding_version, created_by_user_id from decisions where company_id = ${w.companyA1}::uuid order by created_at desc limit 1`.execute(owner.kysely);
    const r = await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: REVISED, reason: 'sneaking a revision past the rejection' });
    expect(r.status).toBe('decision_rejected');
    // The already-generated version is retained; no new version, no flags, no audit.
    expect(await roadmapsFor()).toHaveLength(1);
    expect(await flagsFor()).toHaveLength(0);
    expect(await editAuditCount()).toBe(0);
  });

  test('ROAD-002 re-flagging: a SECOND revision still flags the stale task (tasks are never re-pointed at new versions)', async () => {
    const m1 = await milestoneOf(v1);
    const task = await seedTask(m1, 'planned');
    const first = await editRoadmap(product, { ...base(), expectedRoadmapId: v1, plan: REVISED, reason: 'first revision' });
    expect(first.status === 'ok' && first.flaggedTaskCount).toBe(1);
    if (first.status !== 'ok') return;
    // The task still points at v1's milestone — nothing re-points it. A second revision must flag it AGAIN against the
    // newest version, otherwise "affected open tasks are flagged for review" silently stops after one edit.
    const second = await editRoadmap(product, { ...base(), expectedRoadmapId: first.roadmap.roadmapId, plan: REVISED, reason: 'second revision' });
    expect(second.status === 'ok' && second.flaggedTaskCount).toBe(1);
    const flags = await flagsFor();
    expect(flags).toHaveLength(2); // one per version, both naming the same still-stale task
    expect(new Set(flags.map((f) => f.task_id))).toEqual(new Set([task]));
    expect(new Set(flags.map((f) => f.roadmap_id)).size).toBe(2);
  });

  test('cross-company isolation: company A2 has no roadmap, so an edit there is not_found and A1 is unaffected', async () => {
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2, expectedRoadmapId: v1, plan: REVISED, reason: 'r' };
    expect((await editRoadmap(product, a2)).status).toBe('not_found');
    expect(await roadmapsFor()).toHaveLength(1);
  });
});
