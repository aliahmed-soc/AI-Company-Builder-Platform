// @acbp/database — approval requests and append-only decisions (ACBP-P6-003c; CDR-068; APPR-002/003/007; ADR-009).
//
// Kysely parameterized queries only. This layer stores and reads; it never DECIDES. The five decision paths and the
// actor-type restriction are `parseApprovalDecision` in @acbp/contracts, and keeping the two apart is what lets the
// decision logic be a pure function with the database as an independent second line.
import type { Kysely } from 'kysely';
import type { DatabaseSchema, ApprovalRequestRow, ApprovalDecisionRow } from './schema.js';

export type ApprovalExecutor = Kysely<DatabaseSchema>;

export interface NewApprovalRequestInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly toolId: string;
  readonly toolVersion: number;
  readonly action: string;
  readonly reason: string;
  readonly expectedResult: string;
  /** Already validated by `buildApprovalRequest`; stored as jsonb. */
  readonly data: unknown;
  readonly estimatedCostCredits: number;
  readonly riskClass: string;
  /** DERIVED from `riskClass` by the contract, and CHECKed against it by 0047 — never independently supplied. */
  readonly reversibility: string;
  readonly preview: string;
  readonly scope: string;
  /** Evaluation point 2's record: the policy version the human will decide under (canon §5 point 2). */
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyEvalId?: string | null;
}

export interface NewApprovalDecisionInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly requestId: string;
  readonly path: string;
  /** `human` or `delegated` ONLY. Enforced by the type, by the parser, and by a CHECK (invariant 5). */
  readonly deciderType: string;
  readonly decidedByUserId: string;
  /** The instant PASSED IN, not the write time — that is `created_at`. */
  readonly decidedAt: Date;
  readonly reason?: string | null;
  readonly editedData?: unknown;
  readonly effectiveFrom?: Date | null;
  readonly memberRequestIds?: readonly string[] | null;
}

export class ApprovalRepository {
  readonly #db: ApprovalExecutor;
  constructor(db: ApprovalExecutor) {
    this.#db = db;
  }

