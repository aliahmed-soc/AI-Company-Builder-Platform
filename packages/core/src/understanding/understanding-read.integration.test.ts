// ACBP-API-013 (ACBP-FE-009) — real-PostgreSQL proof of `readCurrentUnderstanding` through the RESTRICTED role.
//
// This is the DOMAIN ADDITION the owner authorized on 2026-08-19, so it carries the full bar rather than the bar a
// routing ticket would carry. Proves: owner + viewer may read and a non-member may not; an absent document is a
// SUCCESS carrying null (G9) rather than a not-found; the current version wins over its predecessors; sections are
// recomputed from the stored items; `confirmed` tracks the SAME predicate the strategy-unlock gate uses, including
// after a DISC-008 correction supersedes it; and — the row this file exists for — SEEDED cross-tenant data in
// account B is invisible to account A, proved by content and not by an empty result.
//
// Skips when ACBP_TEST_DATABASE_URL is unset. ⚠️ A SKIP IS NOT A PASS: hosted CI is what makes this evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { UnderstandingClass } from '@acbp/contracts';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { readCurrentUnderstanding, confirmUnderstanding, correctUnderstanding, isCurrentUnderstandingConfirmed } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/**
 * The tenant-B content marker. It is deliberately a string that could not plausibly occur in tenant A's seeded content, so
 * that the invisibility assertion can be made against the SERIALISED response rather than against a field list —
 * a field-by-field check only proves the fields someone remembered to name.
 */
const B_TENANT_MARKER = 'ZZ-TENANT-B-ONLY-MARKER';

