// ACBP-P6-001b / CDR-066 §5 — policy storage and append-only evaluation records against a REAL database.
//
// The acceptance clause is ***"forbidden beats approval"*** (POL-005), and §5-G14 says it must be proven through the
// STORED representation rather than only in the pure layer: a rule set that lost its deny rule in jsonb
// round-tripping, or an evaluation row that recorded the wrong winner, would pass every unit test in
// @acbp/contracts and still let a forbidden action through.
//
// Everything else here is the posture canon fixes for these two tables — versioned + permanent + one active for
// `policies`, absolutely append-only for `policy_evaluations` — asserted against the restricted `acbp_app` role,
// because a guarantee tested as superuser is a guarantee about nobody.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { POLICY_DECISIONS, evaluatePolicy, type PolicyRuleSet } from '@acbp/contracts';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, PolicyRepository, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `pol_${'test'}_pw_1970`;

const ALL = ['policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'credit_transactions', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

/** A policy with BOTH a deny rule and a require_approval rule — the shape the acceptance clause is about. */
const FORBIDDEN_AND_APPROVAL_RULES = [
  { id: 'approve-external', dimension: 'risk_class', condition: 'risk_at_least', operand: 'external_reversible', decision: 'require_approval' },
  { id: 'forbid-stopped', dimension: 'emergency_stop', condition: 'flag_is_set', decision: 'deny', escalate: true },
];

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-pol-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-pol-test' }));
}

