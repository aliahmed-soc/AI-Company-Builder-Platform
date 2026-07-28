# CDR-057 — The worker runtime: one shared executor, budgeted and haltable (ACBP-P5-005)

**Status:** proposed · **Ticket:** ACBP-P5-005 · **Requirements:** WORK-001…006, NFR-015 · **ADR:** 012 · **Trust-critical:** #3 · **Depends on:** P5-002 (runs), P5-003 (dispatcher), P5-004 (definitions) — all complete

| | |
| --- | --- |
| In scope | The `worker_runs` entity — the **stamp** that links a task run to the worker executing it; budget and duration enforcement with an honest halt; the `worker.*` events; **closing WORK-006's safe-stop clause**, recorded as unmet in `CDR-056 §6` |
| Out of scope | The three MVP workers' prompts and logic (P5-006/007/008); per-call **ledger attribution** (P5-014 — see §4); artifact persistence (P5-011); the policy and approval engines (Phase 6) |

## 0. What canon fixes

`COMPONENT-CATALOG` calls this *"Executes worker definitions … under tenant context"*, data object **worker runs**,
trust *"Trusted (least-priv creds)"*, failure *"Crash → job resume; heartbeat timeout"*.

Diagram `07-worker-execution` hands the runtime a job carrying `worker_id@version` — the worker identity travels
**with the work**, which is precisely the link `CDR-056 §6` recorded as missing.

`EVENT-CATALOG` names three events with a `worker_run_id`, and `DATA-ARCHITECTURE`'s entity table says a **Task run
*has* a Worker run**. So a worker run is its own entity, not a pair of columns on `task_runs` — and this record follows
canon rather than the cheaper shape.

NFR-015 is the sharp one: *"a runaway task cannot exceed its budget by more than **one billing increment**"*, failing
with *"Cap breaches halt the task and alert."*

## 1. Guarantees

- **G1 — a worker run is the STAMP, and it is a real entity.** `worker_runs` is a child of `task_runs`, carrying
  `worker_id` + `worker_version` and a tenant-pinned composite FK. `UNIQUE(task_run_id)`: one worker executes one
  attempt. A retry is a *new task run*, so this constraint never blocks a retry — and it is the constraint that would
  have to relax first if a run ever needed two workers.
- **G2 — the definition is SNAPSHOT onto the run.** `max_spend_micros`, `max_duration_ms` and the resolved
  `worker_version` are copied at start, not re-read. Re-reading would let a definition edited mid-flight change the
  budget a run is being judged against, and the record would no longer say what was actually enforced.
- **G3 — the budget is checked BEFORE each step, never after.** That is what makes NFR-015's *"no more than one
  billing increment"* true: the overshoot is bounded by the single call that crossed the line, because the next one is
  refused. Checking afterwards would bound nothing.
- **G4 — a breach HALTS, and halts honestly.** Budget breach ⇒ the run fails with `policy_blocked`; duration overrun ⇒
  `timeout`, which is the category `FAILURE-AND-RECOVERY` and the backlog both name. Neither is reported as success,
  and neither silently continues.
- **G5 — the runtime never executes a tool itself.** Every tool call goes through `dispatchToolCall`. The chokepoint is
  only a chokepoint if the component doing the work cannot go around it (invariant 4).
- **G6 — WORK-006's failure clause is CLOSED.** *"Disable during execution triggers safe-stop per TASK-007."* With the
  stamp in place, disabling a worker can find its live runs and call P5-002's `cancelRun`, which already implements the
  bounded safe-stop TASK-007 describes. This is the debt `CDR-056 §6` recorded, and it is paid here.
- **G7 — a safe-stop is REQUESTED, never forced.** `cancelRun` on a running run sets a durable `stop_requested_at`; the
  worker halts at its next checkpoint. Killing mid-call is what §4 of `WORKFLOW-STATE-MACHINES` forbids.

## 2. Shape

| Element | Shape |
| --- | --- |
| `worker_runs` | Company-owned, dual-keyed FORCE RLS. `UNIQUE(task_run_id)`. Tenant-pinned composite FK to `task_runs`. |
| snapshot | `worker_version`, `max_spend_micros`, `max_duration_ms` — copied at start (G2). |
| counters | `spend_micros`, `steps_completed` — the ENFORCEMENT counters the runtime advances. |
| lifecycle | `started_at`, `ended_at`, `outcome` (`running · succeeded · failed · stopped`), `failure_category`. |
| grants | SELECT + INSERT + a column-scoped UPDATE of the counters and lifecycle. **No DELETE** — a worker run is the record that a worker executed. |

## 3. The step seam

The runtime executes **steps** supplied by the caller, because no worker logic exists yet (P5-006/007/008) and no live
provider has ever been called. A step is a function returning `{ spentMicros }`; the runtime brackets each one with the
budget and duration checks and the tool chokepoint.

That is not a placeholder for its own sake: it is the seam that makes **G3 and G4 provable today**, against a real
database, without a provider. A budget halt asserted through a fake provider would prove the fake.

## 4. Per-call ledger attribution is DEFERRED, and here is exactly why

`usage_events` — the model-call ledger from P2-003 — is company-scoped and carries **no run link**. So today nothing
can sum "what did *this run* spend" from the ledger.

The runtime therefore enforces against **its own counter** on `worker_runs`, which it advances as it goes. That counter
is sufficient for enforcement (it is what the runtime actually spent) but it is **not** a reconciliation source, and
NFR-015's second clause — *"spend dashboards reconcile with provider bills"* — needs the ledger link.

Adding `usage_events.worker_run_id` belongs to **P5-014 (run preflight and credit ledger core)**, the ticket that owns
the ledger, for two reasons: the column is only useful once the gateway threads the id through its meter call, and
P5-014 is where preflight reservation makes that threading load-bearing rather than decorative.

Recorded here rather than left silent, on the P5-004 §6 precedent: *an unmet clause nobody wrote down is
indistinguishable from one nobody noticed.*

## 5. Slice plan

1. CDR-057 + branch + draft PR.
2. Contracts: worker-run outcomes, the budget/duration decision functions — TDD, pure.
3. Migration 0040 `worker_runs` + repository + the reset-list sweep; real-PG.
4. Core `startWorkerRun` / `runWorkerStep` / `finishWorkerRun`, and the WORK-006 safe-stop wiring; real-PG proof of the
   budget halt, the duration halt, and disable-during-execution.
5. Docs + **TWO** independent review passes + finalization.
