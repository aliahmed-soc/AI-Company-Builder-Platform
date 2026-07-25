# CDR-033 — Task model and state machine (ACBP-P4-002)

**Status:** Accepted (autonomous lead, standing authorization). **Requirements:** TASK-001 (task objects + server-enforced
state machine + holds). **Governing ADR:** ADR-008 (durable task/workflow execution). **Architecture:**
WORKFLOW-STATE-MACHINES §4 (task lifecycle), DATA-ARCHITECTURE §Task (company-owned `C`, mutable-with-audit `M`).
**Depends on:** P1-005 (account/company context, Done). **No open question blocks it.** No live model, no owner gate.

Establish the **Task** entity + its **server-enforced** state machine (TASK-001 "invalid transitions are rejected and
audited") + **task dependencies**. The full closed state set + the complete legal-transition map are defined NOW so every
illegal transition is rejected from day one; the EFFECTS of the execution transitions (credit reservation TASK-004, policy
evaluation, worker runs, artifact persistence) belong to later P5/P6 tickets — exactly the `interview.ts` precedent
(P2-001 defined the whole 6-state machine but implemented only the early transitions).

## 1. The closed task state set + legal transitions (WORKFLOW §4, verbatim)

States: `draft · planned · queued · running · completed⏹ · failed⏹ · cancelled⏹` plus the holds `waiting_for_input ·
waiting_for_approval · blocked_by_policy · paused`. Terminal (⏹): `completed`, `failed`, `cancelled`.

The legal-transition map is exactly WORKFLOW §4's table (server-enforced; an unlisted `(from,to)` is rejected +
auditable — TASK-001 "transition-table conformance 100%"):
`draft→planned`; `planned→queued`; `queued→{running, cancelled}`; `running→{waiting_for_input, waiting_for_approval,
blocked_by_policy, paused, completed, failed, cancelled}`; `waiting_for_input→running`; `waiting_for_approval→{running,
cancelled}`; `blocked_by_policy→running` (the documented resume "not retryable until policy/limits change");
`paused→running`. Terminals (`completed`/`failed`/`cancelled`) have no outgoing transitions.

## 2. What P4-002 IMPLEMENTS vs. defines (the interview.ts pattern)

- **Defined now (the contract, fully server-enforced):** the whole closed state set + legal-transition map + the pure
  guards (`isLegalTaskTransition`, `legalTaskSuccessors`, `isOpenTaskState`, `isTerminalTaskState`, the honest display
  projection, the redacted DTO). Unit-tested for 100% table conformance (every legal pair allowed, every illegal pair
  denied).
- **Executed now (P4-scoped, effect-free use cases):** `createTask` (mints a task in `draft`; company-scoped;
  server-resolved actor); `planTask` (`draft→planned` — the task appears on the board; audited `task.created` per the
  table's "appears on board" row); `addTaskDependency` (a Task↔Task edge; immutable; no self-dependency; same-company
  only). `cancelTask` for the pre-execution `queued→cancelled` is defined-legal but its precondition (a queued task)
  requires the credit-reserving `planned→queued` (TASK-004/P6), so it is NOT executed here.
- **Deferred (legal in the map; effects owned by later tickets):** `planned→queued` (credit reservation TASK-004 + policy
  evaluate №1, P6, in one tx); `queued→running` and all `running→*` (worker runs, P5; policy, P6); the holds' resume
  effects. Each becomes a guarded use case in the ticket that owns its effect, calling the same enforced transition.

## 3. Schema — migration 0021 (additive; two tables)

Additive (0001–0020 untouched; **no new SECURITY DEFINER** — allowlist stays three; no new role; no BYPASSRLS). Two
company-owned, dual-keyed FORCE-RLS tables (the `memory_items`/`interview_sessions` pattern):
- `tasks`: `id`, `account_id`, `company_id`, `state` (text, CHECK in the 11-value set), `title`, `description`
  (nullable, bounded), `milestone_id` (nullable — milestones are P4-001, not yet built; ad-hoc tasks have none),
  `created_by_user_id`, `created_at`, `updated_at`. **State is mutable-with-audit (`M`)**: SELECT + INSERT + a
  narrowly-scoped `UPDATE(state, updated_at)` grant (a task's state advances; `id`/`account_id`/`company_id`/`created_*`
  are immutable). Dual-keyed fail-closed RLS.
- `task_dependencies`: `id`, `account_id`, `company_id`, `task_id` (FK tasks), `depends_on_task_id` (FK tasks),
  `created_at`. **Immutable (`I`)**: SELECT + INSERT only. UNIQUE `(task_id, depends_on_task_id)`; CHECK
  `task_id <> depends_on_task_id` (no self-dependency). Dual-keyed fail-closed RLS. (A cross-company edge is impossible —
  both FKs + the dual key confine to one company.)

Every schema-reset list + the two-tenant harness `ALL_TABLES` + every catalog/grant assertion is updated in the SAME
slice (the P2-003 reset-list lesson).

## 4. Audit + authz

- **Audit (ADR-015):** `task.created` (subject = task id; metadata bounded `{has_milestone: boolean}` — never title/
  description) written in-tx with `planTask` (the board-appearance transition). The other `task.*` events (queued/
  started/completed/failed/cancelled/waiting_*) are registered by the tickets that implement their transitions
  (incremental per-ticket registration, matching the memory/understanding precedent). A future generic transition audit
  is NOT introduced here.
- **Authz:** `task:create` (create + plan) and `task:read` — checked against the caller's COMPANY-membership role. MVP
  grant: both `owner|viewer` may create/plan/read a task on the board (a task is proposed work, not yet executing; the
  RUN trigger `planned→queued` is the owner/operator gate, a later ticket). `task:depend` folds into `task:create`.
  DISTINCT closed actions; deny-by-default.

## 5. Slice plan
1. Contracts (state machine + transitions + DTO) + `task.created` audit + `task:create`/`task:read` authz + this CDR.
2. Migration 0021 (tasks + task_dependencies) + repo/schema + every reset list/catalog + real-PG RLS/privilege/lifecycle.
3. Core `createTask`/`planTask`/`addTaskDependency` + real-PG integration (transition conformance; deps; cross-tenant).
4. Docs + review + finalize.

## 6. Out of scope / deferred
Task RUNS + execution (P5); credit reservation on `planned→queued` (TASK-004/P6); policy evaluation (P6); the board UI +
detail (P4-004); planning objects (goals/roadmap/milestones, P4-001); scheduling (post-MVP). No migration 0022.