describe.skipIf(!hasTestDatabase)('policies + policy_evaluations (real PostgreSQL, restricted role) — ACBP-P6-001b/CDR-066', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyA2 = '';
  let companyB1 = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  /**
   * EACH refusal gets its OWN transaction, and the SQLSTATE is read by walking the cause chain.
   *
   * Both halves are paid-for lessons: the first `42501` aborts the transaction so every later statement in it returns
   * `25P02` (which would make a batch of refusals prove one thing), and the driver nests the real code under `cause`
   * so a shallow `.code` check silently matches nothing.
   */
  const sqlStateOf = (p: Promise<unknown>): Promise<string> =>
    p.then(() => 'no-error').catch((e: unknown) => {
      for (let cur: unknown = e, hops = 0; cur !== null && cur !== undefined && hops < 5; hops += 1) {
        const node = cur as { code?: unknown; cause?: unknown };
        if (typeof node.code === 'string' && /^[0-9A-Z]{5}$/.test(node.code)) return node.code;
        cur = node.cause;
      }
      return /sqlstate=([0-9A-Z]{5})/.exec(String(e))?.[1] ?? 'unknown';
    });

  const repoFor = (a: string, c: string) => <T,>(fn: (repo: PolicyRepository) => Promise<T>): Promise<T> => asApp(scope(a, c), (k) => fn(new PolicyRepository(k)));

  const seedPolicy = (company: string, version = 1, rules: unknown = FORBIDDEN_AND_APPROVAL_RULES, baseline = 'allow', account = accountA) =>
    repoFor(account, company)((repo) => repo.insert({ accountId: account, companyId: company, version, baseline, rules, createdByUserId: userU }));

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    expect((await migrateToLatest(su)).error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    userU = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_pol', 'user_pol_u', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    const userV = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_pol', 'user_pol_v', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyA2 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ALL) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    await sql`truncate table policy_evaluations, policies restart identity cascade`.execute(su.kysely);
  });

  // ── the acceptance clause ────────────────────────────────────────────────────────────────────────────────
  describe('forbidden beats approval, through the STORED policy (G14)', () => {
    test('a stored policy carrying both rules evaluates to DENY when both fire', async () => {
      expect(await seedPolicy(companyA1)).toBeDefined();

      // The rule set is read BACK OUT of PostgreSQL and evaluated — not the literal above. If jsonb round-tripping
      // dropped or reshaped the deny rule, this is where it shows.
      const stored = await repoFor(accountA, companyA1)((repo) => repo.findActive(companyA1));
      expect(stored).toBeDefined();
      const ruleSet = { version: stored!.version, baseline: stored!.baseline, rules: stored!.rules } as unknown as PolicyRuleSet;

      const evaluation = evaluatePolicy(ruleSet, {
        risk_class: { value: 'external_reversible', provenance: 'registry' },
        emergency_stop: { value: true, provenance: 'structured' },
      });
      expect(evaluation.decision).toBe('deny');
      expect(evaluation.escalate).toBe(true);
      expect([...evaluation.firedRuleIds].sort()).toEqual(['approve-external', 'forbid-stopped']);
      expect(evaluation.unevaluableRuleIds).toEqual([]);

      // …and the RECORD agrees. An evaluation row disagreeing with the decision would be an audit trail asserting
      // something that never happened.
      const recorded = await repoFor(accountA, companyA1)((repo) =>
        repo.recordEvaluation({
          accountId: accountA,
          companyId: companyA1,
          policyId: stored!.id,
          policyVersion: stored!.version,
          evaluationPoint: 'pre_execution',
          decision: evaluation.decision,
          escalate: evaluation.escalate,
          firedRuleIds: evaluation.firedRuleIds,
          unevaluableRuleIds: evaluation.unevaluableRuleIds,
          untrustedRuleIds: evaluation.untrustedRuleIds,
          evaluatedAt: new Date('2026-07-29T12:00:00.000Z'),
        }),
      );
      expect(recorded.decision).toBe('deny');
      expect(recorded.escalate).toBe(true);
      expect(recorded.policy_version).toBe(stored!.version);
    });

    test('WITHOUT the deny rule the same facts yield require_approval — so the deny was doing real work', async () => {
      // Without this, the test above would pass on a policy that denied for ANY reason, including a bug that always
      // denies. Pinning the without-deny case is what makes the with-deny case evidence.
      expect(await seedPolicy(companyA1, 1, [FORBIDDEN_AND_APPROVAL_RULES[0]])).toBeDefined();
      const stored = await repoFor(accountA, companyA1)((repo) => repo.findActive(companyA1));
      const ruleSet = { version: stored!.version, baseline: stored!.baseline, rules: stored!.rules } as unknown as PolicyRuleSet;
      const r = evaluatePolicy(ruleSet, {
        risk_class: { value: 'external_reversible', provenance: 'registry' },
        emergency_stop: { value: true, provenance: 'structured' },
      });
      expect(r.decision).toBe('require_approval');
    });
  });

  // ── policies: versioned, permanent, one active ───────────────────────────────────────────────────────────
  describe('policies', () => {
    test('at most ONE active version per company', async () => {
      await seedPolicy(companyA1, 1);
      expect(await sqlStateOf(seedPolicy(companyA1, 2))).toBe('23505');
    });

    test('superseding frees the active slot and the old version SURVIVES', async () => {
      const first = await seedPolicy(companyA1, 1);
      await repoFor(accountA, companyA1)((repo) => repo.supersede(first!.id, new Date()));
      expect(await seedPolicy(companyA1, 2)).toBeDefined();
      const versions = await repoFor(accountA, companyA1)((repo) => repo.listVersions(companyA1, 10));
      expect(versions.map((v) => v.version)).toEqual([2, 1]);
      expect(versions.find((v) => v.version === 1)?.status).toBe('superseded');
    });

    test('a second superseder of the same row gets undefined rather than re-stamping it', async () => {
      const first = await seedPolicy(companyA1, 1);
      expect(await repoFor(accountA, companyA1)((repo) => repo.supersede(first!.id, new Date('2026-07-29T10:00:00.000Z')))).toBeDefined();
      expect(await repoFor(accountA, companyA1)((repo) => repo.supersede(first!.id, new Date('2026-07-29T11:00:00.000Z')))).toBeUndefined();
    });

    test('a version number is never reused', async () => {
      const first = await seedPolicy(companyA1, 1);
      await repoFor(accountA, companyA1)((repo) => repo.supersede(first!.id, new Date()));
      // ON CONFLICT DO NOTHING on `policies_company_version_uq` — refused, not duplicated.
      expect(await seedPolicy(companyA1, 1)).toBeUndefined();
    });

    test('the product role cannot DELETE a version — an evaluation cites it forever', async () => {
      const policy = await seedPolicy(companyA1);
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`delete from public.policies where id = ${policy!.id}::uuid`.execute(k)))).toBe('42501');
    });

    test('the product role cannot edit rules/baseline/version — only status and superseded_at', async () => {
      const policy = await seedPolicy(companyA1);
      for (const statement of ['rules = \'[]\'::jsonb', "baseline = 'deny'", 'version = 99']) {
        const state = await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql.raw(`update public.policies set ${statement} where id = '${policy!.id}'`).execute(k)));
        expect(state).toBe('42501');
      }
    });

    test('CHECKs refuse a malformed baseline or non-array rules', async () => {
      const insert = (baseline: string, rules: string) =>
        sqlStateOf(sql.raw(`insert into public.policies (account_id, company_id, version, baseline, rules, created_by_user_id) values ('${accountA}', '${companyA1}', 9, '${baseline}', '${rules}'::jsonb, '${userU}')`).execute(su.kysely));
      expect(await insert('ALLOW', '[]')).toBe('23514');
      expect(await insert('permit', '[]')).toBe('23514');
      expect(await insert('allow', '{}')).toBe('23514');
      expect(await insert('allow', '"nope"')).toBe('23514');
    });

    test('the CHECK vocabulary accepts exactly POLICY_DECISIONS', async () => {
      // Duplicated on purpose (contracts + migration) and asserted equal here. The ACTIVITY_TYPES divergence is the
      // precedent: contracts widened without a migration and nothing caught it.
      for (const [i, decision] of POLICY_DECISIONS.entries()) {
        const state = await sqlStateOf(
          sql`insert into public.policies (account_id, company_id, version, baseline, rules, created_by_user_id, status, superseded_at)
              values (${accountA}::uuid, ${companyA1}::uuid, ${100 + i}, ${decision}, '[]'::jsonb, ${userU}::uuid, 'superseded', now())`.execute(su.kysely),
        );
        expect(state).toBe('no-error');
      }
    });

    test('status and superseded_at cannot disagree', async () => {
      const active = sqlStateOf(
        sql`insert into public.policies (account_id, company_id, version, baseline, rules, created_by_user_id, status, superseded_at)
            values (${accountA}::uuid, ${companyA1}::uuid, 50, 'allow', '[]'::jsonb, ${userU}::uuid, 'active', now())`.execute(su.kysely),
      );
      expect(await active).toBe('23514');
      const superseded = sqlStateOf(
        sql`insert into public.policies (account_id, company_id, version, baseline, rules, created_by_user_id, status)
            values (${accountA}::uuid, ${companyA1}::uuid, 51, 'allow', '[]'::jsonb, ${userU}::uuid, 'superseded')`.execute(su.kysely),
      );
      expect(await superseded).toBe('23514');
    });
  });

  // ── policy_evaluations: append-only and version-pinned ───────────────────────────────────────────────────
  describe('policy_evaluations', () => {
    const record = (company: string, policyId: string, version: number, over: Record<string, unknown> = {}) =>
      repoFor(accountA, company)((repo) =>
        repo.recordEvaluation({
          accountId: accountA,
          companyId: company,
          policyId,
          policyVersion: version,
          evaluationPoint: 'proposed',
          decision: 'allow',
          escalate: false,
          firedRuleIds: [],
          unevaluableRuleIds: [],
          untrustedRuleIds: [],
          evaluatedAt: new Date('2026-07-29T12:00:00.000Z'),
          ...over,
        }),
      );

    test('a recorded evaluation can be neither updated nor deleted by the product role', async () => {
      const policy = await seedPolicy(companyA1);
      const evaluation = await record(companyA1, policy!.id, 1);
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql.raw(`update public.policy_evaluations set decision = 'deny' where id = '${evaluation.id}'`).execute(k)))).toBe('42501');
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql.raw(`delete from public.policy_evaluations where id = '${evaluation.id}'`).execute(k)))).toBe('42501');
    });

    test('a stated policy_version that is not the policy\'s own is REFUSED by the database', async () => {
      const policy = await seedPolicy(companyA1, 1);
      // The composite FK is what makes the denormalized copy a fact rather than a hope.
      expect(await sqlStateOf(record(companyA1, policy!.id, 2))).toBe('23503');
    });

    test('the evaluating INSTANT is stored, distinctly from the write time', async () => {
      const policy = await seedPolicy(companyA1);
      const evaluated = new Date('2026-01-02T03:04:05.000Z');
      const row = await record(companyA1, policy!.id, 1, { evaluatedAt: evaluated });
      expect(new Date(row.evaluated_at).toISOString()).toBe(evaluated.toISOString());
      expect(new Date(row.created_at).getTime()).toBeGreaterThan(evaluated.getTime());
    });

    test('an escalated NON-denial is refused — escalation is a property of refusing', async () => {
      const policy = await seedPolicy(companyA1);
      expect(await sqlStateOf(record(companyA1, policy!.id, 1, { decision: 'allow', escalate: true }))).toBe('23514');
      expect(await sqlStateOf(record(companyA1, policy!.id, 1, { decision: 'require_approval', escalate: true }))).toBe('23514');
    });

    test('an out-of-set evaluation point or decision is refused', async () => {
      const policy = await seedPolicy(companyA1);
      expect(await sqlStateOf(record(companyA1, policy!.id, 1, { evaluationPoint: 'whenever' }))).toBe('23514');
      expect(await sqlStateOf(record(companyA1, policy!.id, 1, { decision: 'maybe' }))).toBe('23514');
    });

    test('all three evaluation points are accepted', async () => {
      const policy = await seedPolicy(companyA1);
      for (const point of ['proposed', 'approval_requested', 'pre_execution']) {
        expect(await sqlStateOf(record(companyA1, policy!.id, 1, { evaluationPoint: point }))).toBe('no-error');
      }
      expect(await repoFor(accountA, companyA1)((repo) => repo.countEvaluations(companyA1))).toBe(3);
    });
  });

  // ── tenant isolation ─────────────────────────────────────────────────────────────────────────────────────
  describe('tenant isolation', () => {
    test('another company\'s policy reads as ABSENT, not as someone else\'s rules', async () => {
      await seedPolicy(companyA1);
      expect(await repoFor(accountA, companyA2)((repo) => repo.findActive(companyA1))).toBeUndefined();
      expect(await repoFor(accountA, companyA2)((repo) => repo.findActive(companyA2))).toBeUndefined();
    });

    test('a policy cannot be written into another company\'s scope', async () => {
      const state = await sqlStateOf(
        repoFor(accountA, companyA2)((repo) => repo.insert({ accountId: accountA, companyId: companyA1, version: 1, baseline: 'allow', rules: [], createdByUserId: userU })),
      );
      expect(state).toBe('42501');
    });

    test('an evaluation cannot be written into another company\'s scope', async () => {
      const policy = await seedPolicy(companyA1);
      const state = await sqlStateOf(
        repoFor(accountA, companyA2)((repo) =>
          repo.recordEvaluation({
            accountId: accountA,
            companyId: companyA1, // claiming A1 while scoped to A2
            policyId: policy!.id,
            policyVersion: 1,
            evaluationPoint: 'proposed',
            decision: 'allow',
            escalate: false,
            firedRuleIds: [],
            unevaluableRuleIds: [],
            untrustedRuleIds: [],
            evaluatedAt: new Date(),
          }),
        ),
      );
      expect(state).toBe('42501');
    });

    test('a cross-ACCOUNT policy is invisible too', async () => {
      await seedPolicy(companyB1, 1, FORBIDDEN_AND_APPROVAL_RULES, 'allow', accountB);
      expect(await repoFor(accountA, companyA1)((repo) => repo.findActive(companyB1))).toBeUndefined();
    });
  });
});
