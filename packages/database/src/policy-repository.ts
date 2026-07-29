// @acbp/database — policy storage and append-only evaluation records (ACBP-P6-001b; CDR-066 §5; POL-005/006).
//
// Kysely parameterized queries only. This layer stores and reads; it never DECIDES — the decision is
// `evaluatePolicy` in @acbp/contracts, and keeping the two apart is what lets the decision be a pure function.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, PolicyRow, PolicyEvaluationRow } from './schema.js';

export type PolicyExecutor = Kysely<DatabaseSchema>;

export interface NewPolicyInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly version: number;
  readonly baseline: string;
  /** The contract's `PolicyRule[]`, already validated by the caller. */
  readonly rules: unknown;
  readonly createdByUserId: string;
}

export interface NewPolicyEvaluationInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly evaluationPoint: string;
  readonly decision: string;
  readonly escalate: boolean;
  readonly firedRuleIds: readonly string[];
  readonly unevaluableRuleIds: readonly string[];
  readonly untrustedRuleIds: readonly string[];
  /** The instant PASSED TO the evaluator (CDR-066 §3-G3), not the write time. */
  readonly evaluatedAt: Date;
  readonly toolCallId?: string | null;
}

export class PolicyRepository {
  readonly #db: PolicyExecutor;
  constructor(db: PolicyExecutor) {
    this.#db = db;
  }

  /**
   * The company's ACTIVE policy, or `undefined` when it has none.
   *
   * `undefined` IS A REAL ANSWER and callers must treat it as one: P6-001c turns it into a denial, because a company
   * with no active policy has not permitted anything. RLS confines this to the caller's company, so another
   * company's policy reads as absent rather than as someone else's rules.
   */
  findActive(companyId: string): Promise<PolicyRow | undefined> {
    return this.#db.selectFrom('policies').selectAll().where('company_id', '=', companyId).where('status', '=', 'active').executeTakeFirst();
  }

  /** One specific version — what an evaluation record cites. Versions are permanent, so this never 404s on history. */
  findVersion(companyId: string, version: number): Promise<PolicyRow | undefined> {
    return this.#db.selectFrom('policies').selectAll().where('company_id', '=', companyId).where('version', '=', version).executeTakeFirst();
  }

  /** Every version, newest first — the "policy changes audited" view. */
  listVersions(companyId: string, limit: number): Promise<PolicyRow[]> {
    return this.#db.selectFrom('policies').selectAll().where('company_id', '=', companyId).orderBy('version', 'desc').limit(limit).execute();
  }

  /**
   * Insert a new version.
   *
   * `undefined` means the `(company_id, version)` uniqueness refused it — two writers raced for the same version
   * number. Targeted at that ONE constraint rather than a blanket 23505, so a conflict this method did not
   * anticipate is not reported to the caller as an ordinary version collision.
   */
  insert(input: NewPolicyInput): Promise<PolicyRow | undefined> {
    return this.#db
      .insertInto('policies')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        version: input.version,
        baseline: input.baseline,
        rules: JSON.stringify(input.rules),
        created_by_user_id: input.createdByUserId,
      })
      .onConflict((oc) => oc.constraint('policies_company_version_uq').doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Mark a version superseded. The ONLY mutation this table permits, and the only one its grant allows.
   *
   * GUARDED ON `status = 'active'`, so a concurrent superseder gets `undefined` rather than silently re-stamping a
   * row that had already moved on — the coordinator's `expectedState` precedent (CDR-053). The partial unique index
   * on active rows is the second line: even if this guard were removed, two active versions could not both exist.
   */
  supersede(policyId: string, at: Date): Promise<PolicyRow | undefined> {
    return this.#db
      .updateTable('policies')
      .set({ status: 'superseded', superseded_at: at })
      .where('id', '=', policyId)
      .where('status', '=', 'active')
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Record one evaluation. APPEND-ONLY — there is no update and no delete here, because the table grants neither.
   *
   * The composite FK pins `policy_version` to `policy_id`, so a row whose stated version is not the version of the
   * policy it names is refused by PostgreSQL rather than accepted and later disbelieved.
   */
  recordEvaluation(input: NewPolicyEvaluationInput): Promise<PolicyEvaluationRow> {
    return this.#db
      .insertInto('policy_evaluations')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        policy_id: input.policyId,
        policy_version: input.policyVersion,
        evaluation_point: input.evaluationPoint,
        decision: input.decision,
        escalate: input.escalate,
        fired_rule_ids: JSON.stringify(input.firedRuleIds),
        unevaluable_rule_ids: JSON.stringify(input.unevaluableRuleIds),
        untrusted_rule_ids: JSON.stringify(input.untrustedRuleIds),
        evaluated_at: input.evaluatedAt,
        tool_call_id: input.toolCallId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The company's evaluation trail, newest first (POL-006). */
  listEvaluations(companyId: string, limit: number): Promise<PolicyEvaluationRow[]> {
    return this.#db
      .selectFrom('policy_evaluations')
      .selectAll()
      .where('company_id', '=', companyId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  /** How many evaluations a company has recorded — used by tests and by operational counters. */
  async countEvaluations(companyId: string): Promise<number> {
    const row = await this.#db
      .selectFrom('policy_evaluations')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    return row?.n ?? 0;
  }
}
