// @acbp/core — Decision Room read use case (ACBP-P6-008; CDR-076; DEC-001, ACT-003/004; invariant 20). API-only.
//
// Composes the ten DEC-001 queues from surfaces that already exist, under the caller's validated CompanyScope:
// active company membership required, `decision_room:read` gates entry, and every query is RLS-confined to the
// current account + company.
//
// THE TWO MECHANISMS THAT MAKE THIS SURFACE HONEST (CDR-076 §0):
//
//  1. ONE SNAPSHOT, TEN SAVEPOINTS. All sections read inside ONE transaction, so their counts are mutually
//     consistent and `asOf` means something. But a plain try/catch around each section inside one transaction is
//     a trap: PostgreSQL aborts the whole transaction on the first failed statement, so ONE broken section would
//     leave the other NINE erroring too — and nine sections reporting nothing renders exactly like a calm day.
//     Each section therefore runs between a SAVEPOINT and its release; a failing section rolls back to its own
//     savepoint, is marked `unavailable`, and the remaining nine keep their snapshot.
//
//  2. AUTHORIZATION IS DECIDED BEFORE THE QUERY, NEVER CAUGHT AFTER IT. A section the caller may not read is
//     `restricted` — a different answer from `unavailable`, and neither is an empty queue. Failure to resolve the
//     COMPANY SCOPE itself is not degraded at all: it fails the whole request, because that is the tenant
//     boundary and a partial page there would be a fail-open.
import { sql } from 'kysely';
import { DecisionRoomRepository, type DatabaseClient, type DecisionRoomList } from '@acbp/database';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  DECISION_ROOM_ITEM_CAP,
  DECISION_ROOM_QUEUES,
  decisionRoomDigest,
  microsecondEpochToIso,
  nonAnsweringSection,
  okSection,
  type AuthzAction,
  type DecisionRoomItem,
  type DecisionRoomQueue,
  type DecisionRoomSection,
  type DecisionRoomUsage,
  type DecisionRoomView,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

export interface ReadDecisionRoomParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

export interface ReadDecisionRoomOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /**
   * TEST SEAM (CDR-076 §5 claim 3). Names the queues whose read must throw, so the savepoint isolation above can
   * be PROVEN rather than reasoned about: the suite forces one section to fail and asserts the other nine still
   * answer. Ignored unless it names a queue; there is no production caller.
   */
  readonly failSectionsForTest?: readonly DecisionRoomQueue[];
}

export type ReadDecisionRoomResult = { readonly status: 'ok'; readonly room: DecisionRoomView } | { readonly status: 'forbidden' };

/** Sample size per section: one more than the cap is never fetched — the true total comes from the window count. */
const SAMPLE = DECISION_ROOM_ITEM_CAP;

