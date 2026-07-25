// ACBP-P3-004 / CDR-037 — real-PostgreSQL proof of recordStrategyDecision through the RESTRICTED role. No model gateway
// (the OWNER supplies the decision). Proves: each of the four modes (select/edit/combine/reject) persists ONE immutable
// selection + ONE strategy.selected audit event in the SAME transaction, and is surfaced on the read; OWNER-ONLY
// (strategy:select — a viewer is forbidden; a non-member is forbidden); deny-by-default validation (bad mode / bad
// ordinal / shape mismatch → invalid, nothing persisted); not_found for an absent/invisible generation; audit-or-nothing
// (a forced audit failure rolls the selection back); records a SELECTION ONLY (no decision record, no planning unlock —
// only a strategy_selections row + its audit event exist); append-only / latest-wins; cross-company isolation. Skips
// when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope, AuditWriteContext } from '@acbp/database';
import { STRATEGY_OPTION_FIELDS, type AuditEvent, type StrategyOptionFields } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { recordStrategyDecision, getLatestStrategyGeneration } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

function optionFields(i: number): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f}-v`;
  return { ...o, customer: `customer-${i}`, offer: `offer-${i}`, business_model: `model-${i}` };
}
function fullFields(over: Record<string, string> = {}): StrategyOptionFields {
  const o: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) o[f] = `${f}-authored`;
  return { ...o, ...over } as StrategyOptionFields;
}

describe.skipIf(!hasTestDatabase)('strategy selection (real PostgreSQL, restricted role) — ACBP-P3-004/CDR-037', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let genA = '';

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
  const selsFor = async (generationId: string) => (await sql<{ id: string; mode: string; selected_option_id: string | null; phase_scope: string | null; reasons: string | null }>`select id, mode, selected_option_id, phase_scope, reasons from strategy_selections where generation_id = ${generationId}::uuid order by created_at`.execute(owner.kysely)).rows;
  const auditCount = async () => (await sql<{ n: number }>`select count(*)::int as n from audit_events where name = 'strategy.selected'`.execute(owner.kysely)).rows[0]!.n;

  test('select: an existing option is chosen; ONE selection + ONE audit event; surfaced on the read', async () => {
    const r = await recordStrategyDecision(product, { ...base(), generationId: genA, request: { mode: 'select', selectedOrdinal: 1, phaseScope: 'first_phase' } });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.selection.mode).toBe('select');
    expect(r.selection.selectedOptionId).not.toBeNull();
    expect(r.selection.phaseScope).toBe('first_phase');
    const rows = await selsFor(genA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mode).toBe('select');
    expect(await auditCount()).toBe(1);
    const read = await getLatestStrategyGeneration(product, base());
    expect(read.status === 'ok' && read.generation?.selection?.mode).toBe('select');
    expect(read.status === 'ok' && read.generation?.selection?.phaseScope).toBe('first_phase');
  });

  test('edit: an option is revised with owner-supplied fields (no base ordinal required)', async () => {
    const r = await recordStrategyDecision(product, { ...base(), generationId: genA, request: { mode: 'edit', selectedOrdinal: 0, chosenFields: fullFields({ description: 'my revision' }), phaseScope: 'whole_plan' } });
    expect(r.status === 'ok' && r.selection.mode).toBe('edit');
    if (r.status === 'ok') {
      expect(r.selection.chosenFields?.description).toBe('my revision');
      expect(r.selection.selectedOptionId).not.toBeNull();
      expect(r.selection.phaseScope).toBe('whole_plan');
    }
    expect((await selsFor(genA))[0]!.mode).toBe('edit');
    expect(await auditCount()).toBe(1);
  });

  test('combine: a new option is authored from several (no base option)', async () => {
    const r = await recordStrategyDecision(product, { ...base(), generationId: genA, request: { mode: 'combine', chosenFields: fullFields({ offer: 'blended offer' }) } });
    expect(r.status === 'ok' && r.selection.mode).toBe('combine');
    if (r.status === 'ok') {
      expect(r.selection.selectedOptionId).toBeNull();
      expect(r.selection.chosenFields?.offer).toBe('blended offer');
    }
    expect((await selsFor(genA))[0]!.selected_option_id).toBeNull();
    expect(await auditCount()).toBe(1);
  });

  test('reject: none fit — reasons recorded, no option/fields/phase scope', async () => {
    const r = await recordStrategyDecision(product, { ...base(), generationId: genA, request: { mode: 'reject', reasons: 'None fit our budget or timeline.' } });
    expect(r.status === 'ok' && r.selection.mode).toBe('reject');
    if (r.status === 'ok') {
      expect(r.selection.reasons).toBe('None fit our budget or timeline.');
      expect(r.selection.selectedOptionId).toBeNull();
      expect(r.selection.chosenFields).toBeNull();
      expect(r.selection.phaseScope).toBeNull();
    }
    expect((await selsFor(genA))[0]!.reasons).toBe('None fit our budget or timeline.');
    expect(await auditCount()).toBe(1);
  });

  test('OWNER-ONLY: a viewer is forbidden; a non-member is forbidden; nothing persisted', async () => {
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, generationId: genA, request: { mode: 'select' as const, selectedOrdinal: 0 } };
    expect((await recordStrategyDecision(product, viewer)).status).toBe('forbidden');
    const nonMember = { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, generationId: genA, request: { mode: 'select' as const, selectedOrdinal: 0 } };
    expect((await recordStrategyDecision(product, nonMember)).status).toBe('forbidden');
    expect(await selsFor(genA)).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('DENY-BY-DEFAULT: an unknown mode, an out-of-range ordinal, and a shape mismatch each → invalid (nothing persisted)', async () => {
    for (const request of [
      { mode: 'approve', selectedOrdinal: 0 },
      { mode: 'select', selectedOrdinal: 9 },
      { mode: 'select', selectedOrdinal: 0, chosenFields: fullFields() }, // select must not carry fields
      { mode: 'reject' }, // reject must carry reasons
    ]) {
      expect((await recordStrategyDecision(product, { ...base(), generationId: genA, request })).status).toBe('invalid');
    }
    expect(await selsFor(genA)).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('not_found: deciding over an absent / invisible generation id', async () => {
    const foreign = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(owner.kysely)).rows[0]!.id;
    expect((await recordStrategyDecision(product, { ...base(), generationId: foreign, request: { mode: 'select', selectedOrdinal: 0 } })).status).toBe('not_found');
  });

  test('audit-or-nothing: a forced audit failure rolls the selection back', async () => {
    const failingAudit = (_scope: AuditScope, _event: AuditEvent, _ctx?: AuditWriteContext): Promise<string> => Promise.reject(new Error('audit boom'));
    await expect(recordStrategyDecision(product, { ...base(), generationId: genA, request: { mode: 'select', selectedOrdinal: 0 } }, {}, { auditWriter: failingAudit })).rejects.toThrow();
    // Neither the selection nor its audit event survives.
    expect(await selsFor(genA)).toHaveLength(0);
    expect(await auditCount()).toBe(0);
  });

  test('records a SELECTION ONLY: no planning is unlocked (no tasks are created by a decision)', async () => {
    await recordStrategyDecision(product, { ...base(), generationId: genA, request: { mode: 'select', selectedOrdinal: 1 } });
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(0);
  });

  test('append-only / latest-wins: a second decision is a new row and the read surfaces the latest', async () => {
    await recordStrategyDecision(product, { ...base(), generationId: genA, request: { mode: 'select', selectedOrdinal: 0 } });
    await recordStrategyDecision(product, { ...base(), generationId: genA, request: { mode: 'reject', reasons: 'changed my mind' } });
    expect(await selsFor(genA)).toHaveLength(2);
    const read = await getLatestStrategyGeneration(product, base());
    expect(read.status === 'ok' && read.generation?.selection?.mode).toBe('reject');
    expect(read.status === 'ok' && read.generation?.selection?.reasons).toBe('changed my mind');
  });

  test('cross-company isolation: a company A2 decision attempt cannot see the company A1 generation', async () => {
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2, generationId: genA, request: { mode: 'select' as const, selectedOrdinal: 0 } };
    expect((await recordStrategyDecision(product, a2)).status).toBe('not_found');
    expect(await selsFor(genA)).toHaveLength(0);
  });
});
