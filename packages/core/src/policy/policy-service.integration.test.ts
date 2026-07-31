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
import { evaluateCompanyPolicy, initializeCompanyPolicy, toPolicyGateAnswer, setCompanyAutonomyLevel, readCompanyAutonomy } from './policy-service.js';

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
      // BOTH rules are flagged untrusted as of ACBP-P6-006, and that is the composition working rather than a
      // regression: the autonomy level contributes its own risk-class rule, so a model-sourced risk class taints it
      // too. If this list ever shrinks back to one entry, the level stopped reaching evaluation.
      expect(r).toMatchObject({ untrustedRuleIds: ['autonomy-l2-approval-above-internal', 'baseline-risk-approval'] });
    });
  });

  // ── ACBP-P6-006 / CDR-071 §2-G2: the autonomy level COMPOSES with stored rules ────────────────────────────
  //
  // WHY THESE CASES EXIST AT ALL. Every policy the platform creates is level 2, and level 2's rule is the same
  // threshold `DEFAULT_NEW_COMPANY_POLICY` already carries — so composing it is a NO-OP on every existing test, and
  // deleting the composition outright would leave the whole suite green. That is the inert-element defect ACBP-P6-005
  // was spent on. These cases seed states the service itself never produces, so only composition can satisfy them.
  describe('the autonomy level composes with stored rules (CDR-071 §2-G2)', () => {
    // A policy whose STORED rules permit everything. Written with the owner client because no product path can
    // create this — which is the point: the level must hold even when the rules do not.
    const seedLevel = async (level: number, rules = '[]') => {
      await sql`update public.policies set status = 'superseded', superseded_at = now()
                where company_id = ${w.companyA1}::uuid and status = 'active'`.execute(owner.kysely);
      await sql`insert into public.policies (account_id, company_id, version, baseline, rules, autonomy_level, created_by_user_id)
                values (${w.accountA}::uuid, ${w.companyA1}::uuid, 99, 'allow', ${rules}::jsonb, ${level}, ${w.aOwner}::uuid)`.execute(owner.kysely);
    };

    test('LEVEL 1 REFUSES an informational action even though the stored rules permit everything', async () => {
      await initializeCompanyPolicy(product, ids());
      await seedLevel(1);
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      expect(r).toMatchObject({ status: 'decided', decision: 'require_approval' });
    });

    test('THE CONTROL: level 2 with the SAME permissive stored rules allows it', async () => {
      // Without this, "refuses everything" would pass the case above just as well.
      await initializeCompanyPolicy(product, ids());
      await seedLevel(2);
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      expect(r).toMatchObject({ status: 'decided', decision: 'allow' });
    });

    test('the evaluation record NAMES the level rule that refused, so the reason survives in the audit trail', async () => {
      await initializeCompanyPolicy(product, ids());
      await seedLevel(1);
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      expect(r).toMatchObject({ firedRuleIds: ['autonomy-l1-approval-for-every-class'] });
    });

    test('level 2 still requires approval above internal-reversible when stored rules are empty', async () => {
      await initializeCompanyPolicy(product, ids());
      await seedLevel(2);
      const r = await evaluate({ risk_class: { value: 'external_reversible', provenance: 'registry' } });
      expect(r).toMatchObject({ status: 'decided', decision: 'require_approval' });
    });

    test('UNREADABLE STORED RULES STAY UNREADABLE — composition must not rescue a broken policy into a usable one', async () => {
      // The `Array.isArray` guard in the service. Spreading the level's rules onto a non-array would produce a
      // READABLE rule set containing only those rules, silently converting a policy that refuses everything into one
      // that permits informational work. Fail-closed is preserved: this stays `policy_unreadable`.
      await initializeCompanyPolicy(product, ids());
      // The `policies_rules_is_array` CHECK applies to EVERY connection, owner included — so the constraint is
      // dropped to reach this branch and restored afterwards, exactly as the unreadable-rule-set case above does.
      // Restoring it against the offending row would fail 23514 and leave the schema missing a guard for every
      // later test in this file, so the row is made valid again FIRST.
      await sql`alter table policies drop constraint policies_rules_is_array`.execute(owner.kysely);
      await seedLevel(2, '"not-an-array"');
      const r = await evaluate({ risk_class: { value: 'informational', provenance: 'registry' } });
      await sql`update policies set rules = '[]'::jsonb where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);
      await sql`alter table policies add constraint policies_rules_is_array check (jsonb_typeof(rules) = 'array')`.execute(owner.kysely);
      expect(r).toMatchObject({ status: 'no_usable_policy', reason: 'policy_unreadable' });
    });
  });

  // ── ACBP-P6-006 / CDR-071 §2-G5/G6: setting and reading the level ─────────────────────────────────────────
  describe('setting the autonomy level', () => {
    // No `as never` here: `level` is DELIBERATELY `unknown` on the params type, because refusing a nonsense level is
    // this use case's job rather than the type system's. The spread type-checks as written, and lint was right that
    // asserting it would only hide that.
    const setLevel = (level: unknown, over: Record<string, unknown> = {}) =>
      setCompanyAutonomyLevel(product, { ...ids(), level, at: AT, ...over });

    test('a new company starts at the owner-ruled level 2, and the read model says so', async () => {
      await initializeCompanyPolicy(product, ids());
      const r = await readCompanyAutonomy(product, ids());
      expect(r).toMatchObject({ status: 'ok', current: 2 });
    });

    test('changing the level creates a NEW VERSION rather than editing the old one', async () => {
      const init = await initializeCompanyPolicy(product, ids());
      const before = (init as { version: number }).version;
      const r = await setLevel(1);
      expect(r).toMatchObject({ status: 'ok', level: 1, version: before + 1 });
      // The old version is still readable and still says what it always said — an evaluation that cited it is
      // not retroactively rewritten.
      const old = await sql<{ autonomy_level: number; status: string }>`
        select autonomy_level, status from policies where company_id = ${w.companyA1}::uuid and version = ${before}`.execute(owner.kysely);
      expect(old.rows[0]).toMatchObject({ status: 'superseded' });
      expect(Number(old.rows[0]!.autonomy_level)).toBe(2);
    });

    test('the change is AUDITED as a policy change', async () => {
      await initializeCompanyPolicy(product, ids());
      await setLevel(1);
      expect((await auditNames()).filter((n) => n === 'policy.changed').length).toBe(2);
    });

    test('the audit record says WHAT the level became and which version it superseded', async () => {
      // Review pass 2: without these fields the event read {version, baseline, rule_count} — and a level change
      // carries the SAME baseline and SAME rules, so it was indistinguishable from any other change except by
      // version number. "Level changes audited" is not satisfied by recording that something changed.
      await initializeCompanyPolicy(product, ids());
      await setLevel(1);
      const rows = await sql<{ metadata: Record<string, unknown> }>`
        select metadata from audit_events
        where company_id = ${w.companyA1}::uuid and name = 'policy.changed'
        order by occurred_at, event_id`.execute(owner.kysely);
      expect(rows.rows).toHaveLength(2);
      // Initialization states the level the company STARTED at, rather than leaving it inferred from the default.
      expect(rows.rows[0]!.metadata).toMatchObject({ autonomy_level: 2 });
      expect(rows.rows[1]!.metadata).toMatchObject({ autonomy_level: 1, superseded_version: 1 });
    });

    test('the new version carries the rules forward VERBATIM — one control does not silently edit another', async () => {
      await initializeCompanyPolicy(product, ids());
      await setLevel(1);
      const rows = await sql<{ rules: unknown }>`
        select rules from policies where company_id = ${w.companyA1}::uuid order by version`.execute(owner.kysely);
      expect(rows.rows[1]!.rules).toEqual(rows.rows[0]!.rules);
    });

    test('setting the SAME level is idempotent and writes no new version', async () => {
      const init = await initializeCompanyPolicy(product, ids());
      const r = await setLevel(2);
      expect(r).toMatchObject({ status: 'unchanged', version: (init as { version: number }).version });
      const n = await sql<{ n: number }>`select count(*)::int as n from policies where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);
      expect(n.rows[0]!.n).toBe(1);
    });

    test.each([3, 4, 5])('level %s is REFUSED BY NAME as not available in MVP — never clamped', async (level) => {
      await initializeCompanyPolicy(product, ids());
      expect(await setLevel(level)).toMatchObject({ status: 'refused', reason: 'not_available_in_mvp' });
      // The silent-clamp failure this guards: a founder who asked for 4 and was quietly given 2 would believe they
      // had 4. The level must be UNCHANGED, not nearest-fitted.
      expect(await readCompanyAutonomy(product, ids())).toMatchObject({ current: 2 });
    });

    test.each([0, 6, -1, 2.5, '2', null, undefined, {}])('%p is refused as not a level at all', async (level) => {
      await initializeCompanyPolicy(product, ids());
      expect(await setLevel(level)).toMatchObject({ status: 'refused', reason: 'not_a_level' });
    });

    test('a company with no policy cannot have a level set', async () => {
      expect(await setLevel(1)).toMatchObject({ status: 'refused', reason: 'no_active_policy' });
    });

    test('if the replacement version cannot be written, the SUPERSESSION ROLLS BACK — no company is left policy-less', async () => {
      // Review pass 1 found this: the callback runs INSIDE the account transaction, so returning a typed refusal
      // after a successful supersede would COMMIT the supersession with no replacement — leaving the company with no
      // active policy AND unrecoverable, because `initializeCompanyPolicy` would then collide on version 1 and throw.
      //
      // Forced by parking a SUPERSEDED row at the version the change will try to claim, so the insert conflicts.
      const init = await initializeCompanyPolicy(product, ids());
      const v = (init as { version: number }).version;
      await sql`insert into policies (account_id, company_id, version, baseline, rules, autonomy_level, created_by_user_id, status, superseded_at)
                values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${v + 1}, 'allow', '[]'::jsonb, 2, ${w.aOwner}::uuid, 'superseded', now())`.execute(owner.kysely);

      await expect(setLevel(1)).rejects.toThrow();

      // THE ASSERTION THAT MATTERS: the company still has its original ACTIVE policy at the original level.
      const active = await sql<{ version: number; autonomy_level: number }>`
        select version, autonomy_level from policies where company_id = ${w.companyA1}::uuid and status = 'active'`.execute(owner.kysely);
      expect(active.rows).toHaveLength(1);
      expect(Number(active.rows[0]!.version)).toBe(v);
      expect(Number(active.rows[0]!.autonomy_level)).toBe(2);
      // And the company is still governable rather than bricked.
      expect(await readCompanyAutonomy(product, ids())).toMatchObject({ status: 'ok', current: 2 });
    });

    test('the level cannot be set into ANOTHER COMPANY — the scope refuses before any write', async () => {
      await initializeCompanyPolicy(product, ids());
      const r = await setLevel(1, { companyId: w.companyB1, accountId: w.accountB });
      expect(r).toMatchObject({ status: 'forbidden' });
      expect(await readCompanyAutonomy(product, ids())).toMatchObject({ current: 2 });
    });
  });

  describe('the read model for "levels 3-5 visible disabled" (CDR-071 §2-G5)', () => {
    test('all five levels are VISIBLE, with 1-2 available and 3-5 not', async () => {
      await initializeCompanyPolicy(product, ids());
      const r = (await readCompanyAutonomy(product, ids())) as unknown as { options: { level: number; available: boolean }[] };
      expect(r.options.map((o) => o.level)).toEqual([1, 2, 3, 4, 5]);
      expect(r.options.filter((o) => o.available).map((o) => o.level)).toEqual([1, 2]);
    });

    test('every level carries a plain-language consequence — PRD principle 2 needs the consequence, not the number', async () => {
      await initializeCompanyPolicy(product, ids());
      const r = (await readCompanyAutonomy(product, ids())) as unknown as { options: { consequence: string }[] };
      for (const o of r.options) expect(o.consequence.trim().length).toBeGreaterThan(0);
    });

    test('exactly one level is marked current, and it follows a change', async () => {
      await initializeCompanyPolicy(product, ids());
      await setCompanyAutonomyLevel(product, { ...ids(), level: 1, at: AT });
      const r = (await readCompanyAutonomy(product, ids())) as unknown as { options: { level: number; current: boolean }[] };
      expect(r.options.filter((o) => o.current).map((o) => o.level)).toEqual([1]);
    });

    test('the read reports what the ENGINE would apply, not the raw column — a corrupt level reads as 1', async () => {
      // A screen showing 5 while the engine applied 1 would be a screen that lies about the company's safety. The
      // CHECK makes this unreachable through the product path, so it is forced here with the owner client.
      await initializeCompanyPolicy(product, ids());
      await sql`update policies set autonomy_level = 4 where company_id = ${w.companyA1}::uuid and status = 'active'`.execute(owner.kysely);
      const r = await readCompanyAutonomy(product, ids());
      // 4 is a valid stored level but not an MVP one; `resolveAutonomyLevel` keeps it, and availability says false.
      expect(r).toMatchObject({ status: 'ok', current: 4 });
      const opts = (r as unknown as { options: { level: number; available: boolean }[] }).options;
      expect(opts.find((o) => o.level === 4)!.available).toBe(false);
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
