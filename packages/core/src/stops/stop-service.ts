// @acbp/core — the emergency-stop controller (ACBP-P6-007; CDR-072; ADMIN-001/002; COMP-006; trust-critical #9/#10).
//
// ⚠️ SEVEN SCOPES ARE NAMED; FIVE ARE ENFORCEABLE. `capability` and `integration` are refused here BY NAME
// (CDR-072 §1-G10) because the tool registry carries no identity for either, so no call could ever be matched
// against them. Accepting one would hand the operator a halt that does nothing — CDR-072 §0's failure, created by
// the very code meant to prevent it.
//
// THE TRANSACTION RULE THAT SHAPES EVERY FUNCTION HERE (§1-G8): `runInCompanyScope` runs its callback INSIDE the
// account transaction, so `return { status: 'refused' }` AFTER a write COMMITS that write. For a stop that is worse
// than for anything else in the codebase — the system would be PARTIALLY STOPPED while telling the operator it did
// not stop, so belief and state disagree in a way neither surfaces. Refusals before the first write are typed;
// anything after it THROWS.
import {
  STOP_SCOPES,
  ENFORCEABLE_STOP_SCOPES,
  NOT_YET_ENFORCEABLE_STOP_SCOPES,
  isStopScope,
  isEnforceableStopScope,
  emergencyStopActivated,
  emergencyStopCleared,
  emergencyStopWorkReviewed,
  type StopScope,
} from '@acbp/contracts';
import { StopRepository, TaskRepository, TaskRunRepository, writeAuditEvent, type DatabaseClient, type TenantScope } from '@acbp/database';
import { sql } from 'kysely';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

export interface StopServiceOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

/** Why a stop operation was refused. CLOSED — a reason, never an exception message. */
export const STOP_REFUSAL_REASONS = [
  'not_a_scope',
  'scope_not_enforceable',
  'target_required',
  'target_not_allowed',
  'already_active',
  'not_found',
  'not_active',
  'already_reviewed',
  /** A `company` stop naming a company other than the one it is raised in — see the refusal site. */
  'target_must_be_own_company',
  /** A `task`/`worker` stop naming something that does not exist in this tenant — it could never cover a call. */
  'target_not_found',
  /**
   * Reviewing held work while the stop is STILL ACTIVE. ADMIN-002 says clearing a stop *opens* the mandatory
   * review, so this order is not merely unusual — confirming here would either resume work into a live halt or
   * record a decision whose effect silently depends on a later clear.
   */
  'stop_still_active',
] as const;
export type StopRefusalReason = (typeof STOP_REFUSAL_REASONS)[number];

/**
 * Task states that represent WORK IN FLIGHT and are therefore held by a stop (CDR-072 §1-G6; OQ-14's documented
 * MVP default: *"finish the current tool call, halt before the next, hold the task visibly"*).
 *
 * `draft`/`planned` are NOT held: nothing is running, so there is nothing to hold and adding them would inflate the
 * review queue with work that never started. Terminal states are not held for the obvious reason.
 */
const IN_FLIGHT_TASK_STATES = ['queued', 'running', 'waiting_for_input', 'waiting_for_approval'] as const;

/** Shape gate before any `::uuid` cast — see the `task` target check for why a `.catch()` cannot do this job. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActivateStopParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** Unvalidated on purpose — refusing a bad scope is this function's job, not the type system's. */
  readonly scope: unknown;
  readonly targetId?: string | null;
  readonly reason?: string | null;
}

export type ActivateStopResult =
  | {
      readonly status: 'ok';
      readonly stopId: string;
      readonly scope: StopScope;
      readonly heldCount: number;
      /** How many held tasks were actually transitioned `running → paused`. See `emergencyStopActivated`. */
      readonly pausedCount: number;
      /**
       * How many live RUNS were asked to safe-stop. Distinct from `pausedCount`: pausing the task blocks its
       * completion, but only this makes the worker halt at its next checkpoint (WORKFLOW §4's "in-flight
       * safe-stop"). A task can be paused with no live run, so the two counts legitimately differ.
       */
      readonly stopRequestedCount: number;
    }
  | { readonly status: 'refused'; readonly reason: StopRefusalReason }
  | { readonly status: 'forbidden' };