describe.skipIf(!hasTestDatabase)('reading the current understanding (real PostgreSQL, restricted role) — ACBP-API-013', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let docA1 = '';

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
    // Company A1 — a v1 document with three items spanning three classes, so the section rollup has something to
    // roll up and a class-specific assertion is possible. Seeded as the superuser, which bypasses RLS by design.
    docA1 = await seedDocument(w.accountA, w.companyA1, w.aOwner, 1, 0.6, [
      ['fact', 'Sells single-origin coffee wholesale.', 0.9],
      ['fact', 'Operates from one roastery.', 0.8],
      ['assumption', 'Buyers are independent cafes.', 0.4],
    ]);
    // Company B1 — a SEPARATE TENANT with REAL, distinctive content. The invisibility proof is worthless against an
    // empty tenant: an empty result would then be indistinguishable from working isolation.
    // B's classes are deliberately ones A has NONE of, so "A cannot see B" is provable by class as well as by
    // content — and both are drawn from the imported vocabulary rather than invented.
    await seedDocument(w.accountB, w.companyB1, w.bOwner, 1, 0.95, [
      ['constraint', `${B_TENANT_MARKER} — B may only ship within one region.`, 0.99],
      ['research_finding', `${B_TENANT_MARKER} — B has a single-supplier dependency.`, 0.9],
    ]);
  });

  /*
   * ⚠️ THE CLASS IS TYPED `UnderstandingClass`, NOT `string`, AND THAT IS A FIX RATHER THAN A STYLE CHOICE.
   * The first version of this fixture seeded an item class of `risk`, which does not exist. `understanding_items`
   * has a CHECK constraint over the closed six (`understanding_items_class_valid`, migration 0019), so every
   * test in this file went red in `beforeEach` with
   *     error: new row for relation "understanding_items" violates check constraint "understanding_items_class_valid"
   * and none of them tested anything. Typing the parameter to the imported union makes an invented class a
   * COMPILE error instead of eight runtime failures whose real cause is one line up in the setup.
   */
  async function seedDocument(
    accountId: string,
    companyId: string,
    userId: string,
    version: number,
    confidence: number,
    items: readonly (readonly [UnderstandingClass, string, number])[],
  ): Promise<string> {
    const docId = (
      await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${version}, 'complete', ${confidence}, ${userId}::uuid) returning id`.execute(owner.kysely)
    ).rows[0]!.id;
    for (const [cls, content, conf] of items) {
      await sql`insert into understanding_items (account_id, company_id, document_id, item_class, content, confidence, source_ref) values (${accountId}::uuid, ${companyId}::uuid, ${docId}::uuid, ${cls}, ${content}, ${conf}, null)`.execute(owner.kysely);
    }
    return docId;
  }

  const asOwner = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });

  test('the owner reads the current document with its items, confidence and recomputed sections', async () => {
    const r = await readCurrentUnderstanding(product, asOwner());
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.document).not.toBeNull();
    // Not merely 'a document' — THE seeded one. Without this the test would pass against any document at all.
    expect(r.document!.documentId).toBe(docA1);
    expect(r.document!.version).toBe(1);
    expect(r.document!.status).toBe('complete');
    expect(r.document!.overallConfidence).toBeCloseTo(0.6, 5);
    expect(r.document!.items).toHaveLength(3);
    expect(r.document!.items.map((i) => i.class).sort()).toEqual(['assumption', 'fact', 'fact']);
    // Sections are RECOMPUTED from the stored items, not persisted — one definition of a section, not two.
    const fact = r.document!.sections.find((s) => s.class === 'fact');
    expect(fact).toBeDefined();
    expect(fact!.count).toBe(2);
    expect(r.confirmed).toBe(false);
  });

  test('a VIEWER may read it — this read is owner+viewer, like the gate it shares an action with', async () => {
    const r = await readCurrentUnderstanding(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.document!.items).toHaveLength(3);
  });

  test('a NON-MEMBER is forbidden, and learns nothing about whether the company even has an understanding', async () => {
    // Account B's owner, pointed at account A's company. The refusal is identical to the refusal for a company that
    // has no document at all — the status carries no existence signal either way.
    const r = await readCurrentUnderstanding(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 });
    expect(r).toEqual({ status: 'forbidden' });
  });

  test('SEEDED cross-tenant invisibility: account A can neither reach nor see account B content', async () => {
    // 1. Direct reach across the tenant boundary is refused.
    const reach = await readCurrentUnderstanding(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyB1 });
    expect(reach).toEqual({ status: 'forbidden' });

    // 2. And A's own legitimate read never carries B's rows. Asserted against the SERIALISED result, so a field
    //    added later that leaked B content would fail this test without anyone remembering to name it here.
    const mine = await readCurrentUnderstanding(product, asOwner());
    expect(JSON.stringify(mine)).not.toContain(B_TENANT_MARKER);
    expect(JSON.stringify(mine)).not.toContain('single-supplier');
    if (mine.status === 'ok') {
      expect(mine.document!.items).toHaveLength(3);
      expect(mine.document!.items.every((i) => i.content.includes('coffee') || i.content.includes('roastery') || i.content.includes('cafes'))).toBe(true);
      // B's two classes are ones A established nothing in. `computeSections` always returns all six, so the
      // assertion is on the COUNT — a section that exists with zero items, never one carrying B's.
      for (const cls of ['constraint', 'research_finding'] as const) {
        expect(mine.document!.sections.find((s) => s.class === cls)?.count).toBe(0);
      }
    }

    // 3. The isolation is mutual, and B's own read still works — proving the boundary blocks the crossing rather
    //    than the data (an assertion that would pass just as well against a broken seed).
    const theirs = await readCurrentUnderstanding(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 });
    expect(theirs.status).toBe('ok');
    if (theirs.status === 'ok') expect(JSON.stringify(theirs)).toContain(B_TENANT_MARKER);
  });

  test('no understanding yet is a SUCCESS carrying null, never a not-found (the G9 rule)', async () => {
    // Company A2 is a real company the caller may read; it simply has not been through discovery yet. A refusal or
    // an error here is how a founder's first visit turns into an error page.
    const r = await readCurrentUnderstanding(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 });
    expect(r).toEqual({ status: 'ok', document: null, confirmed: false });
  });

  test('the CURRENT version wins: a later version supersedes its predecessor', async () => {
    await seedDocument(w.accountA, w.companyA1, w.aOwner, 2, 0.75, [['fact', 'Added wholesale subscriptions.', 0.85]]);
    const r = await readCurrentUnderstanding(product, asOwner());
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.document!.version).toBe(2);
    expect(r.document!.items).toHaveLength(1);
    // The v1 items are not merged in — a merged read would misreport what the current understanding says.
    expect(JSON.stringify(r.document)).not.toContain('roastery');
  });

  test('`confirmed` agrees with the strategy-unlock gate — before, after confirming, and after a correction', async () => {
    const gate = () => isCurrentUnderstandingConfirmed(product, asOwner());
    const read = () => readCurrentUnderstanding(product, asOwner());

    expect(await flagsOf(read())).toEqual({ confirmed: false, superseded: false });
    expect((await gate()) as unknown).toEqual({ status: 'ok', confirmed: false, version: 1 });

    await confirmUnderstanding(product, { ...asOwner(), expectedVersion: 1 });
    expect(await flagsOf(read())).toEqual({ confirmed: true, superseded: false });
    expect((await gate()) as unknown).toEqual({ status: 'ok', confirmed: true, version: 1 });

    // DISC-008: a correction supersedes the confirmation. The read must flip with the gate, not lag behind it —
    // a screen still showing "confirmed" while planning is blocked is the drift this shared predicate prevents.
    await correctUnderstanding(product, { ...asOwner(), expectedVersion: 1, correctionRef: 'ref' });
    expect(await flagsOf(read())).toEqual({ confirmed: false, superseded: true });
    expect((await gate()) as unknown).toEqual({ status: 'ok', confirmed: false, version: 1 });
  });

  test('SUPERSEDED distinguishes a corrected document from one nobody confirmed — against real recorded events', async () => {
    /*
     * The unit tests prove the predicate; this proves the two states are actually distinguishable END TO END,
     * from rows PostgreSQL really holds. Company A1 has never been confirmed and A2 has no document at all, so
     * both read `confirmed: false` — and neither is stale. Only the corrected one is.
     */
    const a1 = await readCurrentUnderstanding(product, asOwner());
    const a2 = await readCurrentUnderstanding(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 });
    expect(a1.status === 'ok' && a1.confirmed).toBe(false);
    expect(a1.status === 'ok' && a1.superseded).toBe(false);
    expect(a2).toEqual({ status: 'ok', document: null, confirmed: false, superseded: false });

    await confirmUnderstanding(product, { ...asOwner(), expectedVersion: 1 });
    await correctUnderstanding(product, { ...asOwner(), expectedVersion: 1, correctionRef: 'ref' });
    const corrected = await readCurrentUnderstanding(product, asOwner());
    expect(corrected.status === 'ok' && corrected.confirmed).toBe(false);
    // Same `confirmed` value as the never-confirmed read above; a DIFFERENT state, and now the screen can tell.
    expect(corrected.status === 'ok' && corrected.superseded).toBe(true);
  });

  test('the read is READ-ONLY: it writes no rows and emits no audit event', async () => {
    // A read that audited would let anyone opening a screen add rows to the record of what happened to a company.
    const before = await counts();
    await readCurrentUnderstanding(product, asOwner());
    await readCurrentUnderstanding(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 });
    expect(await counts()).toEqual(before);
  });

  async function counts(): Promise<Record<string, number>> {
    const q = async (t: string): Promise<number> => (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t)}`.execute(owner.kysely)).rows[0]!.n;
    return {
      audit: await q('audit_events'),
      documents: await q('understanding_documents'),
      items: await q('understanding_items'),
      events: await q('understanding_confirmation_events'),
    };
  }

  /** Both lifecycle flags together — asserting them as a pair is what stops one silently tracking the other. */
  async function flagsOf(p: ReturnType<typeof readCurrentUnderstanding>): Promise<{ confirmed: boolean; superseded: boolean }> {
    const r = await p;
    // A fixture that cannot produce the state under test THROWS rather than returning a value the caller reads
    // as an answer.
    if (r.status !== 'ok') throw new Error(`expected an ok read, got ${r.status}`);
    return { confirmed: r.confirmed, superseded: r.superseded };
  }
});
