# CDR-053 — Workflow coordinator and task runs (ACBP-P5-002, TASK-007 / NFR-005)

Status: proposed by the implementing session. Governing ADR: **ADR-008**. Diagram: `WORKFLOW-STATE-MACHINES.md §4`.
Depends on **ACBP-P4-002** (tasks, Done) and **ACBP-P5-001** (jobs/checkpoints/retry, Done). Unblocks **P5-003b**,
which needs the run a tool call belongs to.

## 1. What this ticket owns

| Acceptance | *"Cancel queued instant; running safe-stop bounded; timeout works"* |
|---|---|
| In scope | The `task_runs` entity; queue→run→terminal orchestration; heartbeats and the bounded grace; cancellation and safe-stop |
| Out of scope | The policy engine and approval decisions (**P6-001/P6-004** — this provides the hold *mechanism*, not the policy); the tool dispatcher (**P5-003b**); worker process management |

## 2. Load-bearing reading — a RUN's states are not a TASK's states

This is the one place canon can be misread, so it is settled here explicitly.

> "Task run | C | run_id, task_id, attempt | … | **queued→running→succeeded/failed/cancelled**" — `DATA-ARCHITECTURE`
> "Task | … | see **WORKFLOW-STATE-MACHINES §4**" — same table, different row

§4's transition table lists `running→waiting_for_input`, `running→waiting_for_approval`, `running→blocked_by_policy`,
`running→paused` — and every one of them **emits a `task.*` event** and describes a Decision Room item. Those are
**TASK** states, already owned by P4-002's `tasks.state`. The RUN has the five-state lifecycle
`DATA-ARCHITECTURE` gives it.

- **G1 — a run is ONE EXECUTION ATTEMPT of a task**, which is why `attempt` is part of its identity. A task that is
  retried has several runs; a task that is waiting for approval has a task-level hold and, depending on the outcome,
  a run that ended or one that never started. Collapsing the two would make "which attempt failed?" unanswerable.
- **G2 — the coordinator drives BOTH but owns only the run.** Task-state transitions remain P4-002's
  `transitionTask`, called by the coordinator. This ticket adds no task state and changes no task grant.
- **G3 — holds are a MECHANISM here, a POLICY in P6.** The backlog's "queue→run→**holds**→terminal" and "Holds for
  approval/policy (**P6 wires**)" together mean: P5-002 must make it possible for a run to end because something
  external said stop, without deciding what that something is.

## 3. Heartbeats, timeout and safe-stop

> "Heartbeat loss > grace → run `running→failed(worker_lost)` or resume from checkpoint if job intact" — row 4
> "Timeout rule: heartbeat-lost runs transition `running→failed` with category `worker_lost` after **bounded grace**"
> "running→cancelled ⏹ | owner (stop request) | **safe-stop**: current tool call completes/aborts safely, then halt" — §4

- **G4 — liveness is a TIMESTAMP the worker advances, not a background timer.** `last_heartbeat_at` plus a bounded
  grace makes "is this run lost?" a pure comparison any reader can make, and it is correct even if the process that
  would have fired a timer is the one that died. A timer-based design cannot detect the failure it exists to detect.
- **G5 — "cancel queued instant" and "running safe-stop bounded" are DIFFERENT operations**, and the acceptance
  clause names both. A queued run has not started, so cancellation is immediate and total. A running run is mid-flight,
  so cancellation REQUESTS a stop and the worker halts at its next safe point. Modelling both as one "cancel" would
  either make queued cancellation slow or make running cancellation unsafe.
- **G6 — a stop request is recorded, not merely signalled.** `stop_requested_at` is durable, so a worker that was
  briefly unreachable still sees the request when it returns, and an owner who asked twice gets one answer.

## 4. Shape

| Element | Shape |
| --- | --- |
| `task_runs` | Company-owned, dual-keyed FORCE RLS. `UNIQUE(task_id, attempt)` — an attempt number is claimed once. |
| states | CLOSED: `queued · running · succeeded · failed · cancelled`. Declared in full up front (the CDR-049 §4-G6 precedent). |
| `failure_category` | Nullable, CLOSED set including `worker_lost`. One-directional CHECK against the terminal state — the P5-009/P5-001c lesson. |
| `last_heartbeat_at` | Nullable; set when running. Compared against a bounded grace by a pure contract function. |
| `stop_requested_at` | Nullable; durable safe-stop request (G6). |
| grants | SELECT + INSERT + a column-scoped UPDATE of exactly the lifecycle columns. **No DELETE** — a run is the record of an attempt. |

## 5. Slice plan

1. CDR-053 + branch + draft PR.
2. Contracts: run states, the transition table, `isRunLost`, safe-stop classification — TDD, pure.
3. Migration 0035 `task_runs` + repository + the reset-list sweep (the guard now enforces it); real-PG.
4. Core `startRun` / `heartbeatRun` / `completeRun` / `cancelRun` + real-PG proof of the three acceptance clauses.
5. Docs + **TWO** independent review passes + finalization.

## 6. Review outcomes (both passes FAILED; see `docs/implementation/P5-002-REVIEW.md`)

- **G7 — a run is never started for a task that is not live.** `startRun` reads through `findLive`, so a task the
  owner DELETED can never acquire an execution attempt. Deletion is recorded in `task_deletions` and the task row
  survives (there is no DELETE grant), so a raw id lookup finds discarded work and would start executing it. A deleted
  task answers `task_not_found` — the same answer a foreign task gets, so the refusal is not an existence oracle.
- **G8 — a run is never started for a task that cannot be executing.** `canStartRunForTask` is DERIVED from canon's
  own task transition table: startable means the task is already `running` (a retry attempt while the task stays
  running) or can legally reach `running`. `completed`/`failed`/`cancelled`/`draft`/`planned` are refused
  with `task_not_startable`. Deriving rather than restating means the rule cannot go stale when a task state is added.
- **G9 — a missed cancellation guard is answered honestly, never as `already_terminal`.** If a queued run is picked
  up between the read and the guarded write, `cancelRun` re-reads and the request becomes a safe-stop. Reporting
  `already_terminal` would tell an owner their stop landed on finished work while the work carried on.