// ACBP-P2-005 / CDR-028 — real-PostgreSQL proof of the adaptive-orchestration use cases through the RESTRICTED
// role, driven by the P2-003 gateway with the deterministic FAKE provider + the interview output validator.
// Proves: an adaptive batch persists <=3 questions with rationale + source='adaptive' and meters usage; a
// generation failure falls back to the static bank flagged 'static_fallback'; >3 is never persisted (the <=3 rule);
// a clear answer becomes a user_fact memory item; vague/contradictory surface (no memory write); an "I don't know"
// yields an ai_assumption memory item. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, interviewOutputValidator, type ResolvedProvider } from '../index.js';
import { addInterviewQuestion, generateAdaptiveBatch, evaluateAnswer, suggestAssumptionForSkip, getSessionQa } from './index.js';
import { listMemoryItems } from '../memory/index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

function resolved(behavior: FakeProviderBehavior): ResolvedProvider {
  return { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
}

describe.skipIf(!hasTestDatabase)('adaptive orchestration (real PostgreSQL, restricted role) — ACBP-P2-005/CDR-028', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let sessionA = '';

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
    sessionA = (await sql<{ id: string }>`insert into interview_sessions (account_id, company_id, state, started_at) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'in_progress', now()) returning id`.execute(owner.kysely)).rows[0]!.id;
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, sessionId: sessionA });
  const gatewayWith = (behavior: FakeProviderBehavior) => createModelGateway(product, { primary: resolved(behavior), estimateCost, validateOutput: interviewOutputValidator, config: { maxRetries: 0, maxReask: 0 } });
  const usageCount = async () => (await sql<{ n: number }>`select count(*)::int as n from usage_events where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n;

  test('adaptive batch: persists the generated questions with rationale + source=adaptive, and meters usage', async () => {
    const gw = gatewayWith({ kind: 'respond', output: '{"questions":["Who is your customer?","What problem do you solve?"]}' });
    const r = await generateAdaptiveBatch(product, { ...base(), focusArea: 'target market' }, { gateway: gw });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.source).toBe('adaptive');
    expect(r.questions.map((q) => q.prompt)).toEqual(['Who is your customer?', 'What problem do you solve?']);
    for (const q of r.questions) {
      expect(q.source).toBe('adaptive');
      expect(q.rationale).toContain('target market');
    }
    expect(await usageCount()).toBe(1); // one metered model call
  });

  test('generation failure: falls back to the static bank flagged static_fallback (<=3), still metered', async () => {
    const gw = gatewayWith({ kind: 'fail', error: 'provider_unavailable' });
    const r = await generateAdaptiveBatch(product, { ...base(), focusArea: 'pricing' }, { gateway: gw });
    expect(r.status === 'ok' && r.source).toBe('static_fallback');
    if (r.status !== 'ok') return;
    expect(r.questions.length).toBeGreaterThan(0);
    expect(r.questions.length).toBeLessThanOrEqual(3);
    for (const q of r.questions) expect(q.source).toBe('static_fallback');
    expect(await usageCount()).toBe(1); // errors are metered too
  });

  test('the <=3 rule: a batch of four is rejected (invalid_output) and never persisted — falls back', async () => {
    const gw = gatewayWith({ kind: 'respond', output: '{"questions":["a","b","c","d"]}' });
    const r = await generateAdaptiveBatch(product, { ...base(), focusArea: 'ops' }, { gateway: gw });
    // parseFollowUps rejects >3 → invalid_output → (no re-ask budget) → error → static fallback.
    expect(r.status === 'ok' && r.source).toBe('static_fallback');
    const qa = await getSessionQa(product, base());
    expect(qa.status === 'ok' && qa.qa.items.every((i) => i.question.source === 'static_fallback')).toBe(true);
  });

  test('clear answer → a user_fact typed memory item (interview_answer source path)', async () => {
    const added = await addInterviewQuestion(product, { ...base(), prompt: 'Who is your target customer?' });
    expect(added.status).toBe('ok');
    if (added.status !== 'ok') return;
    const gw = gatewayWith({ kind: 'respond', output: '{"verdict":"clear"}' });
    const r = await evaluateAnswer(product, { ...base(), questionId: added.question.questionId, answerText: 'Small coffee shops in Cairo.' }, { gateway: gw });
    expect(r.status === 'ok' && r.verdict).toBe('clear');
    const mem = await listMemoryItems(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(mem.status).toBe('ok');
    if (mem.status !== 'ok') return;
    expect(mem.items).toHaveLength(1);
    expect(mem.items[0]!.type).toBe('user_fact');
    expect(mem.items[0]!.sourceType).toBe('interview_answer');
    expect(mem.items[0]!.content).toContain('coffee shops');
  });

  test('vague answer → clarification returned, NO memory written', async () => {
    const added = await addInterviewQuestion(product, { ...base(), prompt: 'What is your market?' });
    if (added.status !== 'ok') return;
    const gw = gatewayWith({ kind: 'respond', output: '{"verdict":"vague","detail":"Which region or segment specifically?"}' });
    const r = await evaluateAnswer(product, { ...base(), questionId: added.question.questionId, answerText: 'Everyone.' }, { gateway: gw });
    expect(r.status === 'ok' && r.verdict).toBe('vague');
    expect(r.status === 'ok' && r.verdict === 'vague' && r.clarification).toContain('region');
    const mem = await listMemoryItems(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(mem.status === 'ok' && mem.items).toHaveLength(0);
  });

  test('contradictory answer → conflict surfaced (never silent override), NO memory written', async () => {
    const added = await addInterviewQuestion(product, { ...base(), prompt: 'How many employees?' });
    if (added.status !== 'ok') return;
    const gw = gatewayWith({ kind: 'respond', output: '{"verdict":"contradictory","detail":"You earlier said solo founder."}' });
    const r = await evaluateAnswer(product, { ...base(), questionId: added.question.questionId, answerText: 'Fifty.' }, { gateway: gw });
    expect(r.status === 'ok' && r.verdict).toBe('contradictory');
    expect(r.status === 'ok' && r.verdict === 'contradictory' && r.conflict).toContain('solo founder');
    const mem = await listMemoryItems(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(mem.status === 'ok' && mem.items).toHaveLength(0);
  });

  test('"I don\'t know" → a labeled ai_assumption memory item (model_generation source)', async () => {
    const added = await addInterviewQuestion(product, { ...base(), prompt: 'What is your target market?' });
    if (added.status !== 'ok') return;
    const gw = gatewayWith({ kind: 'respond', output: '{"assumption":"Assuming the target market is small businesses in Egypt."}' });
    const r = await suggestAssumptionForSkip(product, { ...base(), questionId: added.question.questionId }, { gateway: gw });
    expect(r.status === 'ok' && r.assumption).toContain('small businesses');
    const mem = await listMemoryItems(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(mem.status).toBe('ok');
    if (mem.status !== 'ok') return;
    expect(mem.items).toHaveLength(1);
    expect(mem.items[0]!.type).toBe('ai_assumption');
    expect(mem.items[0]!.sourceType).toBe('model_generation');
  });

  test('a non-member is forbidden from generating a batch (authorization)', async () => {
    const gw = gatewayWith({ kind: 'respond', output: '{"questions":["x"]}' });
    const r = await generateAdaptiveBatch(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, sessionId: sessionA, focusArea: 'x' }, { gateway: gw });
    expect(r.status).toBe('forbidden');
  });
});
