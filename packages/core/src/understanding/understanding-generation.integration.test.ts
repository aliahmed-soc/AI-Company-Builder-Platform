// ACBP-P2-008 / CDR-029 — real-PostgreSQL proof of generateUnderstanding through the RESTRICTED role, driven by
// the P2-003 gateway with the deterministic FAKE provider + the understanding output validator. Proves: a complete
// generation persists one versioned document + classified items + the understanding.generated audit + a metered
// usage row; a model-flagged partial → status partial; weakest-section overall confidence; all six classes; a
// malformed output or gateway failure persists NOTHING; an audit failure rolls the whole document+items back;
// cross-account/company denial; version sequencing + prior-version immutability; audit metadata carries no content.
// Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope } from '@acbp/database';
import { toModelId } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createModelGateway, understandingOutputValidator, type ResolvedProvider } from '../index.js';
import { createMemoryItem } from '../memory/index.js';
import { generateUnderstanding } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens + outputTokens;

function resolved(behavior: FakeProviderBehavior): ResolvedProvider {
  return { name: 'fake', modelId: toModelId('fake-model'), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
}

describe.skipIf(!hasTestDatabase)('understanding generation (real PostgreSQL, restricted role) — ACBP-P2-008/CDR-029', () => {
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
    // Seed a couple of confirmed memory items for company A (the generation input).
    await createMemoryItem(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, type: 'user_fact', content: 'Sells specialty coffee.', sourceType: 'interview_answer', sourceRef: 'q:1' });
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const gatewayWith = (behavior: FakeProviderBehavior) => createModelGateway(product, { primary: resolved(behavior), estimateCost, validateOutput: understandingOutputValidator, config: { maxRetries: 0, maxReask: 0 } });
  const docsFor = async (companyId: string) => (await sql<{ id: string; version: number; status: string; overall_confidence: number }>`select id, version, status, overall_confidence from understanding_documents where company_id = ${companyId}::uuid order by version`.execute(owner.kysely)).rows;
  const itemsFor = async (documentId: string) => (await sql<{ item_class: string; content: string; confidence: number }>`select item_class, content, confidence from understanding_items where document_id = ${documentId}::uuid`.execute(owner.kysely)).rows;

  test('complete generation: persists one versioned document + classified items + audit + metered usage', async () => {
    const gw = gatewayWith({ kind: 'respond', output: '{"items":[{"class":"fact","content":"Sells specialty coffee.","confidence":0.9},{"class":"open_question","content":"Pricing model unclear.","confidence":0.2}]}' });
    const r = await generateUnderstanding(product, base(), { gateway: gw });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.document.version).toBe(1);
    expect(r.document.status).toBe('complete');
    // Weakest covered section: fact 0.9, open_question 0.2 → overall 0.2.
    expect(r.document.overallConfidence).toBeCloseTo(0.2);
    const rows = await docsFor(w.companyA1);
    expect(rows).toHaveLength(1);
    expect(await itemsFor(rows[0]!.id)).toHaveLength(2);
    // Audited (metadata bounded, NO content) + metered.
    const audit = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'understanding.generated').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.subject_id).toBe(rows[0]!.id);
    expect(JSON.stringify(audit[0]!.payload)).not.toContain('coffee'); // no content in audit metadata
    expect(audit[0]!.payload).toEqual({ version: 1, status: 'complete', item_count: 2 });
    expect((await sql<{ n: number }>`select count(*)::int as n from usage_events where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(1);
  });

  test('model-flagged partial → document status partial', async () => {
    const gw = gatewayWith({ kind: 'respond', output: '{"partial":true,"items":[{"class":"fact","content":"Sells coffee.","confidence":0.8}]}' });
    const r = await generateUnderstanding(product, base(), { gateway: gw });
    expect(r.status === 'ok' && r.document.status).toBe('partial');
  });

  test('all six classes are accepted and persisted', async () => {
    const items = ['fact', 'preference', 'constraint', 'assumption', 'research_finding', 'open_question'].map((c) => `{"class":"${c}","content":"c ${c}","confidence":0.6}`).join(',');
    const gw = gatewayWith({ kind: 'respond', output: `{"items":[${items}]}` });
    const r = await generateUnderstanding(product, base(), { gateway: gw });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const rows = await docsFor(w.companyA1);
    expect(await itemsFor(rows[0]!.id)).toHaveLength(6);
    expect(r.document.sections.filter((s) => s.status === 'present')).toHaveLength(6); // all >= 0.5
  });

  test('malformed output persists NOTHING (no document, no items, no audit)', async () => {
    const gw = gatewayWith({ kind: 'respond', output: 'not json at all' });
    const r = await generateUnderstanding(product, base(), { gateway: gw });
    expect(r.status).toBe('generation_failed');
    expect(await docsFor(w.companyA1)).toHaveLength(0);
    expect(await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'understanding.generated').execute()).toHaveLength(0);
  });

  test('gateway failure persists NOTHING (no partial-looking document)', async () => {
    const gw = gatewayWith({ kind: 'fail', error: 'provider_unavailable' });
    const r = await generateUnderstanding(product, base(), { gateway: gw });
    expect(r.status).toBe('generation_failed');
    expect(await docsFor(w.companyA1)).toHaveLength(0);
  });

  test('audit failure rolls the whole document+items back (audit-or-nothing)', async () => {
    const gw = gatewayWith({ kind: 'respond', output: '{"items":[{"class":"fact","content":"x","confidence":0.9}]}' });
    // An in-tx audit-write failure aborts the transaction; the normalized error propagates (like createMemoryItem).
    // The load-bearing guarantee is that NOTHING is persisted.
    await expect(generateUnderstanding(product, base(), { gateway: gw }, { auditWriter: (_s: AuditScope) => Promise.reject(new Error('audit down')) })).rejects.toThrow();
    expect(await docsFor(w.companyA1)).toHaveLength(0); // nothing persisted
    expect(await owner.kysely.selectFrom('understanding_items').selectAll().execute()).toHaveLength(0);
  });

  test('a non-member is forbidden from generating', async () => {
    const gw = gatewayWith({ kind: 'respond', output: '{"items":[]}' });
    const r = await generateUnderstanding(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 }, { gateway: gw });
    expect(r.status).toBe('forbidden');
    expect(await docsFor(w.companyA1)).toHaveLength(0);
  });

  test('version sequencing + prior-version immutability: two generations → v1 then v2, v1 unchanged', async () => {
    const gw1 = gatewayWith({ kind: 'respond', output: '{"items":[{"class":"fact","content":"First.","confidence":0.9}]}' });
    const r1 = await generateUnderstanding(product, base(), { gateway: gw1 });
    const gw2 = gatewayWith({ kind: 'respond', output: '{"items":[{"class":"fact","content":"Second.","confidence":0.5}]}' });
    const r2 = await generateUnderstanding(product, base(), { gateway: gw2 });
    expect(r1.status === 'ok' && r1.document.version).toBe(1);
    expect(r2.status === 'ok' && r2.document.version).toBe(2);
    const rows = await docsFor(w.companyA1);
    expect(rows.map((d) => d.version)).toEqual([1, 2]);
    // v1's item is unchanged (immutable — a re-generation is a new version, never an edit).
    if (r1.status === 'ok') expect((await itemsFor(r1.document.documentId)).map((i) => i.content)).toEqual(['First.']);
  });
});