function detail(entries: Record<string, string | number | boolean | null | undefined>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(entries)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

const iso = (d: Date): string => new Date(d).toISOString();

/**
 * Merge several sources into one queue: concatenate the samples, order newest-first, cap, and SUM the true
 * totals. Summing the pre-LIMIT totals (rather than counting the merged sample) is what keeps a queue's count
 * honest when one of its sources is far larger than the cap.
 */
function merge(queue: DecisionRoomQueue, lists: ReadonlyArray<{ readonly items: readonly DecisionRoomItem[]; readonly total: number }>): DecisionRoomSection {
  const items = lists
    .flatMap((l) => l.items)
    .sort((a, b) => (a.occurredAt === b.occurredAt ? (a.id < b.id ? 1 : -1) : a.occurredAt < b.occurredAt ? 1 : -1));
  return okSection(queue, items, lists.reduce((sum, l) => sum + l.total, 0));
}

function mapped<T>(list: DecisionRoomList<T>, fn: (row: T) => DecisionRoomItem): { readonly items: readonly DecisionRoomItem[]; readonly total: number } {
  return { items: list.rows.map(fn), total: list.total };
}

/**
 * Read the Decision Room. Owner|viewer company members only (a non-member is denied at scope resolution → coarse
 * `forbidden`). Always returns all ten queues; a section the caller may not read is `restricted`, and a section
 * whose read failed is `unavailable` — never an empty queue in either case.
 */
export async function readDecisionRoom(client: DatabaseClient, params: ReadDecisionRoomParams, options: ReadDecisionRoomOptions = {}): Promise<ReadDecisionRoomResult> {
  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReadDecisionRoomResult> => {
      const audit = { accountId: params.accountId, actorId: params.userId };
      if (checkAuthorization(role, 'decision_room:read', audit, options).kind === 'deny') return { status: 'forbidden' };

      /** Per-section domain authority, decided up front — never inferred from a query outcome. */
      const may = (action: AuthzAction): boolean => checkAuthorization(role, action, audit, options).kind === 'allow';
      const mayReadApprovals = may('approval:read');
      const mayReadStops = may('stop:read');
      const mayReadUsage = may('usage:read');

      // The single snapshot instant: the DATABASE read timestamp of this transaction, never application
      // wall-clock. It is `asOf` AND the `now` every expiry predicate is evaluated against, so no two sections
      // can disagree about whether an approval has expired.
      const ts = await sql<{ us: string; now: Date }>`select (extract(epoch from now()) * 1000000)::bigint::text as us, now() as now`.execute(scope.db);
      const asOf = microsecondEpochToIso(ts.rows[0]?.us);
      const now = ts.rows[0]?.now;
      if (asOf === null || now === undefined) throw new Error('decision room: database read timestamp unavailable');

      const repo = new DecisionRoomRepository(scope.db, params.companyId);
      const failFor = new Set(options.failSectionsForTest ?? []);

      /**
       * Run one section between a SAVEPOINT and its release. On failure: roll back to the savepoint (which keeps
       * the enclosing transaction usable for the remaining sections) and report `unavailable`.
       *
       * The savepoint name is derived from the CLOSED queue set and rendered as a quoted identifier — no caller
       * input reaches it. The error itself is deliberately NOT logged or returned: a database error message can
       * carry row values, and this surface is read by a tenant.
       */
      const section = async (queue: DecisionRoomQueue, authorized: boolean, read: () => Promise<DecisionRoomSection>): Promise<DecisionRoomSection> => {
        if (!authorized) return nonAnsweringSection(queue, 'restricted');
        const name = sql.id(`drq_${queue}`);
        await sql`savepoint ${name}`.execute(scope.db);
        try {
          if (failFor.has(queue)) throw new Error('decision room: forced section failure (test seam)');
          const result = await read();
          await sql`release savepoint ${name}`.execute(scope.db);
          return result;
        } catch {
          await sql`rollback to savepoint ${name}`.execute(scope.db);
          options.logger?.warn('decision_room.section_unavailable', { metadata: { queue } });
          return nonAnsweringSection(queue, 'unavailable');
        }
      };

      const approvalItem = (kind: 'approval_request'): ((r: {
        id: string;
        action: string;
        risk_class: string;
        scope: string;
        estimated_cost_credits: number;
        created_at: Date;
        expires_at: Date;
      }) => DecisionRoomItem) => {
        return (r) => ({
          id: r.id,
          kind,
          title: r.action,
          // PROPOSED, always (ACT-003): an approval request describes an action that has NOT happened. Marking it
          // any other way is the hollow-success failure one surface over.
          state: 'proposed',
          occurredAt: iso(r.created_at),
          detail: detail({ riskClass: r.risk_class, scope: r.scope, estimatedCostCredits: r.estimated_cost_credits, expiresAt: iso(r.expires_at) }),
        });
      };

      const taskItem = (state: 'proposed' | 'executed') => (r: { id: string; title: string; state: string; task_type: string | null; priority: number | null; updated_at: Date }): DecisionRoomItem => ({
        id: r.id,
        kind: 'task',
        title: r.title,
        state,
        occurredAt: iso(r.updated_at),
        detail: detail({ taskState: r.state, taskType: r.task_type, priority: r.priority }),
      });

      // ── The ten queues ──────────────────────────────────────────────────────────────────────────────────────
      const sections: DecisionRoomSection[] = [];

      sections.push(
        await section('needs_your_decision', mayReadApprovals || mayReadStops, async () => {
          // Two sources, and a caller may hold only one of the two authorities. Each contributes only when its
          // own action allows it — the section is `ok` for what it may read rather than all-or-nothing.
          const approvals = mayReadApprovals ? mapped(await repo.pendingApprovals(now, SAMPLE), approvalItem('approval_request')) : { items: [], total: 0 };
          const held = mayReadStops
            ? mapped(await repo.heldWork(SAMPLE), (r) => ({
                id: r.id,
                kind: 'held_work' as const,
                title: r.title,
                state: 'proposed' as const,
                occurredAt: iso(r.held_at),
                detail: detail({ taskId: r.task_id }),
              }))
            : { items: [], total: 0 };
          return merge('needs_your_decision', [approvals, held]);
        }),
      );

      sections.push(
        await section('recommended_next_actions', true, async () => {
          const planned = await repo.plannedTasksByPriority(SAMPLE);
          // Planning RANK order, not recency — so the sample is the work the planner put first, not the work it
          // wrote last. `merge` would re-sort by time, so this section builds its own section directly.
          return okSection('recommended_next_actions', planned.rows.map(taskItem('proposed')), planned.total);
        }),
      );

      sections.push(
        await section('questions_from_ai', true, async () => {
          const open = await repo.openInterviewQuestions(SAMPLE);
          return okSection(
            'questions_from_ai',
            open.rows.map((r) => ({
              id: r.id,
              kind: 'interview_question' as const,
              title: r.prompt,
              state: 'proposed' as const,
              occurredAt: iso(r.created_at),
              detail: detail({ position: r.position, source: r.source }),
            })),
            open.total,
          );
        }),
      );

      sections.push(
        await section('options_under_consideration', true, async () => {
          const generationId = await repo.latestUndecidedGenerationId();
          if (generationId === null) return okSection('options_under_consideration', [], 0);
          const options_ = await repo.optionsForGeneration(generationId, SAMPLE);
          return okSection(
            'options_under_consideration',
            options_.rows.map((r) => ({
              id: r.id,
              kind: 'strategy_option' as const,
              // The 16-field content standard is a validated map; only the option's own description is surfaced
              // here, and only as a title. The full option is read through the strategy surface.
              title: r.fields['description'] ?? `Option ${r.ordinal + 1}`,
              state: 'proposed' as const,
              occurredAt: iso(r.created_at),
              detail: detail({ ordinal: r.ordinal }),
            })),
            options_.total,
          );
        }),
      );

      sections.push(
        await section('approved_and_queued', true, async () => {
          const queued = mapped(await repo.tasksByStates(['queued'], SAMPLE), taskItem('proposed'));
          const authorized_ = mayReadApprovals ? mapped(await repo.decidedUnconsumedApprovals(now, SAMPLE), approvalItem('approval_request')) : { items: [], total: 0 };
          return merge('approved_and_queued', [queued, authorized_]);
        }),
      );

      sections.push(
        await section('executing', true, async () => {
          const running = await repo.tasksByStates(['running'], SAMPLE);
          return okSection('executing', running.rows.map(taskItem('proposed')), running.total);
        }),
      );

      sections.push(
        await section('results', true, async () => {
          // INVARIANT 20. The repository's evidence predicate means an unevidenced completion cannot appear here
          // at all; `executed` is therefore a marking the data has already earned, not one this code asserts.
          const done = await repo.completedTasksWithRunEvidence(SAMPLE);
          return okSection(
            'results',
            done.rows.map((r) => ({
              ...taskItem('executed')(r),
              detail: detail({ taskState: r.state, taskType: r.task_type, artifactCount: Number(r.artifact_count) }),
            })),
            done.total,
          );
        }),
      );

      sections.push(
        await section('blocked_work', true, async () => {
          // The four HOLD states (contracts `isTaskHold`) — work that exists, is not finished, and is not moving.
          const holds = mapped(await repo.tasksByStates(['waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused'], SAMPLE), taskItem('proposed'));
          const held = mayReadStops
            ? mapped(await repo.heldWork(SAMPLE), (r) => ({
                id: r.id,
                kind: 'held_work' as const,
                title: r.title,
                state: 'proposed' as const,
                occurredAt: iso(r.held_at),
                detail: detail({ taskId: r.task_id }),
              }))
            : { items: [], total: 0 };
          return merge('blocked_work', [holds, held]);
        }),
      );

      sections.push(
        await section('failed_work', true, async () => {
          const failed = await repo.failedTasks(SAMPLE);
          return okSection(
            'failed_work',
            failed.rows.map((r) => ({
              ...taskItem('proposed')(r),
              // A failed task is not an executed fact; the CLOSED failure category is the evidence, never
              // worker exception text.
              detail: detail({ taskState: r.state, failureCategory: r.latest_failure_category }),
            })),
            failed.total,
          );
        }),
      );

      sections.push(
        await section('recent_decisions', true, async () => {
          const strategy = mapped(await repo.recentStrategyDecisions(SAMPLE), (r) => ({
            id: r.id,
            kind: 'strategy_decision' as const,
            title: `Strategy decision (${r.mode})`,
            state: 'executed' as const,
            occurredAt: iso(r.created_at),
            detail: detail({ mode: r.mode }),
          }));
          const approvals = mayReadApprovals
            ? mapped(await repo.recentApprovalDecisions(SAMPLE), (r) => ({
                id: r.id,
                kind: 'approval_decision' as const,
                title: r.action,
                state: 'executed' as const,
                occurredAt: iso(r.decided_at),
                detail: detail({ path: r.path, deciderType: r.decider_type }),
              }))
            : { items: [], total: 0 };
          return merge('recent_decisions', [strategy, approvals]);
        }),
      );

      // ── Integrity + usage ───────────────────────────────────────────────────────────────────────────────────
      // The completions the evidence predicate excluded. Savepointed like a section: an unavailable count is
      // `null`, never 0 — "no integrity problem" and "could not check" are not the same statement.
      let unverifiedCompletions: number | null = null;
      await sql`savepoint drq_integrity`.execute(scope.db);
      try {
        unverifiedCompletions = await repo.unverifiedCompletionCount();
        await sql`release savepoint drq_integrity`.execute(scope.db);
      } catch {
        await sql`rollback to savepoint drq_integrity`.execute(scope.db);
        options.logger?.warn('decision_room.integrity_unavailable', {});
      }

      let usage: DecisionRoomUsage = { status: 'restricted', figures: null };
      if (mayReadUsage) {
        await sql`savepoint drq_usage`.execute(scope.db);
        try {
          const totals = await repo.companyUsageTotals();
          await sql`release savepoint drq_usage`.execute(scope.db);
          usage = {
            status: 'ok',
            figures: { eventCount: totals.eventCount, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, estimatedCostMicros: totals.estimatedCostMicros },
          };
        } catch {
          await sql`rollback to savepoint drq_usage`.execute(scope.db);
          options.logger?.warn('decision_room.usage_unavailable', {});
          usage = { status: 'unavailable', figures: null };
        }
      }

      const integrity = { unverifiedCompletions };
      const ordered = DECISION_ROOM_QUEUES.map((q) => sections.find((s) => s.queue === q)).filter((s): s is DecisionRoomSection => s !== undefined);
      return { status: 'ok', room: { sections: ordered, integrity, usage, asOf, digest: decisionRoomDigest(ordered, integrity, usage) } };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
