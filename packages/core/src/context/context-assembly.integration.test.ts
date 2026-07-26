// ACBP-P2-007 / CDR-032 — real-PostgreSQL proof of assembleContext through the RESTRICTED role. Proves: provenance
// ordering (confirmed user > accepted assumption > research) with secret redaction; a MEM-004 conflict (confirmed +
// AI assumption on one source_ref) is flagged, BOTH items withheld, and audited (context.conflict_flagged); empty
// memory → empty context; a non-member is forbidden; cross-company isolation (A's assembly never sees B's memory);
// audit-or-nothing (an in-tx audit failure surfaces nothing). Skips when ACBP_TEST_DATABASE_URL is unset. The secret
// in the redaction case is a SYNTHETIC high-entropy token (not a real credential).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { DatabaseClient, AuditScope } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createMemoryItem } from '../memory/index.js';
import { assembleContext } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const HIGH_ENTROPY_FIXTURE = 'aB3dEfGh1jKlMnOp2qRsTuVwXyZ3456789012345678'; // synthetic high-entropy token (redacted by the blocklist)

describe.skipIf(!hasTestDatabase)('context assembly (real PostgreSQL, restricted role) — ACBP-P2-007/CDR-032', () => {
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

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const seedFact = (content: string, sourceRef: string) => createMemoryItem(product, { ...base(), type: 'user_fact', content, sourceType: 'interview_answer', sourceRef });
  const seedAssumption = (content: string, sourceRef: string) => createMemoryItem(product, { ...base(), type: 'ai_assumption', content, sourceType: 'model_generation', sourceRef });
  const seedResearch = (content: string, sourceRef: string) => createMemoryItem(product, { ...base(), type: 'research_finding', content, sourceType: 'model_generation', sourceRef });
  const conflictAudits = async () => owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'context.conflict_flagged').where('company_id', '=', w.companyA1).execute();

  test('normal case: provenance-ordered context (confirmed > assumption > research), secrets redacted, no conflicts', async () => {
    await seedResearch('The market grows about 10% a year.', 'r:1');
    await seedAssumption('Assuming pricing is a monthly subscription.', 'q:pricing');
    await seedFact('We sell single-origin coffee to shops in Cairo.', 'q:customer');
    await seedFact(`Our internal token is ${HIGH_ENTROPY_FIXTURE}.`, 'q:ops');

    const r = await assembleContext(product, base());
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.conflicts).toHaveLength(0);
    const contents = r.contextParts.map((p) => p.content);
    // Tier order: the two user_facts (tier 1) precede the assumption (tier 2) precedes the research (tier 3).
    const factIdx = contents.findIndex((c) => c.includes('coffee'));
    const assumptionIdx = contents.findIndex((c) => c.includes('monthly subscription'));
    const researchIdx = contents.findIndex((c) => c.includes('market grows'));
    expect(factIdx).toBeGreaterThanOrEqual(0);
    expect(factIdx).toBeLessThan(assumptionIdx);
    expect(assumptionIdx).toBeLessThan(researchIdx);
    // The secret never reaches the context (redacted); the placeholder is present instead.
    expect(contents.join('\n')).not.toContain(HIGH_ENTROPY_FIXTURE);
    expect(contents.some((c) => c.includes('[REDACTED_SECRET]'))).toBe(true);
    expect(r.contextParts.every((p) => p.role === 'system')).toBe(true);
  });

  test('MEM-004 conflict: a confirmed fact + an AI assumption on one source_ref is flagged, both withheld, audited', async () => {
    const fact = await seedFact('Our target customer is small coffee shops.', 'question:7');
    const assumption = await seedAssumption('Assuming the target customer is large chains.', 'question:7');
    await seedFact('We are based in Cairo.', 'q:location'); // an unrelated fact that SHOULD appear
    expect(fact.status === 'ok' && assumption.status === 'ok').toBe(true);

    const r = await assembleContext(product, base());
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    // The conflict is surfaced (never silently rank-resolved).
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.sourceRef).toBe('question:7');
    // BOTH conflicting items are held out of the model context; the unrelated fact remains.
    const contents = r.contextParts.map((p) => p.content).join('\n');
    expect(contents).not.toContain('small coffee shops');
    expect(contents).not.toContain('large chains');
    expect(contents).toContain('based in Cairo');
    // The conflict was audited (bounded metadata, no content).
    const audits = await conflictAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toEqual({ confirmed_count: 1, assumption_count: 1 });
    expect(JSON.stringify(audits[0]!.payload)).not.toMatch(/coffee|chains|question:7/);
  });

  test('empty memory: an empty, conflict-free context', async () => {
    const r = await assembleContext(product, base());
    expect(r).toEqual({ status: 'ok', contextParts: [], conflicts: [], itemIds: [], withheldItemIds: [] });
  });

  test('ACBP-P4-006: itemIds correspond POSITIONALLY to contextParts — the link set is what reached the model', async () => {
    // PLAN-004 needs a resolvable link to what the run considered (MEM-003). Exposing the ids is only honest if they
    // are the SAME set, in the SAME order, as the parts — an id list that drifted from the content would be a
    // snapshot claiming inputs the model never saw, which is the fabricated-traceability failure ADR-019 forbids.
    await seedResearch('The market grows about 10% a year.', 'r:1');
    await seedAssumption('Assuming pricing is a monthly subscription.', 'q:pricing');
    await seedFact('We sell single-origin coffee to shops in Cairo.', 'q:customer');

    const r = await assembleContext(product, base());
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.itemIds).toHaveLength(r.contextParts.length);
    expect(new Set(r.itemIds).size).toBe(r.itemIds.length);
    expect(r.withheldItemIds).toEqual([]);
    // Resolve each id back to its row and confirm it is the content at the same index (redaction aside).
    const rows = await owner.kysely.selectFrom('memory_items').select(['id', 'content']).where('company_id', '=', w.companyA1).execute();
    const byId = new Map(rows.map((x) => [x.id, x.content]));
    r.itemIds.forEach((id, i) => {
      expect(byId.get(id)).toBe(r.contextParts[i]!.content);
    });
  });

  test('ACBP-P4-006: a MEM-004-withheld item is reported as WITHHELD, not as never considered', async () => {
    // "Looked at it and did not use it, because it conflicts" is transparency. Reporting nothing would make the
    // snapshot claim the item was never examined at all.
    await seedFact('Our target customer is small coffee shops.', 'question:7');
    await seedAssumption('Assuming the target customer is large chains.', 'question:7');
    await seedFact('We are based in Cairo.', 'q:location');

    const r = await assembleContext(product, base());
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.withheldItemIds).toHaveLength(2);
    expect(r.itemIds).toHaveLength(1);
    // The two sets are disjoint: an item is either in the context or withheld from it, never both.
    expect(r.itemIds.some((id) => r.withheldItemIds.includes(id))).toBe(false);
    const rows = await owner.kysely.selectFrom('memory_items').select(['id', 'content']).where('company_id', '=', w.companyA1).execute();
    const byId = new Map(rows.map((x) => [x.id, x.content]));
    expect(byId.get(r.itemIds[0]!)).toContain('based in Cairo');
    expect(r.withheldItemIds.map((id) => byId.get(id)).join('\n')).toContain('large chains');
  });

  test('a non-member is forbidden from assembling context', async () => {
    await seedFact('secret business plan', 'q:1');
    const r = await assembleContext(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(r.status).toBe('forbidden');
  });

  test('cross-company isolation: company A2 assembly never includes company A1 memory', async () => {
    await seedFact('A1 only: we roast our own beans.', 'q:roast');
    const r = await assembleContext(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.contextParts.map((p) => p.content).join('\n')).not.toContain('roast our own beans');
    expect(r.contextParts).toHaveLength(0);
  });

  test('audit-or-nothing: an in-tx audit failure on a flagged conflict surfaces nothing (rolls back)', async () => {
    await seedFact('Our target customer is small coffee shops.', 'question:9');
    await seedAssumption('Assuming the target customer is large chains.', 'question:9');
    await expect(assembleContext(product, base(), { auditWriter: (_s: AuditScope) => Promise.reject(new Error('audit down')) })).rejects.toThrow();
    // No conflict audit persisted.
    expect(await conflictAudits()).toHaveLength(0);
  });
});