/**
 * Activate an emergency stop (ADMIN-001).
 *
 * OWNER-ONLY via `stop:activate`, a deliberately separate action from `stop:clear` so a later role model CAN give
 * halting and un-halting to different people.
 *
 * TODAY THEY ARE THE SAME PEOPLE. Both actions map to `['owner']` in the authz policy, so no asymmetry is enforced
 * yet — the separation is structural, not effective. An earlier version of this comment asserted that "whoever may
 * halt the platform is not automatically whoever may restart it", which stated the intent as though it were the
 * behaviour.
 */
export async function activateStop(client: DatabaseClient, params: ActivateStopParams, options: StopServiceOptions = {}): Promise<ActivateStopResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ActivateStopResult> => {
      // MUTATION PROBE - ACBP-API-011 owed item 2. DO NOT MERGE.
      // The stop:activate owner-only check is DELETED here on purpose, to prove the real-PostgreSQL viewer
      // refusal test is load-bearing rather than passing for some other reason.

      // ── every refusal below happens BEFORE the first write, so a typed result is safe here (§1-G8) ──
      if (!isStopScope(params.scope)) return { status: 'refused', reason: 'not_a_scope' };
      // REFUSED BY NAME, never accepted-and-inert. See the header.
      if (!isEnforceableStopScope(params.scope)) return { status: 'refused', reason: 'scope_not_enforceable' };

      const requiresTarget = params.scope === 'task' || params.scope === 'worker' || params.scope === 'company';
      const target = typeof params.targetId === 'string' ? params.targetId.trim() : '';
      if (requiresTarget && target === '') return { status: 'refused', reason: 'target_required' };
      if (!requiresTarget && target !== '') return { status: 'refused', reason: 'target_not_allowed' };
      // A `company` STOP MUST NAME ITS OWN COMPANY (review pass 2). The covering rule matches this scope by
      // comparing `target_id` against the CALL's company, while RLS shows the row to the company in `company_id`.
      // A stop raised in company A naming company B would therefore be active and visible to A while covering
      // NOTHING — §0's failure with a different mask on. Refused here so the caller gets a reason, and refused by
      // migration 0050's CHECK so it cannot be stored by any future path that forgets to ask.
      if (params.scope === 'company' && target !== scope.tenant.companyId) {
        return { status: 'refused', reason: 'target_must_be_own_company' };
      }
      // ── AND THE SAME REASONING FOR `task` AND `worker` (fixed after independent review) ────────────────────
      //
      // The `company` refusal above was added in review pass 2 and NOT GENERALISED, which is its own lesson: the
      // argument for it — "a stop that is active and visible while covering NOTHING is §0's failure with a
      // different mask on" — applies verbatim to the other two identity scopes, and they were left as free text.
      // Any non-blank string was stored, went `active`, appeared in `readStopState`, and could never match a call.
      //
      // The concrete case is not hypothetical: an operator halting a runaway task pastes the TASK-RUN id — exactly
      // the confusion the dispatcher itself shipped (CDR-072 §1-G2) — and is told the stop worked while the task
      // keeps calling tools. Existence is checked inside this transaction under RLS, so a foreign company's task
      // reads as absent and is refused for the same reason rather than leaking that it exists.
      if (params.scope === 'task') {
        // SHAPE-CHECKED IN JS BEFORE THE CAST, and that is not belt-and-braces. A malformed `::uuid` cast raises
        // 22P02, and in PostgreSQL a failed statement ABORTS THE TRANSACTION — every later statement then dies with
        // 25P02, so a `.catch()` around the query would convert a clean typed refusal into a broken transaction.
        // The first draft of this guard did exactly that.
        if (!UUID_PATTERN.test(target)) return { status: 'refused', reason: 'target_not_found' };
        const found = await sql<{ id: string }>`select id from tasks where id = ${target}::uuid`.execute(scope.db);
        if (found.rows.length === 0) return { status: 'refused', reason: 'target_not_found' };
      }
      if (params.scope === 'worker') {
        // The WORKER REGISTRY is the authority, not a run: a worker with no run yet is still a legitimate target,
        // and refusing it would make the stop unavailable exactly when the operator wants it pre-emptively.
        const found = await sql<{ worker_id: string }>`select worker_id from worker_definitions where worker_id = ${target}`.execute(scope.db);
        if (found.rows.length === 0) return { status: 'refused', reason: 'target_not_found' };
      }

      const stops = new StopRepository(scope.db);
      const created = await stops.insert({
        accountId: scope.tenant.accountId,
        // NULL for `account_wide` ONLY — migration 0050's CHECK is what keeps that true. An account-wide stop
        // pinned to a company would not cover its siblings, which is the silent miss wearing a schema.
        companyId: params.scope === 'account_wide' ? null : scope.tenant.companyId,
        scope: params.scope,
        targetId: requiresTarget ? target : null,
        reason: params.reason ?? null,
        activatedByUserId: params.userId,
      });
      // Still no write of ours has landed — the conflict means someone else's stop of this exact shape is already
      // active, so a typed refusal is honest and nothing needs rolling back.
      if (created === undefined) return { status: 'refused', reason: 'already_active' };

      // ── FIRST WRITE HAS LANDED. Everything below THROWS on failure (§1-G8). ──

      // Hold work that is in flight. Nothing is cancelled — diagram 13's queue is "visible, nothing lost".
      //
      // ⚠️ KNOWN LIMITATION, FLAGGED FOR THE OWNER — AN `account_wide` STOP HOLDS ONLY THIS COMPANY'S WORK.
      //
      // The stop itself IS account-wide: its row carries `company_id NULL` and the dual-scope RLS predicate makes it
      // visible to every company in the account, so the DISPATCHER denies their calls correctly. That half works.
      //
      // The HELD-WORK QUEUE does not. `held_work.company_id` is NOT NULL and its FK to `tasks` is tenant-pinned, and
      // this transaction holds ONE company's scope — so only the company the stop was raised from gets rows here.
      // Two consequences, and neither is cosmetic:
      //   1. `heldCount` below, and `pending_review_count` on the clear event, count ONE company. A reader must not
      //      take them as the account-wide total.
      //   2. ADMIN-002's mandatory review therefore never sees the other companies' in-flight tasks. When the stop
      //      is cleared their next tool call simply succeeds — so for those companies, work resumes WITHOUT a
      //      confirm-or-discard decision.
      //
      //      AN EARLIER VERSION OF THIS COMMENT ENDED "...which is 'nothing auto-fires on resume' holding for one
      //      company ONLY." THAT WAS FALSE. It held for no company: `held_work.status` was read by nothing at all,
      //      so a cleared stop resumed everything everywhere regardless of review. Stating the narrower, more
      //      comfortable version as fact is what let the real defect sit unexamined. See `clearStop` and
      //      CDR-072 §1-G7 for the canon-specified fix.
      //
      // NOT FIXED HERE ON PURPOSE. Writing `held_work` rows for sibling companies means establishing each company's
      // scope inside one account-wide operation, which is a tenant-isolation decision and an OWNER GATE under the
      // charter — not something to guess at inside a stop implementation. CDR-072 §1-G6 records it as open.
      //
      // ── WHAT THIS STOP ACTUALLY CAUGHT — PER SCOPE (fixed after independent review) ────────────────────────
      //
      // The first version ran ONE query for every scope: all in-flight tasks in the company, ignoring
      // `params.scope` and `params.targetId` entirely. A `task` stop naming one task therefore held all nine
      // in-flight tasks and reported `held_count: 9`, while the dispatcher refused calls for exactly one of them.
      // The other eight were never halted and yet appeared in ADMIN-002's review queue.
      //
      // That is CDR-072 §0's failure in the OVER-stating direction, which §1-G2 names as "a different defect from
      // one that under-halts, but still a defect": the operator's picture of what is running is wrong either way,
      // and a review queue padded with work that was never stopped is one nobody can finish honestly.
      //
      // The held set must therefore be the set the covering relation would actually halt:
      const inFlightStates = sql.join(IN_FLIGHT_TASK_STATES.map((s) => sql.lit(s)));
      const caught = async (): Promise<readonly { id: string; state: string }[]> => {
        // Whole-company halts: `account_wide` and `company` both stop every call in this company, so every
        // in-flight task here is genuinely caught.
        if (params.scope === 'account_wide' || params.scope === 'company') {
          return (
            await sql<{ id: string; state: string }>`
              select id, state from tasks
              where company_id = ${scope.tenant.companyId}::uuid and state in (${inFlightStates}) order by id
            `.execute(scope.db)
          ).rows;
        }
        // A task stop catches exactly its task — and only if that task is actually in flight.
        if (params.scope === 'task') {
          return (
            await sql<{ id: string; state: string }>`
              select id, state from tasks
              where company_id = ${scope.tenant.companyId}::uuid and id = ${target}::uuid and state in (${inFlightStates})
            `.execute(scope.db)
          ).rows;
        }
        // A worker stop catches the tasks that worker is executing, via the run that stamped it. `worker_runs` has
        // `UNIQUE(task_run_id)`, so this cannot fan out per attempt.
        if (params.scope === 'worker') {
          return (
            await sql<{ id: string; state: string }>`
              select t.id, t.state from tasks t
                join task_runs tr on tr.task_id = t.id
                join worker_runs wr on wr.task_run_id = tr.id
              where t.company_id = ${scope.tenant.companyId}::uuid and wr.worker_id = ${target} and t.state in (${inFlightStates})
              group by t.id, t.state order by t.id
            `.execute(scope.db)
          ).rows;
        }
        // `external_actions_only` HOLDS NOTHING, deliberately. It does not halt a task — it refuses the subset of
        // that task's calls which reach the outside world, and internal work continues by design. Which in-flight
        // tasks would later attempt an external call is not knowable at activation time, so holding them all would
        // assert a halt that did not happen, and holding "the ones that will" is unanswerable. An empty queue is
        // the honest record: nothing was stopped outright, so nothing awaits a confirm-or-discard decision.
        return [];
      };
      const inFlight = { rows: await caught() };

      // ── HOLD, AND PAUSE WHAT IS ACTUALLY RUNNING (canon: WORKFLOW §4; CDR-072 §1-G7) ──────────────────────
      //
      // `held_work` alone was never enough — it was written and read by nothing, so a cleared stop resumed every
      // task regardless of its review. Canon puts the enforcement on the TASK STATE MACHINE, which already owns
      // "may this task proceed": `running→paused`, actor *"system (company pause / emergency stop)"*, precondition
      // *"scope stop active"*, effect *"held visibly; resume requires review (ADMIN-002)"*. `paused` and both
      // directions were ALREADY legal transitions (P4-002, verbatim from WORKFLOW §4) — the transition simply had
      // no producer. Nothing here is invented.
      //
      // ONLY `running` TASKS TRANSITION, because `running→paused` is the only legal edge into `paused`. The other
      // in-flight states need no edge and must not get one:
      //   `queued`              — WORKFLOW §4 already gates `queued→running` on *"stop-state clear"*, so a queued
      //                           task cannot start while the stop stands. Pausing it would add an illegal edge to
      //                           solve a problem the state machine has already solved.
      //   `waiting_for_input`   — not executing; it is blocked on a human or an approval, and the dispatcher refuses
      //   `waiting_for_approval`  any tool call it makes on resume anyway.
      // They are still HELD, because ADMIN-002's review is about what the operator must decide on, not only about
      // what changed state.
      // ── THE LIVE RUNS OF THE TASKS THIS STOP CAUGHT (CDR-072 §1-G7, PM ruling on finding 6) ────────────────
      //
      // Pausing the TASK does not stop the RUN. An independent review found that a task paused by a stop keeps
      // executing tools once the stop clears, because nothing on the dispatch path reads `tasks.state` — the pause
      // only blocks completion. Canon's answer for work already in flight is not another gate read: WORKFLOW §4
      // gives company pause the effect *"in-flight safe-stop"*, and the mechanism already exists —
      // `task_runs.stop_requested_at`, which `decideStepAdmission` checks FIRST because *"an owner's request
      // outranks every automatic rule and is not a failure"*, ending the run as `stopped` rather than failed.
      // That is OQ-14's *"finish the current tool call, halt before the next"* exactly.
      //
      // ONE QUERY, NO LIMIT. `listRunning` takes a `limit`, and a silent truncation here would leave some caught
      // runs never asked to stop — the silent-miss shape this whole ticket is about. Every running run in this
      // company is read and matched against the caught set instead.
      const liveRuns = await sql<{ id: string; task_id: string }>`
        select id, task_id from task_runs where company_id = ${scope.tenant.companyId}::uuid and state = 'running'
      `.execute(scope.db);
      const runByTask = new Map(liveRuns.rows.map((r) => [r.task_id, r.id]));

      let heldCount = 0;
      let pausedCount = 0;
      let stopRequestedCount = 0;
      const tasks = new TaskRepository(scope.db);
      const runs = new TaskRunRepository(scope.db);
      for (const task of inFlight.rows) {
        const held = await stops.hold({
          accountId: scope.tenant.accountId,
          companyId: scope.tenant.companyId,
          stopId: created.id,
          taskId: task.id,
        });
        if (held !== undefined) heldCount += 1;
        // Guarded on `state = 'running'`, so a task that finished in this window is simply not paused — exactly one
        // transition can win and a completed task is never dragged backwards.
        if (task.state === 'running' && (await tasks.updateState(task.id, 'running', 'paused')) === 1) pausedCount += 1;
        // SAFE-STOP THE RUN, not just the task. Guarded on `running` inside `requestStop` and idempotent by design
        // (asking twice keeps the FIRST request time), so a run that ended in this window is simply not asked.
        // Only runs of tasks this stop CAUGHT are asked — the negative half is asserted, because a stop that
        // halted a run it does not cover would be the over-halt direction of §0.
        const runId = runByTask.get(task.id);
        if (runId !== undefined && (await runs.requestStop(runId)) !== undefined) stopRequestedCount += 1;
      }

      // The evidence names WHAT halted, not that something did (§1-G5).
      await audit(
        scope,
        emergencyStopActivated({ stopId: created.id, scope: params.scope, target: requiresTarget ? target : null, heldCount, pausedCount, stopRequestedCount }),
        auditCtx(options),
      );
      options.logger?.warn('stop.activated', {
        metadata: { accountId: params.accountId, companyId: params.companyId, scope: params.scope, heldCount },
      });
      return { status: 'ok', stopId: created.id, scope: params.scope, heldCount, pausedCount, stopRequestedCount };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface ClearStopParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly stopId: string;
  readonly at: Date;
}

