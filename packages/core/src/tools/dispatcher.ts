// @acbp/core — THE tool dispatcher (ACBP-P5-003b; CDR-054; TOOL-002/003; WORK-005; ADR-012; trust-critical #4/#11).
//
// THIS IS THE ONLY PATH TO A TOOL. `COMPONENT-CATALOG` calls it *"Trusted — the enforcement chokepoint"*, and the
// claim is only true if nothing else can execute a tool: a capability with no dispatcher path does not run at all.
//
// It does NOT execute anything itself. In Phase 5 no tool implementation exists, and even once they do, running the
// call is the worker runtime's job (P5-005). What lives here is the decision, the record, and the refusal — which is
// exactly the part that must not be duplicated anywhere else.
//
// WHY THE RECORD COMES FIRST. TOOL-002 wants 100% of calls recorded, and a row written after execution cannot exist
// for a call that died mid-flight — precisely the call worth having a record of. So an authorized call is inserted
// `requested` before it is handed back, and `reportToolCallOutcome` closes it later.
import { ToolCallRepository, TaskRunRepository, ApprovalRepository, StopRepository, TaskRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type ToolCallRow } from '@acbp/database';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import {
  decideDispatch,
  canonicalizeToolArguments,
  hasUntrustedContext,
  hasExternalEffect,
  detectInjection,
  isToolCallOutcome,
  isToolDenialReason,
  approvalUsability,
  authorizesExecution,
  approvalConsumed,
  toolCallRequested,
  toolCallCompleted,
  evaluateStops,
  type StopAnswer,
  type StopEvaluation,
  type ToolDenialReason,
} from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { evaluatePolicyInScope, toPolicyGateAnswer } from '../policy/policy-service.js';
import { computePayloadBinding } from '../approvals/binding.js';
import type { Logger } from '@acbp/observability';

/**
 * `approvalAnswer` LIVED HERE and is gone (ACBP-P6-004). It mapped a stored DECISION to a gate answer; the gate now
 * asks `approvalUsability` about a stored REQUEST, which knows about the payload binding, the expiry and the
 * revocation as well as the decision. Deleting it rather than keeping it beside the new path is the point: two
 * functions answering "does this approval authorize?" would eventually disagree, and the one that got consulted
 * would be whichever the next reader happened to find.
 *
 * The property it earned the hard way is carried forward verbatim — `unavailable` means EXACTLY ONE THING, that no
 * approval stands against this call. Every other state denies. A not-yet-due schedule once mapped to `unavailable`
 * on the reasoning that "not yet" is not "invalid": true as prose, wrong as a gate answer, because `unavailable`
 * refuses only when policy demanded an approval, so an informational call riding the no-gate waiver executed a
 * human's deliberate deferral immediately.
 */

/**
 * **THERE ARE NO GATE PORTS LEFT.** `policy` died in ACBP-P6-002, `approval` in ACBP-P6-003c (CDR-068 §0.1), and
 * `stop` dies here in ACBP-P6-007 (CDR-072 §1-G1). The dispatcher consults all three stores ITSELF, so a caller can
 * neither supply, override nor omit any of the three answers.
 *
 * `COMPONENT-CATALOG` names this component *"Trusted — the enforcement chokepoint"* and
 * `APPROVAL-AND-POLICY-ARCHITECTURE §5` marks the pre-execution check **never skippable**: a gate a caller may omit
 * will eventually be omitted, and the omission would be invisible, because the default *looks* like a deliberate
 * fail-closed answer.
 *
 * **WHY THE STOP PORT SURVIVED THIS LONG AND DIES NOW.** Its own comment used to justify itself: the engine did not
 * exist, so "no stop CAN be in force" made the `clear` default simply TRUE. That sentence stopped being true the
 * moment migration 0050 and the stop controller landed. With a real engine behind it, a caller passing
 * `stop: () => ({ kind: 'clear' })` would walk straight through a live emergency stop — the identical bypass the
 * approval port was deleted for, on the one control whose entire purpose is to be un-bypassable.
 *
 * `tools/check-stop-port.mjs` fails the build if it comes back, exactly as `check-approval-port.mjs` does for
 * approvals. The interface is kept (rather than removed outright) so both checkers still have a host to inspect —
 * a vanished host is an ERROR in those checks, not a quiet pass.
 */
export interface ToolGates {
  /**
   * Deliberately empty. See above: every gate is read from its store inside `dispatchToolCall`.
   *
   * DO NOT ADD A GATE HERE. If a future engine needs a seam for testing, give it a store the test can write to —
   * a caller-injectable answer to a safety question has been re-introduced and deleted twice already.
   */
  readonly _never?: never;
}

/**
 * Translate the stop engine's answer into the dispatcher's gate vocabulary (CDR-072 §1-G3).
 *
 * THE ONLY INTERESTING LINE IS THE LAST ONE. `unreadable` becomes `unavailable`, never `clear` — canon's principle
 * is that *"no stop is recorded" is a complete answer; "I could not check" is not*, and `decideDispatch` turns
 * `unavailable` into `stop_unavailable` → denied. That single mapping is what makes a corrupt stop row, and a
 * stored stop whose scope this release cannot enforce, both fail CLOSED instead of quietly permitting everything.
 *
 * Exported so the mapping is testable on its own rather than only through a database.
 */
