// @acbp/database — tool-call repository (ACBP-P5-003b; CDR-054; TOOL-002).
//
// The 100%-coverage store behind the enforcement chokepoint. Two things here are load-bearing:
//
//   1. A REFUSED call is inserted just like an authorized one. TOOL-001's failure clause is "Unknown tools cannot be
//      invoked; attempts are audited", and an attempt with no row is not audited.
//   2. `complete` is GUARDED on `requested`, so a call that has already reported an outcome cannot be re-reported —
//      an external effect could otherwise be upgraded from `unconfirmed` to `succeeded` after the fact.
//
// Kysely parameterized queries only. The app role holds SELECT + INSERT + a column-scoped UPDATE of the outcome
// columns; nothing here writes tenancy, run linkage, tool id, class or digest after insert, and the grant would refuse.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, ToolCallRow } from './schema.js';

export type ToolCallExecutor = Kysely<DatabaseSchema>;

export interface NewToolCallInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly toolId: string;
  /** The registry version in force, or null when the tool was not registered. */
  readonly toolVersion?: number | null;
  /** The class the gate ACTUALLY applied, already resolved. Never re-read from the registry afterwards. */
  readonly riskClass: string;
  readonly externalEffect: boolean;
  /**
   * The policy evaluation that decided this call (ACBP-P6-002; CDR-067 §2-G3).
   *
   * NULL when there was no usable policy to evaluate: the call is still recorded, as a denial (CDR-066 §6-G16).
   * Set at INSERT only - there is no update path, because which decision allowed a call is fixed the moment the
   * call is recorded.
   */
  readonly policyEvalId?: string | null;
  readonly outcome: string;
  readonly denialReason?: string | null;
  /** sha256 hex. Never the arguments. */
  readonly argumentsDigest: string;
  readonly idempotencyKey?: string | null;
}

export interface CompleteToolCallInput {
  readonly callId: string;
  readonly outcome: string;
  readonly receiptRef?: string | null;
}

export class ToolCallRepository {
  readonly #db: ToolCallExecutor;
  constructor(db: ToolCallExecutor) {
    this.#db = db;
  }

  /**
   * Record a call. `undefined` means the idempotency key was already used in this company — a DUPLICATE, which
   * NFR-006 says to suppress rather than execute twice.
   *
   * The `ON CONFLICT` arbiter RESTATES the partial index's predicate. PostgreSQL will not infer a partial unique
   * index from a bare column list (42P10) — the same trap P5-001a hit on the jobs table.
   */
  insert(input: NewToolCallInput): Promise<ToolCallRow | undefined> {
    return this.#db
      .insertInto('tool_calls')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        run_id: input.runId,
        tool_id: input.toolId,
        tool_version: input.toolVersion ?? null,
        risk_class: input.riskClass,
        external_effect: input.externalEffect,
        outcome: input.outcome,
        denial_reason: input.denialReason ?? null,
        arguments_digest: input.argumentsDigest,
        policy_eval_id: input.policyEvalId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
      })
      .onConflict((oc) => oc.columns(['company_id', 'tool_id', 'idempotency_key']).where('idempotency_key', 'is not', null).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** The call that already claimed this key, when one did. RLS-confined, so it can only ever be this company's. */
  findByIdempotencyKey(toolId: string, idempotencyKey: string): Promise<ToolCallRow | undefined> {
    return this.#db
      .selectFrom('tool_calls')
      .selectAll()
      .where('tool_id', '=', toolId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  /**
   * Report the outcome of a call that was authorized. GUARDED on `requested`: a call that already reported cannot
   * report again, which is what stops an `unconfirmed` external effect from being quietly upgraded to `succeeded`.
   *
   * `undefined` means the guard did not match — never treat it as success.
   */
  complete(input: CompleteToolCallInput): Promise<ToolCallRow | undefined> {
    let q = this.#db
      .updateTable('tool_calls')
      .set({ outcome: input.outcome, updated_at: sql<Date>`now()` })
      .where('id', '=', input.callId)
      .where('outcome', '=', 'requested');
    if (input.receiptRef !== undefined) q = q.set({ receipt_ref: input.receiptRef });
    return q.returningAll().executeTakeFirst();
  }

  findById(callId: string): Promise<ToolCallRow | undefined> {
    return this.#db.selectFrom('tool_calls').selectAll().where('id', '=', callId).executeTakeFirst();
  }

  /** A run's calls, newest first. RLS confines this to the caller's company. */
  listForRun(runId: string): Promise<ToolCallRow[]> {
    return this.#db.selectFrom('tool_calls').selectAll().where('run_id', '=', runId).orderBy('created_at', 'desc').execute();
  }
}