export type ClearStopResult =
  | { readonly status: 'ok'; readonly stopId: string; readonly pendingReviewCount: number }
  | { readonly status: 'refused'; readonly reason: StopRefusalReason }
  | { readonly status: 'forbidden' };

/**
 * Clear a stop (ADMIN-002).
 *
 * CLEARING RESUMES NOTHING *OF ITS OWN ACCORD*, and the event carries `pending_review_count` so the record cannot
 * imply the halt was simply over.
 *
 * ⚠️ BUT THAT IS NOT YET THE SAME AS ADMIN-002'S "NOTHING AUTO-FIRES ON RESUME", AND AN EARLIER VERSION OF THIS
 * COMMENT CLAIMED IT WAS. Found by independent review: `held_work.status` is written by `reviewHeldWork` and read
 * by NOTHING. Clearing the stop row is therefore sufficient on its own for every held task's next tool call to be
 * authorized — `held`, `confirmed` and `discarded` all behave identically, so an explicit discard changes one
 * column and nothing else.
 *
 * WHERE THE ENFORCEMENT BELONGS IS ALREADY SETTLED BY CANON, not by this ticket's judgement:
 * `WORKFLOW-STATE-MACHINES.md` §4 gives `running→paused / paused→running` with actor *"system (company pause /
 * emergency stop)"*, precondition *"scope stop active"* and effect *"held visibly; resume requires review
 * (ADMIN-002)"*; `diagrams/13` ends *"CONFIRMED items resume from checkpoints"*. `paused` is already a legal task
 * state with both transitions already in `LEGAL_TRANSITIONS`. See CDR-072 §1-G7.
 */