export function toStopGateAnswer(evaluation: StopEvaluation): StopAnswer {
  if (evaluation.kind === 'stopped') return { kind: 'stopped' };
  if (evaluation.kind === 'clear') return { kind: 'clear' };
  return { kind: 'unavailable' };
}

export interface DispatcherOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
  readonly gates?: ToolGates;
  /**
   * The instant handed to the policy engine. CDR-066 §3-G3 keeps the clock an INPUT, never ambient, so a recorded
   * evaluation's timestamp is assertable and a working-hours decision can be re-derived from its own record.
   */
  readonly now?: Date;
}

export interface DispatchToolCallParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** A call BELONGS to a run (CDR-054 §1-G10). */
  readonly runId: string;
  readonly toolId: string;
  /** Digested here and never stored — TOOL-002 records an arguments DIGEST. */
  readonly args: unknown;
  /** The worker's allowlist. `undefined` means none was supplied, which REFUSES (WORK-005, §1-G3). */
  readonly allowlist: readonly string[] | undefined;
  readonly idempotencyKey?: string;
  /**
   * The working-context items this call was proposed alongside (ACBP-P5-003c; NFR-021; invariant 17).
   *
   * The ITEMS are passed, not a boolean: the dispatcher classifies them itself through `hasUntrustedContext`, which
   * treats anything unrecognised as untrusted. A caller-supplied flag would let a mistake upstream read as trusted,
   * and this is the one input where being wrong means untrusted content reached a tool. Nothing here is persisted —
   * only the arguments digest ever is.
   *
   * REQUIRED, not optional (review pass 1). An optional field defaults a FORGOTTEN context to the trusted path, and
   * this is the one input where being wrong means untrusted content reached a tool. A caller with genuinely no
   * context passes `[]` — a decision, rather than an omission that looks identical to one.
   */
  readonly context: readonly unknown[];
}

export interface ToolCallDTO {
  readonly id: string;
  readonly runId: string;
  readonly toolId: string;
  readonly toolVersion: number | null;
  readonly riskClass: string;
  readonly externalEffect: boolean;
  readonly outcome: string;
  readonly denialReason: string | null;
  readonly argumentsDigest: string;
}

function toDTO(row: ToolCallRow): ToolCallDTO {
  return {
    id: row.id,
    runId: row.run_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    riskClass: row.risk_class,
    externalEffect: row.external_effect,
    outcome: row.outcome,
    denialReason: row.denial_reason,
    argumentsDigest: row.arguments_digest,
  };
}

export type DispatchToolCallResult =
  // Cleared to run. The row already exists in `requested`; the caller reports the outcome afterwards.
  | { readonly status: 'authorized'; readonly call: ToolCallDTO }
  // Refused, AND RECORDED — TOOL-001: "attempts are audited". The reason says which gate refused.
  | { readonly status: 'denied'; readonly call: ToolCallDTO; readonly reason: ToolDenialReason }
  // NFR-006: this idempotency key already ran in this company. The first call's record is returned; nothing re-runs.
  | { readonly status: 'duplicate'; readonly call: ToolCallDTO }
  /**
   * The idempotency key already names a call with DIFFERENT arguments (CDR-067 §2-G10). Deliberately carries no
   * `call`: handing back the other call's record is the very confusion this status exists to prevent.
   */
  | { readonly status: 'idempotency_conflict' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'run_not_found' }
  // A run that is not `running` has no execution to attach a tool call to — the P5-002 pass-2 lesson, same shape.
  | { readonly status: 'run_not_running'; readonly runState: string };

/** sha256 of the canonical encoding. The arguments themselves never leave this function. */
export function digestToolArguments(args: unknown): string {
  return createHash('sha256').update(canonicalizeToolArguments(args), 'utf8').digest('hex');
}

/**
 * Propose a tool call. Returns an authorization or a refusal; NEVER throws for a refusal, because WORK-005's failure
 * clause is *"Rejection does not crash the task; it fails that step with reason."*
 */