  /** Insert a request. Content columns have no UPDATE grant, so what is written here is what a human will read. */
  async insertRequest(input: NewApprovalRequestInput): Promise<ApprovalRequestRow> {
    return this.#db
      .insertInto('approval_requests')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        run_id: input.runId,
        tool_id: input.toolId,
        tool_version: input.toolVersion,
        action: input.action,
        reason: input.reason,
        expected_result: input.expectedResult,
        data: JSON.stringify(input.data),
        estimated_cost_credits: input.estimatedCostCredits,
        risk_class: input.riskClass,
        reversibility: input.reversibility,
        preview: input.preview,
        scope: input.scope,
        policy_id: input.policyId,
        policy_version: input.policyVersion,
        policy_eval_id: input.policyEvalId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findRequest(requestId: string): Promise<ApprovalRequestRow | undefined> {
    return this.#db.selectFrom('approval_requests').selectAll().where('id', '=', requestId).executeTakeFirst();
  }

  /**
   * The INBOX (APPR-003): pending requests, newest first, RLS-confined to the caller's company.
   *
   * Pending only, matching the partial index. A decided request belongs to history, and mixing the two would make
   * "what needs me?" a question the reader has to filter for themselves.
   */
  listPending(companyId: string, limit: number): Promise<ApprovalRequestRow[]> {
    return this.#db
      .selectFrom('approval_requests')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
  }

  /**
   * Insert a decision. UNIQUE(request_id) means a second decision on the same request raises 23505 rather than
   * producing two contradictory authorizations — so a double-submit is refused by the database, not by a race-prone
   * read-then-write in application code.
   */
  async insertDecision(input: NewApprovalDecisionInput): Promise<ApprovalDecisionRow> {
    return this.#db
      .insertInto('approval_decisions')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        request_id: input.requestId,
        path: input.path,
        decider_type: input.deciderType,
        decided_by_user_id: input.decidedByUserId,
        decided_at: input.decidedAt,
        reason: input.reason ?? null,
        edited_data: input.editedData === undefined || input.editedData === null ? null : JSON.stringify(input.editedData),
        effective_from: input.effectiveFrom ?? null,
        member_request_ids: input.memberRequestIds === undefined || input.memberRequestIds === null ? null : JSON.stringify([...input.memberRequestIds]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findDecisionForRequest(requestId: string): Promise<ApprovalDecisionRow | undefined> {
    return this.#db.selectFrom('approval_decisions').selectAll().where('request_id', '=', requestId).executeTakeFirst();
  }

  /**
   * THE DISPATCHER'S READ (CDR-068 §0.1). The decision on the most recent DECIDED request for this run and tool.
   *
   * This is what replaces the caller-injectable `gates.approval`: the gate now asks the store what a human actually
   * decided instead of asking the caller what to believe. Scoped to `(company, run, tool)` because that is the
   * granularity an approval is raised at in this ticket.
   *
   * IT IS NOT A CONSUMPTION. Single-use consumption, payload-hash verification, expiry and revocation are ADR-009 §2
   * and ACBP-P6-004 — this read tells the gate WHAT WAS DECIDED, not that the decision is bound to the exact bytes
   * about to execute. Keeping those two ideas apart is the whole point of the note in CDR-068 §0.1.
   *
   * `r.status = 'decided'` IS LOAD-BEARING (review pass 2, H2). Without it a decision on a SUPERSEDED request still
   * answered the gate — so an `edit_then_approve`, whose whole meaning is *"not that payload, this one"*, authorized
   * the payload the human had just refused. A superseded request's decision authorizes nothing; the request that
   * superseded it has to be approved on its own merits.
   *
   * ORDERED BY THE SERVER'S CLOCK, not the caller's. `decided_at` is supplied by whoever submitted the decision and
   * validated only as a finite date, so ordering by it let an approval stamped 2030 outrank every later rejection
   * forever, and equal values ordered non-deterministically. `created_at` is `now()` at insert with no UPDATE grant,
   * and `id` breaks the tie inside a single statement — the deterministic last-write-wins CLAUDE.md requires.
   * `decided_at` remains what it always was: the human instant on the record.
   */
  findLatestDecisionForCall(companyId: string, runId: string, toolId: string): Promise<ApprovalDecisionRow | undefined> {
    return this.#db
      .selectFrom('approval_decisions as d')
      .innerJoin('approval_requests as r', (join) => join.onRef('r.id', '=', 'd.request_id').onRef('r.company_id', '=', 'd.company_id'))
      .selectAll('d')
      .where('d.company_id', '=', companyId)
      .where('r.run_id', '=', runId)
      .where('r.tool_id', '=', toolId)
      .where('r.status', '=', 'decided')
      .orderBy('d.created_at', 'desc')
      .orderBy('d.id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Mark a request decided. Only the lifecycle columns are grantable, so this cannot edit content even by mistake.
   *
   * `where status = 'pending'` makes the transition idempotent-safe: a second attempt updates zero rows rather than
   * re-stamping a decided request with a later time.
   */
  async markDecided(requestId: string, decidedAt: Date): Promise<number> {
    const r = await this.#db
      .updateTable('approval_requests')
      .set({ status: 'decided', decided_at: decidedAt })
      .where('id', '=', requestId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  /**
   * Mark a request superseded by a NEW one — `edit_then_approve`'s half of canon §2's material-change rule, where the
   * old approval is *"superseded, never mutated"* (invariant 7).
   */
  async markSuperseded(requestId: string, supersededBy: string, at: Date): Promise<number> {
    const r = await this.#db
      .updateTable('approval_requests')
      .set({ status: 'superseded', superseded_at: at, superseded_by_request_id: supersededBy })
      .where('id', '=', requestId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}