export async function clearStop(client: DatabaseClient, params: ClearStopParams, options: StopServiceOptions = {}): Promise<ClearStopResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ClearStopResult> => {
      if (checkAuthorization(role, 'stop:clear', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') {
        return { status: 'forbidden' };
      }

      const stops = new StopRepository(scope.db);
      const existing = await stops.findById(params.stopId);
      if (existing === undefined) return { status: 'refused', reason: 'not_found' };
      if (existing.status !== 'active') return { status: 'refused', reason: 'not_active' };

      const cleared = await stops.clear(params.stopId, params.userId, params.at);
      // Guarded on `status = 'active'`, so `undefined` means a concurrent clearer won. Nothing of ours has been
      // written, so a typed refusal is safe and honest.
      if (cleared === undefined) return { status: 'refused', reason: 'not_active' };

      const pending = await stops.listHeld(params.stopId);
      await audit(scope, emergencyStopCleared({ stopId: params.stopId, scope: existing.scope, pendingReviewCount: pending.length }), auditCtx(options));
      options.logger?.warn('stop.cleared', {
        metadata: { accountId: params.accountId, companyId: params.companyId, scope: existing.scope, pendingReviewCount: pending.length },
      });
      return { status: 'ok', stopId: params.stopId, pendingReviewCount: pending.length };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface ReviewHeldWorkParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly heldWorkId: string;
  readonly decision: 'confirmed' | 'discarded';
  readonly at: Date;
}

export type ReviewHeldWorkResult =
  | { readonly status: 'ok'; readonly heldWorkId: string }
  | { readonly status: 'refused'; readonly reason: StopRefusalReason }
  | { readonly status: 'forbidden' };

/**
 * Confirm or discard ONE held item (ADMIN-002's review-to-resume).
 *
 * Rides `stop:clear`, not a separate action: deciding that held work may run again is the same authority as lifting
 * the halt that stopped it. A DISCARD is recorded exactly as loudly as a confirm — it is a decision an operator
 * made, not the absence of one, and the row is never deleted.
 *
 * THIS FUNCTION DOES NOT RESUME ANYTHING. It records the decision. Re-queueing confirmed work belongs to the task
 * state machine, and wiring it here would make "nothing auto-fires on resume" false.
 *
 * ⚠️ THAT REASONING IS RIGHT AND WAS ALSO USED TO EXCUSE THE GAP. Declining to resume here is correct — canon puts
 * the transition on the task state machine (`WORKFLOW` §4 `paused→running`, precondition review completed). What
 * was missing is the other half: NOTHING consumed `status` at all, so a `discarded` item resumed exactly like a
 * `confirmed` one the moment the stop cleared. "Belongs to the state machine" was true; "is done by the state
 * machine" was not, and the comment read as though both were. See CDR-072 §1-G7.
 */
export async function reviewHeldWork(client: DatabaseClient, params: ReviewHeldWorkParams, options: StopServiceOptions = {}): Promise<ReviewHeldWorkResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReviewHeldWorkResult> => {
      if (checkAuthorization(role, 'stop:clear', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') {
        return { status: 'forbidden' };
      }

      const stops = new StopRepository(scope.db);
      const row = await sql<{ stop_id: string; status: string; task_id: string; stop_status: string }>`
        select h.stop_id, h.status, h.task_id, s.status as stop_status
        from held_work h join emergency_stops s on s.id = h.stop_id
        where h.id = ${params.heldWorkId}::uuid
      `.execute(scope.db);
      const held = row.rows[0];
      if (held === undefined) return { status: 'refused', reason: 'not_found' };
      if (held.status !== 'held') return { status: 'refused', reason: 'already_reviewed' };
      // ORDER MATTERS, AND CANON FIXES IT. ADMIN-002 says clearing a stop *opens* the mandatory review, so a review
      // while the stop is still active is out of sequence: confirming would either resume work into a live halt, or
      // record a decision whose effect silently depends on a later clear. Refused instead of guessed.
      if (held.stop_status === 'active') return { status: 'refused', reason: 'stop_still_active' };

      const reviewed = await stops.review(params.heldWorkId, params.decision, params.userId, params.at);
      // Guarded on `status = 'held'`: a concurrent reviewer already decided this item. Their decision stands —
      // silently overwriting it would make ADMIN-002's review replaceable, which is not a decision at all.
      if (reviewed === undefined) return { status: 'refused', reason: 'already_reviewed' };

      // ── THE RESUME ITSELF (canon: WORKFLOW §4 `paused→running`; diagram 13) ───────────────────────────────
      //
      // *"CONFIRMED items resume from checkpoints"* — confirmed, not all. This is the half that did not exist:
      // `status` was written here and read by nothing, so a cleared stop resumed every task regardless, and an
      // explicit DISCARD behaved identically to a confirm.
      //
      // A DISCARD DELIBERATELY LEAVES THE TASK `paused`. It is not cancelled — canon's queue is "nothing lost", and
      // a discarded item stays visible as a reviewed decision the operator can still see. Cancelling it here would
      // be a second, unasked-for state change riding on a review.
      //
      // Guarded on `state = 'paused'`, so a task that was never running (held while `queued` or `waiting_*`, which
      // take no `paused` edge) is simply not transitioned — its own precondition already keeps it from starting.
      // FIRST WRITE HAS LANDED above, so a failure from here THROWS rather than returning a typed refusal (§1-G8).
      if (params.decision === 'confirmed') {
        await new TaskRepository(scope.db).updateState(held.task_id, 'paused', 'running');
      }

      await audit(scope, emergencyStopWorkReviewed({ stopId: held.stop_id, decision: params.decision, heldWorkId: params.heldWorkId }), auditCtx(options));
      return { status: 'ok', heldWorkId: params.heldWorkId };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

/** One scope as the read model presents it. `enforceable` is NOT decoration — see {@link readStopState}. */
export interface StopScopeAvailability {
  readonly scope: StopScope;
  readonly enforceable: boolean;
  /** Present only when the scope is inert, and states plainly that activating it is refused. */
  readonly unavailableReason?: string;
}

/**
 * How complete the held-work queue is (CDR-072 §1-G6 PM ruling, conditions 1 and 2).
 *
 * ⚠️ **THE QUEUE IS NEVER A ROSTER OF EVERYTHING A STOP COVERS.** It records what the stop actually INTERRUPTED.
 * Two distinct reasons, and a surface that showed the queue without saying so would let an operator believe they
 * had reviewed everything:
 *
 *   1. **A task that never attempts a tool call is never held.** Holding happens at the dispatcher, when a call is
 *      refused. A covered task that reaches no tool is not held and not paused — nothing interrupted it.
 *   2. **An `account_wide` stop starts with the raising company's work only.** Activation runs in one company's
 *      scope; sibling companies' items appear LAZILY, as their tasks hit the dispatcher and are refused.
 *
 * So `held_count` on the activation event is a FLOOR, not a total, and this field says which reading applies.
 */
export type HeldQueueCompleteness =
  /**
   * More items may appear as covered tasks reach the dispatcher — the count is a FLOOR. True of every scope that
   * holds anything at all.
   *
   * An earlier version of this type also offered `complete_for_scope`, claiming "no more can be added" for every
   * scope except `account_wide`. AN INDEPENDENT REVIEW FOUND THAT FALSE FOR ALL FOUR: activation holds only tasks
   * that are in flight AT THAT MOMENT, and nothing stops a task being created, planned, queued and started while
   * the stop stands — it then joins the queue when the dispatcher refuses it. The variant was deleted rather than
   * re-scoped, because a label nothing can truthfully carry is worse than no label.
   */
  | 'grows_lazily'
  /**
   * This scope never holds anything, so the queue for it is always empty. `external_actions_only` halts CALLS, not
   * tasks — internal work continues by design — so neither activation nor the dispatcher files an item under it.
   */
  | 'never_holds';

export type ReadStopStateResult =
  | {
      readonly status: 'ok';
      readonly activeStops: readonly {
        readonly stopId: string;
        readonly scope: string;
        readonly targetId: string | null;
        readonly activatedAt: Date;
        /**
         * See {@link HeldQueueCompleteness}. Intended to be rendered beside any queue count — but NOTHING ENFORCES
         * THAT, and no surface exists yet to enforce it in (the surface is an owner gate). This is a value a caller
         * may ignore. An earlier version of this comment said a surface "MUST render this", which asserted a
         * guarantee the codebase does not provide.
         */
        readonly heldQueueCompleteness: HeldQueueCompleteness;
      }[];
      readonly scopes: readonly StopScopeAvailability[];
      /**
       * The boundary in one sentence, returned as TEXT so each surface does not reinvent (and soften) it — an
       * operator reading a queue that looks exhaustive and is not is the §0 failure wearing a read model.
       *
       * IT IS SUPPLIED, NOT ENFORCED. A surface can ignore this field entirely and nothing in the codebase will
       * notice; there is no surface yet, and no check that one renders it. An earlier version of this comment said
       * the boundary "cannot be lost in translation", which is exactly the kind of guarantee-by-assertion this
       * ticket has been correcting elsewhere.
       */
      readonly heldQueueCaveat: string;
    }
  | { readonly status: 'forbidden' };

/**
 * What is halted, and which scopes can halt anything (`stop:read`; viewer-visible).
 *
 * **THE `scopes` LIST IS THE LOUD PART.** It returns all seven with `enforceable` set, and the two inert scopes
 * carry an explicit reason — because a surface that listed seven scopes without saying two do nothing would let an
 * operator believe a stop covers a capability or an integration. That is the nominal-vs-substantive failure this
 * ticket is built to avoid, and it would be introduced by a *read model*, of all things.
 *
 * NO UI IS SHIPPED. This returns the data a surface would need; building the surface is an owner gate.
 */
export async function readStopState(
  client: DatabaseClient,
  params: Pick<ActivateStopParams, 'userId' | 'accountId' | 'companyId'>,
  options: StopServiceOptions = {},
): Promise<ReadStopStateResult> {
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReadStopStateResult> => {
      if (checkAuthorization(role, 'stop:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') {
        return { status: 'forbidden' };
      }
      const active = await new StopRepository(scope.db).listActive();
      return {
        status: 'ok',
        activeStops: active.map((s) => ({
          stopId: s.id,
          scope: s.scope,
          targetId: s.target_id,
          activatedAt: s.activated_at,
          // EVERY holding scope grows lazily — activation captures only what was in flight at that instant, and
          // the dispatcher files the rest as covered tasks are refused. `external_actions_only` holds nothing at
          // all, ever, because it halts calls rather than tasks.
          heldQueueCompleteness: s.scope === 'external_actions_only' ? ('never_holds' as const) : ('grows_lazily' as const),
        })),
        heldQueueCaveat:
          'The held-work queue records what this stop INTERRUPTED, not everything it covers. A covered task that ' +
          'never attempts a tool call is never held and never paused. An account-wide stop additionally starts with ' +
          'the raising company only and gains sibling companies as their tasks are refused, so its count is a floor.',
        scopes: STOP_SCOPES.map((s) => ({
          scope: s,
          enforceable: ENFORCEABLE_STOP_SCOPES.includes(s),
          ...(NOT_YET_ENFORCEABLE_STOP_SCOPES.includes(s)
            ? { unavailableReason: 'Not enforceable in this release: the tool registry carries no identity for it, so activation is refused.' }
            : {}),
        })),
      };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

function opts(options: StopServiceOptions): { correlationId?: string; logger?: Logger } {
  return { ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }), ...(options.logger === undefined ? {} : { logger: options.logger }) };
}

function auditCtx(options: StopServiceOptions): { correlationId?: string } {
  return options.correlationId === undefined ? {} : { correlationId: options.correlationId };
}

export type { TenantScope };