export async function dispatchToolCall(client: DatabaseClient, params: DispatchToolCallParams, options: DispatcherOptions = {}): Promise<DispatchToolCallResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const argumentsDigest = digestToolArguments(params.args);
  // A BLANK KEY IS NO KEY (review pass 1). Treating '' as a real key would make two unrelated calls that both omitted
  // a meaningful one silently suppress each other - a duplicate answer for something that was never a duplicate.
  const idempotencyKey = (params.idempotencyKey ?? '').trim() === '' ? undefined : params.idempotencyKey;

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<DispatchToolCallResult> => {
      // A tool call happens INSIDE a run's execution, so it needs the capability that executing a run needs. A
      // separate `tool:dispatch` action would be a second, coarser gate duplicating what the allowlist already does
      // per tool — least privilege here is the allowlist's job (WORK-005), not a broader role check's.
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const runs = new TaskRunRepository(scope.db);
      // RLS-confined, so another company's run reads as absent — a foreign run is `run_not_found`, never a call
      // recorded against someone else's execution, and never an existence oracle.
      const taskRun = await runs.findById(params.runId);
      if (taskRun === undefined) return { status: 'run_not_found' };
      if (taskRun.state !== 'running') return { status: 'run_not_running', runState: taskRun.state };

      const untrusted = hasUntrustedContext(params.context);
      // Run the detector on the LIVE path, not only in tests (review pass 1). It never decides anything - provenance
      // already closed the gate - but a refusal that says WHICH signals the content matched is the difference between
      // a log line and something a human can act on, which is NFR-021's second half ('quarantines and flags').
      const signals = untrusted ? injectionSignalsIn(params.context) : '';
      const calls = new ToolCallRepository(scope.db);

      // Idempotency is checked BEFORE the gates. A duplicate is not a new call to authorize — re-running the gates
      // could even produce a different answer for a call that already happened, which would be a second, contradictory
      // record of one event (NFR-006; FAILURE-AND-RECOVERY row 11).
      //
      // THAT REASONING HOLDS ONLY FOR A CALL THAT ACTUALLY HAPPENED (CDR-067 §2-G10). The loosening's independent
      // review named this the one place the chokepoint is not a chokepoint, because this return precedes the policy
      // evaluation. Two cases are not duplicates at all, and both are handled before the short circuit:
      if (idempotencyKey !== undefined) {
        const prior = await calls.findByIdempotencyKey(params.toolId, idempotencyKey);
        if (prior !== undefined) {
          // 1. THE KEY NAMES DIFFERENT ARGUMENTS. Returning the prior record here would answer a request whose
          //    arguments were never gated and never recorded, with someone else's authorization and someone else's
          //    digest. A key identifies one call; two argument sets are two calls, and this one has no record.
          //    (`run_id` is deliberately NOT compared: reusing a key on a later attempt of the same work is exactly
          //    what a retry after a resume looks like, and refusing that would break the feature.)
          if (prior.arguments_digest !== argumentsDigest) return { status: 'idempotency_conflict' };
          // 2. THE PRIOR CALL WAS DENIED, so it never ran and there is nothing to be idempotent about. `duplicate`
          //    means "already ran in this company"; reporting a refusal that way invites a caller written as
          //    `if (denied) abort; else proceed;` to treat a laundered denial as permission. The refusal is reported
          //    from the existing record, so one attempt still leaves exactly one record.
          if (prior.outcome === 'denied') {
            // Total over the stored column. A reason outside the closed set means the row is corrupt, and the
            // fail-closed reading of a corrupt refusal is that the gate could not be established.
            const reason = isToolDenialReason(prior.denial_reason) ? prior.denial_reason : 'policy_unavailable';
            return { status: 'denied', call: toDTO(prior), reason };
          }
          return { status: 'duplicate', call: toDTO(prior) };
        }
      }

      // The registry: the ACTIVE definition, highest version. `undefined` means unregistered, which the decision
      // refuses; `risk_class` may be null, which resolves to the most restrictive class (TOOL-001).
      const definition = await scope.db
        .selectFrom('tool_definitions')
        .select(['risk_class', 'version'])
        .where('tool_id', '=', params.toolId)
        .where('status', '=', 'active')
        .orderBy('version', 'desc')
        .executeTakeFirst();

      // ── THE POLICY GATE, consulted here and nowhere else (ACBP-P6-002; CDR-067 §2-G1/G2) ────────────────
      //
      // Point 3 of APPROVAL-AND-POLICY-ARCHITECTURE §5 — *"immediately before execution … never skippable"*. It runs
      // in the SCOPE ALREADY OPEN, so the evaluation, the call record and every audit event commit or roll back
      // together: a call recorded as authorized whose evaluation was rolled back would assert an authorization that
      // never happened. It also needs no second authorization check — this function already required `run:execute`.
      //
      // UNCONDITIONALLY, even for a call that will be refused on some other ground (G4). `decideDispatch` takes the
      // policy answer as an INPUT, so it cannot be evaluated lazily without inverting the decision function — and
      // "all checks audited" means a record that the policy WAS consulted is worth having even when the allowlist
      // refused first.
      //
      // THE RISK CLASS IS `registry`-PROVENANCED because it came from `tool_definitions`, not from model text. That
      // is exactly the distinction CDR-066 §3-G5 draws: a model-suggested class is untrusted and takes the most
      // restrictive path. Passing `registry` here is a claim about where the value came from, and it is true.
      //
      // ONE CLOCK, READ ONCE, for the same reason INV-2 pins `policy` to one read: the policy evaluation and the
      // approval's schedule check both need "now", and taking `new Date()` twice let them disagree by however long
      // the evaluation took. A scheduled approval falling due between the two reads would be judged against a
      // different instant than the evaluation recorded, making "was this authorized at time T?" unanswerable from
      // the record — which is the whole reason the clock is an input here rather than ambient.
      const now = options.now ?? new Date();
      const policyResult = await evaluatePolicyInScope(
        scope,
        {
          accountId: params.accountId,
          companyId: params.companyId,
          evaluationPoint: 'pre_execution',
          observations: { risk_class: { value: definition?.risk_class, provenance: 'registry' } },
          evaluatedAt: now,
        },
        opts(options),
      );

      // ── THE APPROVAL, BOUND (ACBP-P6-004; CDR-069) ─────────────────────────────────────────────────────────
      //
      // P6-003 made the gate read a real human decision instead of a caller's lambda. This makes that decision bind
      // to THIS payload, expire, and be spendable exactly once.
      //
      // Two steps, and the split is deliberate. The READ produces an honest REASON — expired, revoked, mismatched —
      // for the record and the caller. The CONSUME below is what actually authorizes, and it re-checks every one of
      // those conditions inside a single conditional UPDATE. A race between the two loses the race rather than
      // slipping through it: the UPDATE matches zero rows and the call is refused.
      //
      // THE COST BOUND IS RECOMPUTED FROM THE STORED REQUEST, and that is a real limit worth naming rather than
      // hiding. `dispatchToolCall` has no cost input, so there is nothing to compare a stored cost against; the
      // cost component of the hash is bound at creation and verified by anyone recomputing from the request, but
      // the dispatcher cannot detect cost drift because it never sees a second cost. Canon's "execution exceeding
      // bound limit fails closed" is the worker runtime's check at execution (P5-005), not this one.
      const approvals = new ApprovalRepository(scope.db);
      const standing = await approvals.findConsumableForCall(scope.tenant.companyId, params.runId, params.toolId);
      const expected =
        standing === undefined
          ? undefined
          : computePayloadBinding({
              toolId: params.toolId,
              // FROM THE REGISTRY, NOT FROM THE APPROVAL (review pass 1). This was `standing.tool_version` — read
              // from the very row the hash is compared against, so the version component could never mismatch and
              // the binding element canon names was inert. A human approves under v1, an active v2 lands, and v2
              // runs under v1's approval. `definition.version` is the version this call will actually execute, so
              // a version change now produces a mismatch and demands a fresh human decision, which is the
              // material-change rule doing its job.
              toolVersion: Number(definition?.version ?? -1),
              payload: params.args,
              // THE COST BOUND IS STILL THE APPROVAL'S OWN, and that is a NAMED LIMIT rather than an oversight:
              // `dispatchToolCall` has no cost input, so there is no second value to compare against. Canon's
              // "execution exceeding bound limit fails closed" is the worker runtime's check at execution
              // (P5-005). Recorded in CDR-069 §3.
              costBoundCredits: Number(standing.estimated_cost_credits),
            });
      const usability =
        standing === undefined || expected === undefined
          ? undefined
          : approvalUsability(
              { status: standing.status, revokedAt: standing.revoked_at, expiresAt: standing.expires_at, binding: { hash: standing.payload_hash, version: Number(standing.binding_version) } },
              expected.hash,
              now,
            );

      // THE REQUEST'S STATE IS NOT THE WHOLE ANSWER — the DECISION still has to authorize.
      //
      // A rejected request is `decided` too, as is one whose `schedule` has not come due, as is an
      // `edit_then_approve` whose successor carries the real payload. Checking only the request would have made all
      // three authorize, which is precisely the regression the P6-002 and P6-003 suites caught the moment this was
      // rewritten. Both halves are required: the REQUEST says the approval is live and bound to these bytes, the
      // DECISION says a human actually said yes.
      //
      // READING THE DECISION ONCE IS SAFE, unlike reading the request once. `approval_decisions` is append-only with
      // UNIQUE(request_id), so a decision cannot change after it exists — there is no race to lose. Everything that
      // CAN change between the read and the write (consumption, revocation, expiry) is re-checked atomically by the
      // conditional UPDATE below.
      const decisionRow = standing === undefined ? undefined : await approvals.findDecisionForRequest(standing.id);
      const decisionAuthorizes =
        decisionRow !== undefined &&
        // `edit_then_approve` authorizes its SUCCESSOR, never the request it replaced — nothing reads `edited_data`.
        decisionRow.path !== 'edit_then_approve' &&
        authorizesExecution({ path: decisionRow.path, effectiveFrom: decisionRow.effective_from }, now);
      // HONEST NOTE ON EVIDENCE: dropping `usability?.usable === true` from this line is an EQUIVALENT MUTATION —
      // it leaves every test green, and that is the design working rather than a gap. `verifyAndConsume` re-checks
      // the binding, the expiry and the status atomically, so a call this half would have refused is refused there
      // instead, with the same outcome. What this half actually buys is the REASON (`expired` vs `payload_mismatch`
      // vs …, logged below) and one avoided round trip. CDR-069 §1-G5 says the conditional UPDATE is the
      // enforcement; this measurement is what that sentence looks like when it is true.
      //
      // The DECISION half is NOT equivalent — dropping it turns four tests red, because no SQL predicate knows that
      // a `reject` is also `decided`.
      const approved = usability?.usable === true && decisionAuthorizes;

      // ── EMERGENCY STOP, read from the store (ACBP-P6-007; CDR-072 §1-G1; invariant 14) ────────────────────
      //
      // `listActive` returns the covering CANDIDATES — RLS already restricts rows to this account and either this
      // company or the account-wide ones, which is exactly the set that can cover a call here — and the pure
      // `evaluateStops` decides. The covering rule is NOT re-implemented here: a duplicated rule is one that can
      // drift, and the copy that drifts silently is the one that misses a scope.
      //
      // The run's task and worker are read so `task` and `worker` scopes can match. A missing worker run leaves
      // `workerId` null, which makes that scope MISS rather than throw — deliberately, because an `account_wide`
      // or `company` stop must still halt a call whose provenance is incomplete. Nothing escapes a broad stop by
      // being poorly attributed.
      //
      // THE FIRST VERSION OF THIS READ WAS WRONG IN TWO WAYS AT ONCE, and hosted CI found it because a fixture
      // guard refused to compare null against null. It ran
      //   `select task_run_id, worker_id from worker_runs where id = <runId>`
      // but `params.runId` is a `task_runs.id` — it is what `TaskRunRepository.findById` resolved above. So:
      //   1. the join key was wrong (`worker_runs.id` against a task-run id) and matched NOTHING, ever; and
      //   2. even had it matched, `task_run_id` is not a TASK id — a `task` stop targets a task (`held_work.task_id`
      //      references `tasks`), so the comparison could never be true either.
      // Both `task` and `worker` scopes therefore resolved to null on every call: two of the five enforceable
      // scopes SILENTLY ENFORCED NOTHING while the stop appeared to work. That is CDR-072 §0's failure exactly —
      // and it is the reason the enforcement matrix has to run through the dispatcher rather than stop at the
      // pure covering relation, which was correct the whole time.
      //
      // `taskRun.task_id` is already in hand from the lookup above, so the task identity costs no query at all.
      // The worker comes from the worker run OF this task run — exactly one can exist, because migration 0040
      // carries `UNIQUE(task_run_id)` ("one worker executes one attempt"), so this is a lookup and not a choice.
      const workerRow = await sql<{ worker_id: string }>`
        select worker_id from worker_runs where task_run_id = ${params.runId}::uuid
      `.execute(scope.db);
      const activeStops = await new StopRepository(scope.db).listActive();
      // Mapped field-by-field rather than cast. A cast would also silence the day a column is renamed, and this is
      // the input to the function that decides whether the platform is halted.
      // HOISTED so the covering-stop lookup below can re-ask the SAME question about the SAME call, rather than
      // reconstructing the facts and risking a second, drifting version of them.
      const stoppableCall = {
        taskId: taskRun.task_id,
        workerId: workerRow.rows[0]?.worker_id ?? null,
        // Inert scopes (CDR-072 §1-G10): the registry carries no identity for either, so these stay null and a
        // stored stop of that kind resolves to `unreadable` → denied rather than silently missing.
        capabilityId: null,
        integrationId: null,
        // DERIVED from the registry's risk class via the contract's own helper. `tool_registrations` has no
        // external-effect column, and CDR-051 §0.2 records that deriving it is the stand-in until a tool declares
        // one. Never from model text (ADR-010 §5).
        hasExternalEffect: hasExternalEffect(definition?.risk_class),
        companyId: scope.tenant.companyId,
      };
      const stopEvaluation = evaluateStops(
        activeStops.map((s) => ({ scope: s.scope, targetId: s.target_id })),
        stoppableCall,
      );

      const decision = decideDispatch({
        toolId: params.toolId,
        registered: definition !== undefined,
        riskClass: definition?.risk_class,
        allowlist: params.allowlist,
        untrustedContext: untrusted,
        // ── THE STOP GATE, read from the STORE inside this transaction (ACBP-P6-007; CDR-072 §1-G1/G3/G4) ──
        //
        // Same scope, same transaction as the call it authorizes. That is what bounds launch gate 8's <=5s
        // propagation by TRANSACTION VISIBILITY rather than by a cache refresh: a stop committed before this read is
        // visible to it, so there is nothing to propagate and no interval to tune.
        //
        // `unreadable` maps to `unavailable`, NOT to `clear`. Canon's own principle is that *"no stop is recorded"
        // is a complete answer; "I could not check" is not* — and `decideDispatch` turns `unavailable` into
        // `stop_unavailable` -> denied. That covers a corrupt record AND a scope this release cannot enforce.
        stop: toStopGateAnswer(stopEvaluation),
        // The engine's OWN mapping, tested beside it, so the translation cannot be got wrong here. It never yields
        // `unavailable`: a RESULT is an answer, and only a thrown evaluation — which propagates and rolls the whole
        // dispatch back — means no answer at all. It DOES yield `require_approval`, which is what makes the approval
        // demand conditional on POLICY rather than on the risk class (CDR-067 §2-G7).
        policy: toPolicyGateAnswer(policyResult),
        // ── THE APPROVAL GATE, read from the STORE and BOUND to this payload (CDR-068 §0.1; CDR-069) ───────
        //
        // Same scope, same transaction. `unavailable` means exactly one thing — no approval stands against this
        // call — and every other state (expired, revoked, already spent, bound to different bytes) DENIES rather
        // than reading as absence. That distinction was a measured defect once already: an answer that merely
        // "isn't there" can ride the no-gate waiver, and an explicit refusal must not.
        approval: standing === undefined ? { kind: 'unavailable' } : approved ? { kind: 'allow' } : { kind: 'deny' },
      });

      // The call's id, generated here rather than defaulted by the table, so `consumed_by_call_id` can reference a
      // row that exists by the time the approval is spent below. (An earlier draft of this file argued the reverse
      // order — consume first — and the FK refused it; the superseded rationale is gone rather than left to
      // confuse the next reader. CDR-069 §3 records the correction.)
      const callId = randomUUID();
      const spend = decision.kind === 'authorized' && approved;
      const denialReason: ToolDenialReason | null = decision.kind === 'denied' ? decision.reason : null;

      const externalEffect = hasExternalEffect(decision.riskClass);
      const inserted = await calls.insert({
        id: callId,
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        runId: params.runId,
        toolId: params.toolId,
        toolVersion: definition?.version ?? null,
        riskClass: decision.riskClass,
        externalEffect,
        outcome: denialReason === null ? 'requested' : 'denied',
        denialReason,
        argumentsDigest,
        // The evaluation that decided this call (CDR-067 §2-G3). Null when there was no usable policy — the call is
        // still recorded, as a denial, because TOOL-002 wants 100% of attempts recorded.
        policyEvalId: policyResult.status === 'decided' ? policyResult.evaluationId : null,
        idempotencyKey: idempotencyKey ?? null,
      });

      // The unique index fired between the read above and this insert: another caller claimed the key first. Report
      // the call that won rather than inventing a second record of the same event.
      if (inserted === undefined) {
        const winner = idempotencyKey === undefined ? undefined : await calls.findByIdempotencyKey(params.toolId, idempotencyKey);
        if (winner === undefined) throw new Error('tool call insert wrote nothing and no idempotent winner exists — invariant violated');
        return { status: 'duplicate', call: toDTO(winner) };
      }

      // ── SPEND THE APPROVAL (CDR-069 §1-G5/G7) ──────────────────────────────────────────────────────────────
      //
      // AFTER the insert, because `approval_requests.consumed_by_call_id` is a real foreign key and consuming first
      // would reference a row that does not exist yet — the database said so, which is a better argument than the
      // one this code originally had. Order inside the transaction is invisible anyway: nothing commits separately,
      // so the only state anyone observes is the final one.
      //
      // WE SPEND WHAT AUTHORIZED THE CALL. If nothing stands against it, or what stands is unusable, there is
      // nothing to consume.
      //
      // A STANDING APPROVAL IS SPENT EVEN WHEN POLICY WOULD HAVE ALLOWED THE CALL ANYWAY, and an earlier comment
      // here claimed the opposite (review pass 2, F8). Keeping it: the approval was raised and decided for THIS
      // action, so spending it on the action it was raised for is what single-use means. Not spending it would
      // leave a decided approval lying around for a later call the policy might NOT allow — which is the more
      // dangerous direction. Nothing is lost either way, because a call policy allows proceeds with or without one.
      //
      // A LOST RACE DENIES. `verifyAndConsume` re-checks status, revocation, expiry and the binding atomically. If
      // another dispatch spent it, or a human revoked it, in the moment since the read above, this returns nothing
      // and the call is corrected to DENIED before commit — never authorized-but-unspent.
      //
      // CONSUMPTION HAPPENS AT AUTHORIZATION, WHICH BURNS THE APPROVAL EVEN IF THE CALL NEVER RUNS. There is no
      // execution instant yet — the worker runtime is P5-005 — so this is the only chokepoint that exists. It is the
      // fail-closed direction (the alternative leaves an unspent approval available for a second dispatch) and a
      // real cost: a human must approve again. CDR-069 §1-G7 records it as the decision to revisit.
      let finalReason = denialReason;
      let finalRow = inserted;
      if (spend) {
        const consumed = await approvals.verifyAndConsume({
          // THE ROW THE GATE JUDGED. `standing` is defined whenever `spend` is true, because `approved` is derived
          // from it — spending any other row would mean judging one approval and consuming another.
          requestId: standing?.id ?? '',
          companyId: scope.tenant.companyId,
          runId: params.runId,
          toolId: params.toolId,
          payloadHash: expected?.hash ?? '',
          bindingVersion: expected?.version ?? -1,
          callId: inserted.id,
          now,
        });
        if (consumed === undefined) {
          // `approval_invalid` rather than `approval_required`: an approval DID stand against this call a moment
          // ago, and "none exists" would send a reader to raise another one instead of looking for who spent or
          // revoked this one.
          finalReason = 'approval_invalid';
          // THE ROW COUNT IS CHECKED. This is a security-critical correction — the difference between a call
          // recorded as authorized and one recorded as refused — and reporting an unapplied write as applied is
          // exactly the shape review passes keep finding. It cannot fail today (the row was inserted `requested`
          // in this same transaction), which is why one `if` makes it provably honest rather than merely likely.
          if ((await calls.markDenied({ callId: inserted.id, reason: finalReason })) !== 1) {
            throw new Error('tool call denial correction updated no row — the authorized record would have survived a refused spend');
          }
          finalRow = { ...inserted, outcome: 'denied', denial_reason: finalReason };
        } else {
          // IN THE SAME TRANSACTION as the spend, so the event and the `consumed_at` column cannot disagree through
          // partial failure — audit-or-nothing (ADR-015), the same shape every other write in this file follows.
          await audit(scope, approvalConsumed({ requestId: consumed.id, callId: inserted.id, toolId: params.toolId }), auditCtx(options));
        }
      }

      // ── HOLD THE WORK THIS STOP JUST CAUGHT (CDR-072 §1-G6, PM ruling: Option B) ───────────────────────────
      //
      // WHY THIS WRITE LIVES IN THE CHOKEPOINT, AND THE OBJECTION AGAINST IT. An `account_wide` stop is visible to
      // every company in the account (dual-scope RLS) and the dispatcher refuses their calls correctly — but
      // `activateStop` runs in ONE company's scope, so only that company's work got a `held_work` row and a
      // `running → paused` transition. Sibling companies were halted with no review queue and no paused state, and
      // on clear their work resumed with no confirm-or-discard decision.
      //
      // The PM ruled Option B over fanning out per company at activation (O(companies × tasks) statements before
      // commit, on the control whose promise is speed) and over merely documenting the gap. THE ACCEPTED COST IS
      // THIS LINE: the dispatcher now mutates task lifecycle state, which is a responsibility it did not previously
      // have, on the most security-sensitive function in the codebase. That was weighed, not overlooked. If it
      // causes trouble, the coherent retreat is to delete this block and keep the labelling — CDR-072 §1-G6.
      //
      // ⚠️ THE BOUNDARY, STATED WHERE IT IS EASIEST TO FORGET: this catches a task only when that task ATTEMPTS A
      // CALL. A task halted by the stop that never reaches the dispatcher is never held and never paused. The queue
      // is therefore a record of what the stop actually INTERRUPTED, never a roster of everything it covers.
      //
      // IDEMPOTENT BY CONSTRUCTION: `held_work_stop_task_uq` + `ON CONFLICT DO NOTHING`, because a stopped task
      // typically retries and each retry lands here again. Proven against a real database, not argued.
      let heldByStopId: string | undefined;
      let pausedTask = false;
      if (finalReason === 'emergency_stopped' && stopEvaluation.kind === 'stopped') {
        // ── WHICH STOP CAUGHT THIS CALL — RE-ASKED, NOT NAME-MATCHED (independent review, Blocker) ───────────
        //
        // The first version matched the covering SCOPE NAMES back against `activeStops` and took the first hit.
        // `listActive` orders by `activated_at, id`, NOT by covering, so with two `task` stops up — one for task Y
        // raised at 10:00, one for task X at 10:05 — a call from task X was attributed to Y's stop. The
        // consequences compounded: `listHeld(S_X)` returned empty so clearing X's stop reported nothing to review
        // while X sat paused, and X could only be released by reviewing a row filed under a stop that never
        // covered it — which `reviewHeldWork` refuses while that stop is active. A permanently paused,
        // uncompletable task, with the evidence saying all was well. §0's failure relocated into the record.
        //
        // The fix asks the covering relation ITSELF, one stop at a time, about the SAME call facts the decision
        // used: a stop covers iff evaluating it ALONE returns `stopped`. No name matching, no second rule to drift.
        // Ties resolve to the EARLIEST covering stop (`activated_at, id`), which is deterministic and is the halt
        // that actually caught the task first.
        const covering = activeStops.find(
          (s) => evaluateStops([{ scope: s.scope, targetId: s.target_id }], stoppableCall).kind === 'stopped',
        );
        // `external_actions_only` HALTS CALLS, NOT TASKS — so it must not hold or pause (independent review).
        // `activateStop` deliberately holds nothing for it ("internal work continues by design"), and an
        // unfiltered write here silently converted the narrowest control into a whole-task halt: one `send_email`
        // and the task was paused into ADMIN-002's queue. §1-G2 names over-halting as a defect in its own right.
        // A stop of another scope covering the same call still holds — this filters the SCOPE, not the call.
        const haltsTheTask = covering !== undefined && covering.scope !== 'external_actions_only';
        if (haltsTheTask) {
          await new StopRepository(scope.db).hold({
            accountId: scope.tenant.accountId,
            companyId: scope.tenant.companyId,
            stopId: covering.id,
            taskId: taskRun.task_id,
          });
          heldByStopId = covering.id;
          // THE ROW COUNT IS CHECKED, matching the correction twenty lines above: a task that left `running` in
          // this window is NOT paused, and reporting it as paused would be the "unapplied write reported as
          // applied" shape review passes keep finding. `running → paused` is the only legal edge into `paused`
          // (WORKFLOW §4); any other state is held for review without a transition.
          pausedTask = (await new TaskRepository(scope.db).updateState(taskRun.task_id, 'running', 'paused')) === 1;
        }
      }

      await audit(scope, requestedEvent(finalRow, finalReason, signals, stopEvaluation, heldByStopId, pausedTask), auditCtx(options));
      if (finalReason !== null) {
        // Logged at WARN because a refusal at the chokepoint is the signal the platform alarms on (TOOL-003 asks for
        // owner notification on gate unavailability). Metadata is scalars only — no arguments, no digest.
        // `approvalDetail` carries WHY the approval failed — `expired`, `revoked`, `consumed`, `payload_mismatch`.
        // The `tool_calls` row records only `approval_invalid`, because the denial-reason vocabulary is a closed
        // contract; without this an operator could not tell an expired approval from a tampered payload. Review
        // pass 1 was right that the code computed the reason and threw it away while a comment claimed otherwise.
        options.logger?.warn('tool.call_denied', {
          metadata: {
            companyId: params.companyId,
            toolId: params.toolId,
            reason: finalReason,
            riskClass: decision.riskClass,
            ...(usability !== undefined && !usability.usable ? { approvalDetail: usability.reason } : {}),
          },
        });
        return { status: 'denied', call: toDTO(finalRow), reason: finalReason };
      }
      return { status: 'authorized', call: toDTO(finalRow) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── reporting the outcome ───────────────────────────────────────────────────────────────────────────────────

export interface ReportToolCallOutcomeParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly callId: string;
  /** `succeeded` · `failed` · `unconfirmed`. `denied` is the dispatcher's to write, never the caller's. */
  readonly outcome: string;
  /** Required to claim success on an external effect (TOOL-002). */
  readonly receiptRef?: string;
}

export type ReportToolCallOutcomeResult =
  | { readonly status: 'ok'; readonly call: ToolCallDTO }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  // Already reported. A second report is refused rather than applied — see below.
  | { readonly status: 'not_requested'; readonly outcome: string }
  | { readonly status: 'invalid' }
  // TOOL-002's failure clause, enforced here so the caller learns WHY rather than hitting a constraint error.
  | { readonly status: 'receipt_required' };

/**
 * Close a call with its outcome.
 *
 * THE GUARD ON `requested` IS THE POINT. Without it an `unconfirmed` external effect could be re-reported as
 * `succeeded` later — turning "we could not evidence this" into "this worked" with no new evidence, which is exactly
 * what TOOL-002's failure clause exists to prevent.
 */
export async function reportToolCallOutcome(client: DatabaseClient, params: ReportToolCallOutcomeParams, options: DispatcherOptions = {}): Promise<ReportToolCallOutcomeResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReportToolCallOutcomeResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      // `requested` and `denied` are the dispatcher's own writes; a caller reporting either would be claiming an
      // outcome it did not have.
      if (!isToolCallOutcome(params.outcome) || params.outcome === 'requested' || params.outcome === 'denied') return { status: 'invalid' };

      const calls = new ToolCallRepository(scope.db);
      const current = await calls.findById(params.callId);
      if (current === undefined) return { status: 'not_found' };
      if (current.outcome !== 'requested') return { status: 'not_requested', outcome: current.outcome };
      // Blank is MISSING. A whitespace receipt satisfies a naive `is not null` while evidencing nothing, which is the
      // hollow success TOOL-002 exists to prevent — so it is normalized to null once, here, and judged as absent.
      const receipt: string | null = (params.receiptRef ?? '').trim() === '' ? null : (params.receiptRef ?? null);
      if (params.outcome === 'succeeded' && current.external_effect && receipt === null) return { status: 'receipt_required' };

      const updated = await calls.complete({
        callId: params.callId,
        outcome: params.outcome,
        // Blank is stored as NULL: a whitespace receipt evidences nothing, and keeping it would leave a value that
        // LOOKS like evidence in the column the receipt rule reads.
        receiptRef: receipt,
      });
      // The guard missed: something else closed the call between the read and the write. Re-read and report what it
      // actually became rather than claiming this report landed.
      if (updated === undefined) {
        const latest = await calls.findById(params.callId);
        return latest === undefined ? { status: 'not_found' } : { status: 'not_requested', outcome: latest.outcome };
      }

      await audit(scope, completedEvent(updated), auditCtx(options));
      return { status: 'ok', call: toDTO(updated) };
    },
    opts(options),
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

