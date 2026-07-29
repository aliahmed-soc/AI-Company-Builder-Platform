// ACBP-P6-001c / CDR-066 §6 — the policy engine service against a REAL database, through the restricted role.
//
// Acceptance clause: ***"unavailability denies"*** (TOOL-003). The case that matters most is the one CDR-066 §6-G15
// nearly got wrong: a company with NO ACTIVE POLICY must DENY, and must not present as "unavailable" — because an
// `unavailable` policy answer is still WAIVED by the dispatcher for an informational-class tool on a trusted path,
// so modelling a missing policy as unavailability would let an unconfigured company run AI actions ungoverned.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { DEFAULT_NEW_COMPANY_POLICY } from '@acbp/contracts';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { evaluateCompanyPolicy, initializeCompanyPolicy, toPolicyGateAnswer } from './policy-service.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const AT = new Date('2026-07-29T12:00:00.000Z');

describe.skipIf(!hasTestDatabase)('the policy engine service (real PostgreSQL, restricted role) — ACBP-P6-001c/CDR-066', () => {
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

  const ids = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const evaluate = (observations: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    evaluateCompanyPolicy(product, { ...ids(), evaluationPoint: 'pre_execution', observations, evaluatedAt: AT, ...over } as never);
  const auditNames = async (): Promise<string[]> => {
    const r = await sql<{ name: string }>`select name from audit_events where company_id = ${w.companyA1}::uuid order by occurred_at, event_id`.execute(owner.kysely);
    return r.rows.map((x) => x.name);
  };
  const evaluationCount = async (): Promise<number> => {
    const r = await sql<{ n: number }>`select count(*)::int as n from policy_evaluations where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);
    return r.rows[0]?.n ?? 0;
  };

  // ── the acceptance clause ────────────────────────────────────────────────────────────────────────────────
  describe('unavailability denies (TOOL-003, CDR-066 §6-G15)', () => {
    test('a company with NO ACTIVE POLICY is refused — and the refusal maps to DENY, never to a waivable gate', async () => {
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      expect(r.status).toBe('no_usable_policy');
      expect(r).toMatchObject({ reason: 'no_active_policy' });
      // THE POINT OF THE WHOLE TICKET: informational + trusted is exactly the shape the dispatcher waiver spares
      // when policy answers `unavailable`. This must be a DENY so the waiver never applies.
      expect(toPolicyGateAnswer(r)).toEqual({ kind: 'deny' });
    });

    test('the no-policy refusal is audited as UNAVAILABLE and writes no evaluation row (G16)', async () => {
      await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      expect(await auditNames()).toContain('policy.unavailable');
      expect(await evaluationCount()).toBe(0);
    });

    test('an UNREADABLE stored rule set is refused too, and says which problem it was', async () => {
      await initializeCompanyPolicy(product, ids());
      // Corrupt the stored rules on the OWNER connection — the product role cannot edit them, which is itself the
      // point of the column-scoped grant (P6-001b). This forces the branch a malformed policy would take.
      await sql`update policies set rules = '[{"id":"broken"}]'::jsonb where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      // The rule set is still READABLE (an array), so the evaluator runs and the malformed RULE denies (G4) — a
      // decided deny, not an unavailability. This pins the distinction rather than assuming it.
      expect(r.status).toBe('decided');
      expect(r).toMatchObject({ decision: 'deny' });
      expect(toPolicyGateAnswer(r)).toEqual({ kind: 'deny' });
    });

    test('a rule set that is not an array at all is UNREADABLE, and is reported as such', async () => {
      await initializeCompanyPolicy(product, ids());
      // The CHECK forbids a non-array via the product path, so this is written as the owner to reach the branch.
      await sql`alter table policies drop constraint policies_rules_is_array`.execute(owner.kysely);
      await sql`update policies set rules = '{"nope":true}'::jsonb where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      expect(r).toMatchObject({ status: 'no_usable_policy', reason: 'policy_unreadable' });
      expect(toPolicyGateAnswer(r)).toEqual({ kind: 'deny' });
      expect(await auditNames()).toContain('policy.unavailable');
      // Make the row VALID again before restoring the constraint — re-adding it against the offending row fails
      // with 23514 and would leave the schema permanently missing a guard for every later test in this file.
      await sql`update policies set rules = '[]'::jsonb where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);
      await sql`alter table policies add constraint policies_rules_is_array check (jsonb_typeof(rules) = 'array')`.execute(owner.kysely);
    });
  });

  // ── the ruled default, end to end ────────────────────────────────────────────────────────────────────────
  describe('the owner-ruled baseline, through the database (G10)', () => {
    test('initialization seeds the ruled default and audits the change', async () => {
      const r = await initializeCompanyPolicy(product, ids());
      expect(r).toMatchObject({ status: 'ok', version: DEFAULT_NEW_COMPANY_POLICY.version });
      expect(await auditNames()).toContain('policy.changed');
    });

    test('initialization is idempotent — a second call reports the existing policy', async () => {
      const first = await initializeCompanyPolicy(product, ids());
      const second = await initializeCompanyPolicy(product, ids());
      expect(second.status).toBe('already_initialized');
      expect(second).toMatchObject({ policyId: (first as { policyId: string }).policyId });
    });

    test('informational and internal_reversible are ALLOWED on the seeded default', async () => {
      await initializeCompanyPolicy(product, ids());
      for (const riskClass of ['informational', 'internal_reversible']) {
        const r = await evaluate({ risk_class: { value: riskClass, provenance: 'registry' } });
        expect(r).toMatchObject({ status: 'decided', decision: 'allow' });
        expect(toPolicyGateAnswer(r)).toEqual({ kind: 'allow' });
      }
    });

    test('higher risk classes REQUIRE APPROVAL — and that passes through to the gate UNFLATTENED', async () => {
      await initializeCompanyPolicy(product, ids());
      for (const riskClass of ['external_reversible', 'sensitive_irreversible']) {
        const r = await evaluate({ risk_class: { value: riskClass, provenance: 'registry' } });
        expect(r).toMatchObject({ status: 'decided', decision: 'require_approval' });
        // UPDATED BY ACBP-P6-002 (CDR-067 §2-G7). This used to assert `allow`, because `GateAnswer` could not express
        // `require_approval` and the middle output had to be flattened onto the permissive one — which is exactly what
        // created the CDR-066 §0 bypass. The gate answer now carries the requirement itself, so `require_approval`
        // travels intact and the dispatcher demands an approval BECAUSE policy said to.
        expect(toPolicyGateAnswer(r)).toEqual({ kind: 'require_approval' });
      }
    });

    test('a MODEL-sourced risk class cannot buy the permissive path, even through the database', async () => {
      await initializeCompanyPolicy(product, ids());
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'model' } });
      expect(r).toMatchObject({ status: 'decided', decision: 'require_approval' });
      expect(r).toMatchObject({ untrustedRuleIds: ['baseline-risk-approval'] });
    });
  });

  // ── recording ────────────────────────────────────────────────────────────────────────────────────────────
  describe('the evaluation record (POL-006)', () => {
    test('every evaluation writes a row citing the policy version, and audits it', async () => {
      await initializeCompanyPolicy(product, ids());
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      expect(r).toMatchObject({ status: 'decided', policyVersion: 1 });
      expect(await evaluationCount()).toBe(1);
      expect(await auditNames()).toContain('policy.evaluated');
    });

    test('the stored instant is the one PASSED IN, not the write time (G3)', async () => {
      await initializeCompanyPolicy(product, ids());
      await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      const row = await sql<{ evaluated_at: Date }>`select evaluated_at from policy_evaluations where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);
      expect(new Date(row.rows[0]!.evaluated_at).toISOString()).toBe(AT.toISOString());
    });

    test('a DENY emits policy.blocked as well as policy.evaluated', async () => {
      await initializeCompanyPolicy(product, ids());
      // Add a deny rule as the owner (editing rules is P6-010's product surface, not this ticket's).
      await sql`update policies set rules = rules || '[{"id":"stop","dimension":"emergency_stop","condition":"flag_is_set","decision":"deny","escalate":true}]'::jsonb where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' }, emergency_stop: { value: true, provenance: 'structured' } });
      expect(r).toMatchObject({ status: 'decided', decision: 'deny', escalate: true });
      const names = await auditNames();
      expect(names).toContain('policy.evaluated');
      expect(names).toContain('policy.blocked');
    });

    test('an ALLOW does not emit policy.blocked', async () => {
      await initializeCompanyPolicy(product, ids());
      await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      expect(await auditNames()).not.toContain('policy.blocked');
    });

    test('AUDIT-OR-NOTHING: a failing audit write leaves NO evaluation row', async () => {
      await initializeCompanyPolicy(product, ids());
      const failing = () => Promise.reject(new Error('audit unavailable'));
      await expect(
        evaluateCompanyPolicy(product, { ...ids(), evaluationPoint: 'pre_execution', observations: { risk_class: { value: 'informational', provenance: 'registry' } }, evaluatedAt: AT }, { auditWriter: failing }),
      ).rejects.toThrow();
      expect(await evaluationCount()).toBe(0);
    });
  });

  // ── authorization ────────────────────────────────────────────────────────────────────────────────────────
  describe('authorization', () => {
    test('a VIEWER cannot initialize a policy — policy:manage is owner-only (G17)', async () => {
      const r = await initializeCompanyPolicy(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 });
      expect(r.status).toBe('forbidden');
    });

    test('a viewer cannot drive an evaluation either — `run:execute` is owner-only', async () => {
      // Checked rather than assumed: the first draft of this test asserted a viewer COULD evaluate, on the reasoning
      // that evaluation is a read-ish operation on the execution path. It is not — `run:execute` is owner-only
      // (a worker acts through the system path, not as a viewer), and the suite caught the wrong assumption.
      await initializeCompanyPolicy(product, ids());
      const r = await evaluateCompanyPolicy(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, evaluationPoint: 'proposed', observations: { risk_class: { value: 'informational', provenance: 'registry' } }, evaluatedAt: AT });
      expect(r.status).toBe('forbidden');
      // …and a forbidden evaluation is still a DENY at the gate, never a waivable unavailability.
      expect(toPolicyGateAnswer(r)).toEqual({ kind: 'deny' });
    });

    test('a forbidden result still maps to DENY, never to a waivable gate', () => {
      expect(toPolicyGateAnswer({ status: 'forbidden' })).toEqual({ kind: 'deny' });
    });

    test('another company\'s policy is invisible — evaluating B1 from A finds no policy', async () => {
      await initializeCompanyPolicy(product, ids());
      const r = await evaluateCompanyPolicy(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2, evaluationPoint: 'proposed', observations: {}, evaluatedAt: AT });
      expect(r).toMatchObject({ status: 'no_usable_policy', reason: 'no_active_policy' });
    });
  });
});
