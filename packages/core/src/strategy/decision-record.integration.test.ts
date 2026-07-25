// ACBP-P3-005 / CDR-038 — real-PostgreSQL proof of recordDecision through the RESTRICTED role. No model gateway (pure
// persistence + audit). Proves the STRAT-006 guarantees end to end: a decision persists ONE immutable record + ONE
// decision.recorded audit event in the SAME transaction and is surfaced on the read; AUDIT-OR-NOTHING ("failed record
// writes block the transition" — a forced audit failure leaves NO decision); the record links the understanding
// version, the options considered, and the selection; a REJECT selection also gets a record (STRAT-006
// "selection/edit/rejection"); OWNER-ONLY (decision:record — a viewer and a non-member are forbidden); deny-by-default
// on an unusable rationale; not_found for an absent generation/selection or a cross-generation selection; recording
// unlocks NO planning (no tasks created); append-only / latest-wins; cross-company isolation. Skips when
// ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope, AuditWriteContext } from '@acbp/database';
import { STRATEGY_OPTION_FIELDS, RATIONALE_MAX_DECISION, type AuditEvent } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { recordDecision, recordStrategyDecision, getLatestStrategyGeneration } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

function optionFields(i: number): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f}-v`;
  return { ...o, customer: `customer-${i}`, offer: `offer-${i}`, business_model: `model-${i}` };
}

describe.skipIf(!hasTestDatabase)('decision records (real PostgreSQL, restricted role) — ACBP-P3-005/CDR-038', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let genA = '';
  let selA = '';

  async function seedGeneration(accountId: string, companyId: string, actorId: string, n: number, version = 1): Promise<string> {
    const doc = (await sql<{ id: string }>`insert into understanding_documents (account_id, company_id, version, status, overall_confidence, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${version}, 'complete', 0.6, ${actorId}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    const gen = (await sql<{ id: string }>`insert into strategy_generations (account_id, company_id, understanding_document_id, understanding_version, status, option_count, similarity_check_result, created_by_user_id) values (${accountId}::uuid, ${companyId}::uuid, ${doc}::uuid, ${version}, 'complete', ${n}, 'distinct', ${actorId}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    for (let i = 0; i < n; i += 1) {
      await sql`insert into strategy_options (account_id, company_id, generation_id, ordinal, fields) values (${accountId}::uuid, ${companyId}::uuid, ${gen}::uuid, ${i}, ${JSON.stringify(optionFields(i))}::jsonb)`.execute(owner.kysely);
    }
    return gen;
  }

  /** Record a real P3-004 selection through the product path (so the decision hardens a genuine selection). */
  async function makeSelection(generationId: string, request: Record<string, unknown>): Promise<string> {
    const r = await recordStrategyDecision(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, generationId, request: request as never });
    if (r.status !== 'ok') throw new Error(`selection setup failed: ${r.status}`);
    return r.selection.selectionId;
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
    selA = await makeSelection(genA, { mode: 'select', selectedOrdinal: 1 });
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const decsFor = async (generationId: string) => (await sql<{ id: string; selection_id: string; understanding_version: number; rationale: string | null }>`select id, selection_id, understanding_version, rationale from decisions where generation_id = ${generationId}::uuid order by created_at`.execute(owner.kysely)).rows;
  const auditCount = async () => (await sql<{ n: number }>`select count(*)::int as n from audit_events where name = 'decision.recorded'`.execute(owner.kysely)).rows[0]!.n;

  test('a decision persists ONE immutable record + ONE audit event, linking the understanding version + options considered + selection', async () => {
    const r = await recordDecision(product, { ...base(), generationId: genA, selectionId: selA, rationale: '  cheapest path to a first customer  ' });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.decision.selectionId).toBe(selA);
    expect(r.decision.generationId).toBe(genA);
    expect(r.decision.understandingVersion).toBe(1);
    expect(r.decision.optionsConsideredCount).toBe(3);
    expect(r.decision.rationale).toBe('cheapest path to a first customer'); // trimmed
    const rows = await decsFor(genA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.selection_id).toBe(selA);
    expect(await auditCount()).toBe(1);
    // Surfaced on the read (latest-wins), alongside the selection it hardens.
    const read = await getLatestStrategyGeneration(product, base());
    expect(read.status === 'ok' && read.generation?.decision?.decisionId).toBe(r.decision.decisionId);
    expect(read.status === 'ok' && read.generation?.decision?.understandingVersion).toBe(1);
  });

  test('AUDIT-OR-NOTHING (STRAT-006 "failed record writes block the transition"): a forced audit failure leaves NO decision', async () => {
    const failingAudit = (_scope: AuditScope, _event: AuditEvent, _ctx?: AuditWriteContext): Promise<string> => Promise.reject(new Error('audit boom'));
    await expect(recordDecision(product, { ...base(), generationId: genA, selectionId: selA }, {}, { auditWriter: failingAudit })).rejects.toThrow();
    // Neither the decision nor its audit event survives — the decision is not silently unrecorded.
    expect(await decsFor(genA)).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('a REJECT selection also gets a decision record (STRAT-006 "selection/edit/rejection")', async () => {
    const rejectSel = await makeSelection(genA, { mode: 'reject', reasons: 'none fit our budget' });
    const r = await recordDecision(product, { ...base(), generationId: genA, selectionId: rejectSel });
    expect(r.status === 'ok' && r.decision.selectionId).toBe(rejectSel);
    // The reject REASONS live on the selection, never duplicated onto the decision (CDR-038 G3).
    expect(r.status === 'ok' && r.decision.rationale).toBeNull();
    expect(await auditCount()).toBe(1);
  });

  test('the rationale is OPTIONAL; a present-but-unusable rationale is invalid (nothing persisted)', async () => {
    // Absent → recorded with a null rationale (a decision is never blocked for lacking one).
    expect((await recordDecision(product, { ...base(), generationId: genA, selectionId: selA })).status).toBe('ok');
    expect((await decsFor(genA))[0]!.rationale).toBeNull();
    // Over-long / non-string → invalid, nothing further persisted.
    expect((await recordDecision(product, { ...base(), generationId: genA, selectionId: selA, rationale: 'x'.repeat(RATIONALE_MAX_DECISION + 1) })).status).toBe('invalid');
    expect((await recordDecision(product, { ...base(), generationId: genA, selectionId: selA, rationale: 42 })).status).toBe('invalid');
    expect(await decsFor(genA)).toHaveLength(1);
    expect(await auditCount()).toBe(1);
  });

  test('OWNER-ONLY: a viewer is forbidden; a non-member is forbidden; nothing persisted', async () => {
    expect((await recordDecision(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, generationId: genA, selectionId: selA })).status).toBe('forbidden');
    expect((await recordDecision(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, generationId: genA, selectionId: selA })).status).toBe('forbidden');
    expect(await decsFor(genA)).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('not_found: an absent generation, an absent selection, and a CROSS-GENERATION selection', async () => {
    const foreign = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(owner.kysely)).rows[0]!.id;
    expect((await recordDecision(product, { ...base(), generationId: foreign, selectionId: selA })).status).toBe('not_found');
    expect((await recordDecision(product, { ...base(), generationId: genA, selectionId: foreign })).status).toBe('not_found');
    // A selection that belongs to a DIFFERENT generation cannot be hardened by this generation's decision.
    const gen2 = await seedGeneration(w.accountA, w.companyA1, w.aOwner, 3, 2);
    const sel2 = await makeSelection(gen2, { mode: 'select', selectedOrdinal: 0 });
    expect((await recordDecision(product, { ...base(), generationId: genA, selectionId: sel2 })).status).toBe('not_found');
    expect(await decsFor(genA)).toHaveLength(0);
  });

  test('recording a decision unlocks NO planning (no tasks are created — that gate is P4-001)', async () => {
    await recordDecision(product, { ...base(), generationId: genA, selectionId: selA });
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(0);
  });

  test('append-only / latest-wins: a second decision is a new row and the read surfaces the latest', async () => {
    await recordDecision(product, { ...base(), generationId: genA, selectionId: selA, rationale: 'first reasoning' });
    const second = await recordDecision(product, { ...base(), generationId: genA, selectionId: selA, rationale: 'revised reasoning' });
    expect(await decsFor(genA)).toHaveLength(2);
    const read = await getLatestStrategyGeneration(product, base());
    expect(read.status === 'ok' && read.generation?.decision?.rationale).toBe('revised reasoning');
    expect(second.status === 'ok' && read.status === 'ok' && read.generation?.decision?.decisionId).toBe(second.status === 'ok' ? second.decision.decisionId : '');
  });

  test('cross-company isolation: a company A2 decision attempt cannot see the company A1 generation', async () => {
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2, generationId: genA, selectionId: selA };
    expect((await recordDecision(product, a2)).status).toBe('not_found');
    expect(await decsFor(genA)).toHaveLength(0);
  });
});