// ── audit events (the factories live in @acbp/contracts, so the registry types them) ─────────────────────────

function requestedEvent(
  row: ToolCallRow,
  denialReason: string | null,
  injectionSignals: string,
  stopEvaluation: StopEvaluation,
  heldByStopId?: string,
  pausedTask?: boolean,
) {
  const base = { callId: row.id, toolId: row.tool_id, toolVersion: row.tool_version, riskClass: row.risk_class, externalEffect: row.external_effect, ...(injectionSignals === '' ? {} : { injectionSignals }) };
  // WHICH SCOPES HALTED IT (CDR-072 §1-G5), taken from the evaluation that actually decided this call rather than
  // re-derived — a second derivation is one that can disagree with the refusal it is supposed to explain. The
  // factory records it only on an `emergency_stopped` refusal, so passing it unconditionally here is safe and
  // keeps the "what halted this" answer next to the reason instead of behind a branch that could be missed.
  const stopScopes = stopEvaluation.kind === 'stopped' ? stopEvaluation.scopes.join(',') : '';
  return denialReason === null
    ? toolCallRequested(base)
    : toolCallRequested({ ...base, denialReason, stopScopes, ...(heldByStopId === undefined ? {} : { heldByStopId, pausedTask: pausedTask === true }) });
}

/** The DISTINCT signals across every untrusted item, comma-joined. Signals only — the content never leaves memory. */
function injectionSignalsIn(context: readonly unknown[]): string {
  const found = new Set<string>();
  for (const item of context) {
    const content = (item as { content?: unknown } | null | undefined)?.content;
    if (typeof content === 'string') for (const s of detectInjection(content).signals) found.add(s);
  }
  return [...found].sort().join(',');
}

function completedEvent(row: ToolCallRow) {
  return toolCallCompleted({ callId: row.id, toolId: row.tool_id, riskClass: row.risk_class, callOutcome: row.outcome, hasReceipt: row.receipt_ref !== null });
}

function auditCtx(options: DispatcherOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}
function opts(options: DispatcherOptions): { correlationId?: string; logger?: Logger; auditWriter?: typeof writeAuditEvent } {
  const o: { correlationId?: string; logger?: Logger; auditWriter?: typeof writeAuditEvent } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  // FORWARDED (review pass 2). Without this the policy engine's own audit events always used the real writer even
  // when a caller injected one, so a suite asserting "all checks audited" through an injected writer would silently
  // miss `policy.evaluated` and `policy.blocked` and read that absence as a pass.
  if (options.auditWriter !== undefined) o.auditWriter = options.auditWriter;
  return o;
}
