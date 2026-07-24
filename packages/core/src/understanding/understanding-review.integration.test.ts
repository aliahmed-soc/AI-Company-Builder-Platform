// ACBP-P2-009 / CDR-030 — real-PostgreSQL proof of the understanding review + confirmation use cases through the
// RESTRICTED role. Proves: the five per-item controls record + audit (understanding.item_reviewed, no content);
// owner-only confirm unlocks strategy (understanding.confirmed) and is idempotent; the gate blocks planning
// pre-confirm; a DISC-008 correction supersedes the confirmation, re-blocks planning, flags dependents
// (understanding.corrected); optimistic-concurrency staleness; owner-only (viewer + non-member denied); cross-company
// isolation; audit-or-nothing rollback; no-understanding handling. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { recordUnderstandingReview, confirmUnderstanding, correctUnderstanding, isCurrentUnderstandingConfirmed } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('understanding review + confirmation (real PostgreSQL, restricted role) — ACBP-P2-009/CDR-030', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let docA = '';
  let itemA = '';

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
    // Seed a v1 understanding document + one item for company A (the review target). Owner (superuser) bypasses RLS.
    docA = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 1, 'complete', 0.5, ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    itemA = (await sql<{ id: string }>`insert into understanding_items (account_id, company_id, document_id, item_class, content, confidence, source_ref) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${docA}::uuid, 'fact', 'Sells specialty coffee.', 0.9, null) returning id`.execute(owner.kysely)).rows[0]!.id;
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const auditFor = async (name: string) => owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', name).execute();
  const eventsFor = async (docId: string) => (await sql<{ kind: string }>`select kind from understanding_confirmation_events where document_id = ${docId}::uuid`.execute(owner.kysely)).rows;

  test('the five review controls each record a decision + a bounded understanding.item_reviewed audit (no content)', async () => {
    for (const decision of ['approved', 'edited', 'rejected', 'evidence_requested', 'research_requested'] as const) {
      const note = decision === 'edited' ? 'Corrected: sells single-origin coffee.' : decision === 'rejected' ? 'too speculative' : null;
      const r = await recordUnderstandingReview(product, { ...base(), itemId: itemA, decision, note, expectedVersion: 1 });
      expect(r.status).toBe('ok');
    }
    const rows = await sql<{ n: number }>`select count(*)::int as n from understanding_item_reviews where item_id = ${itemA}::uuid`.execute(owner.kysely);
    expect(rows.rows[0]!.n).toBe(5);
    const audits = await auditFor('understanding.item_reviewed');
    expect(audits).toHaveLength(5);
    // No item content or edited text ever reaches the audit metadata.
    expect(JSON.stringify(audits.map((a) => a.payload))).not.toContain('coffee');
    expect(audits.every((a) => a.subject_id === itemA)).toBe(true);
    expect(audits.map((a) => (a.payload as { decision: string }).decision).sort()).toEqual(['approved', 'edited', 'evidence_requested', 'rejected', 'research_requested']);
  });

  test('review validation: unknown decision, edit without a note, a stale version, and a foreign item are each rejected', async () => {
    expect((await recordUnderstandingReview(product, { ...base(), itemId: itemA, decision: 'approve', expectedVersion: 1 })).status).toBe('invalid');
    expect((await recordUnderstandingReview(product, { ...base(), itemId: itemA, decision: 'edited', note: '   ', expectedVersion: 1 })).status).toBe('invalid');
    expect((await recordUnderstandingReview(product, { ...base(), itemId: itemA, decision: 'approved', expectedVersion: 99 })).status).toBe('stale_version');
    // A random (non-existent / not-in-current-version) item id → item_not_found.
    const foreign = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(owner.kysely)).rows[0]!.id;
    expect((await recordUnderstandingReview(product, { ...base(), itemId: foreign, decision: 'approved', expectedVersion: 1 })).status).toBe('item_not_found');
    // Nothing persisted from the rejected attempts.
    expect((await sql<{ n: number }>`select count(*)::int as n from understanding_item_reviews`.execute(owner.kysely)).rows[0]!.n).toBe(0);
  });

  test('confirm: planning is blocked pre-confirm; owner confirm unlocks strategy + audits; confirm is idempotent', async () => {
    // Gate is false before confirmation (planning blocked).
    const before = await isCurrentUnderstandingConfirmed(product, base());
    expect(before).toEqual({ status: 'ok', confirmed: false, version: 1 });

    const c = await confirmUnderstanding(product, { ...base(), expectedVersion: 1 });
    expect(c).toEqual({ status: 'ok', version: 1, alreadyConfirmed: false });
    // Gate flips true (strategy unlocked).
    expect(await isCurrentUnderstandingConfirmed(product, base())).toEqual({ status: 'ok', confirmed: true, version: 1 });
    const audits = await auditFor('understanding.confirmed');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.subject_id).toBe(docA);
    expect(audits[0]!.payload).toEqual({ version: 1 });

    // Idempotent: a repeat confirm is a graceful no-op — no second event, no second audit.
    const again = await confirmUnderstanding(product, { ...base(), expectedVersion: 1 });
    expect(again).toEqual({ status: 'ok', version: 1, alreadyConfirmed: true });
    expect((await eventsFor(docA)).filter((e) => e.kind === 'confirmed')).toHaveLength(1);
    expect(await auditFor('understanding.confirmed')).toHaveLength(1);
  });

  test('correct (DISC-008): a material correction supersedes the confirmation, re-blocks planning, flags dependents', async () => {
    // Cannot correct before confirmation.
    expect((await correctUnderstanding(product, { ...base(), expectedVersion: 1, correctionRef: 'ref' })).status).toBe('not_confirmed');
    await confirmUnderstanding(product, { ...base(), expectedVersion: 1 });

    const r = await correctUnderstanding(product, { ...base(), expectedVersion: 1, correctionRef: itemA });
    expect(r).toEqual({ status: 'ok', version: 1, dependentsFlagged: 1, alreadyCorrected: false });
    // Gate re-blocks planning (the correction supersedes the confirmation — dependents flagged).
    expect(await isCurrentUnderstandingConfirmed(product, base())).toEqual({ status: 'ok', confirmed: false, version: 1 });
    const audits = await auditFor('understanding.corrected');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toEqual({ version: 1, correction_ref: itemA, dependents_flagged: 1 });

    // Idempotent correction; and a corrected version cannot be re-confirmed (must regenerate a new version).
    expect((await correctUnderstanding(product, { ...base(), expectedVersion: 1, correctionRef: itemA })).status).toBe('ok');
    expect((await eventsFor(docA)).filter((e) => e.kind === 'corrected')).toHaveLength(1);
    expect((await confirmUnderstanding(product, { ...base(), expectedVersion: 1 })).status).toBe('stale_version');
  });

  test('owner-only: a viewer and a non-member are both forbidden from review, confirm, and correct', async () => {
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    const nonMember = { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 };
    expect((await recordUnderstandingReview(product, { ...viewer, itemId: itemA, decision: 'approved', expectedVersion: 1 })).status).toBe('forbidden');
    expect((await confirmUnderstanding(product, { ...viewer, expectedVersion: 1 })).status).toBe('forbidden');
    expect((await correctUnderstanding(product, { ...viewer, expectedVersion: 1, correctionRef: 'r' })).status).toBe('forbidden');
    expect((await recordUnderstandingReview(product, { ...nonMember, itemId: itemA, decision: 'approved', expectedVersion: 1 })).status).toBe('forbidden');
    expect((await confirmUnderstanding(product, { ...nonMember, expectedVersion: 1 })).status).toBe('forbidden');
    // Nothing persisted from the denied attempts.
    expect((await sql<{ n: number }>`select count(*)::int as n from understanding_item_reviews`.execute(owner.kysely)).rows[0]!.n).toBe(0);
    expect((await eventsFor(docA))).toHaveLength(0);
    // A viewer MAY read the gate (owner+viewer read).
    expect((await isCurrentUnderstandingConfirmed(product, viewer)).status).toBe('ok');
  });

  test('audit-or-nothing: an in-tx audit failure on confirm rolls back — no confirmation event persists', async () => {
    await expect(confirmUnderstanding(product, { ...base(), expectedVersion: 1 }, { auditWriter: (_s: AuditScope) => Promise.reject(new Error('audit down')) })).rejects.toThrow();
    expect((await eventsFor(docA))).toHaveLength(0);
    expect(await isCurrentUnderstandingConfirmed(product, base())).toEqual({ status: 'ok', confirmed: false, version: 1 });
  });

  test('no understanding yet: the gate reads unconfirmed/null and confirm/correct report no_understanding (company A2)', async () => {
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 };
    expect(await isCurrentUnderstandingConfirmed(product, a2)).toEqual({ status: 'ok', confirmed: false, version: null });
    expect((await confirmUnderstanding(product, { ...a2, expectedVersion: 1 })).status).toBe('no_understanding');
    expect((await correctUnderstanding(product, { ...a2, expectedVersion: 1, correctionRef: 'r' })).status).toBe('no_understanding');
  });

  test('cross-company isolation: company A2 owner-scope cannot see or confirm company A1 understanding', async () => {
    // Under company A2 scope there is no document, so a confirm there never touches A1's version.
    await confirmUnderstanding(product, { ...base(), expectedVersion: 1 });
    expect((await confirmUnderstanding(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2, expectedVersion: 1 })).status).toBe('no_understanding');
    // A1 remains confirmed; A2 gate stays false — no leakage.
    expect(await isCurrentUnderstandingConfirmed(product, base())).toEqual({ status: 'ok', confirmed: true, version: 1 });
    expect(await isCurrentUnderstandingConfirmed(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 })).toEqual({ status: 'ok', confirmed: false, version: null });
  });
});
