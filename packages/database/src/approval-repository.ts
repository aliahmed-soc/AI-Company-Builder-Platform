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
  /** THE BINDING (ACBP-P6-004; APPR-004). Set once, at insert — there is no UPDATE grant for either column. */
  readonly payloadHash: string;
  readonly bindingVersion: number;
  /** EXPIRY (APPR-005). Required, with no default anywhere in the stack — ADR-009 §15 is an open owner question. */
  readonly expiresAt: Date;
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
        payload_hash: input.payloadHash,
        binding_version: input.bindingVersion,
        expires_at: input.expiresAt,
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

  /**
   * The DECIDED approval standing against this call, if any — the row `verifyAndConsume` will try to spend.
   *
   * READ-ONLY, AND IT AUTHORIZES NOTHING. Its purpose is to produce an honest REASON (`approvalUsability` turns it
   * into `expired` / `payload_mismatch` / …) and to tell the caller whether there is anything to spend at all. The
   * decision to proceed is made by the conditional UPDATE, which re-checks every condition atomically — so a race
   * between this read and that UPDATE loses the race, it does not slip through it.
   *
   * `status = 'decided'` ONLY, AND THAT NARROWNESS IS LOAD-BEARING (review pass 2, F2). It once also matched
   * `consumed` and `revoked`, to give the gate a precise reason. The cost was a PERMANENT DENIAL OF SERVICE: once
   * an approval was spent, a row stood against that `(run, tool)` forever, the gate read it as an explicit refusal,
   * and every later call was denied — including calls the company's own policy allows outright, which never needed
   * an approval at all. Proven by dispatching an informational tool a third time.
   *
   * A TERMINAL APPROVAL IS ABSENT, NOT REFUSING. That is the honest reading: a spent approval has been used up and
   * a revoked one has been withdrawn, and neither is a human saying "no" to the call being made now. If policy
   * demands an approval, absence refuses it (`approval_required`) — which is single-use enforced. If policy allows
   * the call outright, absence is simply true.
   *
   * Matches the partial index `approval_requests_consumable_idx`, which 0048 built on `status = 'decided'` for
   * exactly this query.
   *
   * Ordered by the server clock, then id. `decided_at` is caller-supplied and must never order anything.
   */
  findConsumableForCall(companyId: string, runId: string, toolId: string): Promise<ApprovalRequestRow | undefined> {
    return this.#db
      .selectFrom('approval_requests')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('run_id', '=', runId)
      .where('tool_id', '=', toolId)
      .where('status', '=', 'decided')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * VERIFY AND CONSUME, ATOMICALLY — ADR-009's *"verify-and-consume atomically at the execution instant"*, and the
   * single most load-bearing statement in the approval system (CDR-069 §1-G5).
   *
   * IT IS ONE STATEMENT, AND THAT IS THE ENTIRE POINT. A read followed by a write would let two dispatches both
   * observe `decided` and both proceed — the double-execution that single-use exists to prevent. Here the row lock
   * taken by the UPDATE serialises every concurrent consumer, so exactly one can move the row out of `decided`.
   *
   * IT NAMES THE REQUEST IT SPENDS (review pass 2, F1 — and CDR-069 §1-G5 specified `where id = $id` all along).
   * Without it the predicate matched `(company, run, tool, …)`, and `UPDATE` has no `LIMIT`: two decided requests
   * for the same action — a reject and an approve, or an ordinary duplicate submission — BOTH matched, both were
   * stamped with the same consuming call, and `approval_requests_consumed_call_uq` raised 23505. That threw out of
   * `dispatchToolCall`, which its own docblock says never happens for a refusal, rolling back the transaction so
   * no `tool_calls` row and no audit event survived the attempt — a TOOL-002 violation on exactly the calls most
   * worth recording, and permanent, because every retry reproduced it.
   *
   * It also makes "the request the gate evaluated is the request that gets spent" TRUE. The dispatcher judges one
   * specific row's binding, expiry and decision; spending a different row would be judging one thing and consuming
   * another. Single-use now rests on this statement, as designed, rather than on a unique index turning a logic
   * error into an exception.
   *
   * EVERY CONDITION IS IN THE PREDICATE, not checked before it:
   *   - `id = $requestId`      — the row the caller evaluated, and only that row.
   *   - `status = 'decided'`   — not pending, not superseded, and NOT ALREADY CONSUMED (single-use).
   *   - `revoked_at is null`   — DEFENCE IN DEPTH, and labelled as such because it cannot fire today (review pass 2,
   *                              F10). `approval_requests_status_consistent` makes `status='decided' AND
   *                              revoked_at IS NOT NULL` unrepresentable, so `status='decided'` alone is what
   *                              actually resolves the revoke-vs-consume race. Kept rather than deleted — unlike
   *                              the hex-shape check this ticket removed — because it guards against a DIFFERENT
   *                              layer being changed: drop that CHECK and this clause is the only thing left. A
   *                              reader must not mistake it for the mechanism, which is why it says so here.
   *   - `expires_at > now`     — strictly greater, so the expiry instant itself does not authorize; clock ambiguity
   *                              resolves to expired (canon §2).
   *   - `payload_hash = ...`   — the binding. A mismatch consumes nothing and authorizes nothing (APPR-004).
   *   - `binding_version = ...`— an approval bound under a ruleset we cannot recompute is not verifiable, so it is
   *                              not usable. This is what makes the pre-binding backfill (version 0) inert.
   * A separate check for any of these would be a separate instant, and the gap between instants is the whole
   * vulnerability class.
   *
   * ZERO ROWS IS THE REFUSAL. There is no boolean to misread and no exception to swallow: either this returns the
   * row it just consumed, or the call is not authorized. The CALLER cannot tell WHY from this alone — that is
   * deliberate, and `approvalUsability` in @acbp/contracts answers the "why" for the audit record without ever
   * being the thing that authorizes.
   *
   * `now` and the expected binding are INPUTS. Reading the clock inside the statement would make "was this valid at
   * time T?" unanswerable from the record, the same discipline the policy and schedule clocks follow.
   */
  async verifyAndConsume(input: {
    /** The row the caller evaluated. Without it the statement can spend more than one approval — see above. */
    readonly requestId: string;
    readonly companyId: string;
    readonly runId: string;
    readonly toolId: string;
    readonly payloadHash: string;
    readonly bindingVersion: number;
    readonly callId: string;
    readonly now: Date;
  }): Promise<ApprovalRequestRow | undefined> {
    return this.#db
      .updateTable('approval_requests')
      .set({ status: 'consumed', consumed_at: input.now, consumed_by_call_id: input.callId })
      .where('id', '=', input.requestId)
      .where('company_id', '=', input.companyId)
      .where('run_id', '=', input.runId)
      .where('tool_id', '=', input.toolId)
      .where('status', '=', 'decided')
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', input.now)
      .where('payload_hash', '=', input.payloadHash)
      .where('binding_version', '=', input.bindingVersion)
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * REVOKE a decided approval — APPR-006, as a lifecycle transition rather than a sixth decision path (CDR-069 §1-G4).
   *
   * `status = 'decided'` is the whole race resolution. It excludes `consumed`, so a revocation arriving after the
   * approval was spent updates ZERO rows and the caller learns the truth: the action was already authorized and may
   * already have run. Canon §2 permits either "resolve in favour of revocation" or "produce a compensating alert",
   * and only the second is honest once consumption has committed — nothing can un-authorize what already went.
   *
   * It also excludes `pending`: a request nobody has approved has no authorization to withdraw. The answer there is
   * to reject it, which is a decision, and decisions are the other function.
   */
  async revoke(requestId: string, revokedByUserId: string, at: Date): Promise<number> {
    const r = await this.#db
      .updateTable('approval_requests')
      .set({ status: 'revoked', revoked_at: at, revoked_by_user_id: revokedByUserId })
      .where('id', '=', requestId)
      .where('status', '=', 'decided')
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}
