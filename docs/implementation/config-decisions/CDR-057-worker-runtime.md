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
- **G5 — the runtime has NO TOOL-INVOCATION PATH.** *Corrected after review pass 2, which found the original wording
  ("every tool call goes through `dispatchToolCall`") asserted in five documents and enforced in none.* This module does
  not call the dispatcher, and nothing here structurally stops a step closure from calling a tool directly. The true
  statement today is narrower: the runtime never reaches a tool because it has no way to. Routing every worker tool
  call through the chokepoint (invariant 4) is a **forward obligation on P5-006/007/008**, not a guarantee this ticket
  delivers — and saying otherwise would be exactly the "structural, not procedural" claim that failed P5-004's review.
- **G6 — WORK-006's failure clause is CLOSED.** *"Disable during execution triggers safe-stop per TASK-007."* With the
  stamp in place, `setCompanyWorkerState` finds this worker's live runs and requests a durable stop on each, in the same
  transaction as the state change. It calls `TaskRunRepository.requestStop` rather than P5-002's `cancelRun` — the
  sweep's authority is `worker:control`, already checked, and `cancelRun` would re-check `run:cancel` per run — **and it
  emits the same `task.cancelled` / `running_safe_stop` audit event `cancelRun` emits.** The first version did not, and
  set durable stops on N runs with no record of them; that was a review finding, not a design choice.
- **G7 — a safe-stop is REQUESTED, never forced.** A running run gets a durable `stop_requested_at`; the worker halts at
  its next checkpoint. Killing mid-call is what §4 of `WORKFLOW-STATE-MACHINES` forbids.
- **G8 — a run must never become UNSTOPPABLE.** *Added after review pass 1 found it violated.* Every checkpoint checks
  three things, not one: the stop flag, the **task run's state**, and the **worker's current company state**. A task run
  already reclaimed or failed can never be `requestStop`-ed again (that guard is `running`-only), so a worker keyed only
  to the flag would have kept spending while the sweep reported reaching nothing. An absent task run fails CLOSED.

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
budget and duration checks. **Not with the tool chokepoint** — see G5; there is no tool path here to bracket.

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

## 6. What was built, and what it did NOT settle

Built as designed. Three things are worth recording because they were decided while building, not before:

- **`stopped` is a fourth run outcome.** Canon's worker events are `started / completed / failed` and its task state
  machine already calls a stop-requested halt `cancelled`, not `failed`. A safe-stop therefore files under
  `worker.completed` carrying `run_outcome: 'stopped'` — not `worker.failed`, because the run did what the owner asked
  and counting it as a malfunction would misreport every deliberate intervention; and not silently as a completion
  either, because the payload names which of the two it was.
- **The safe-stop sweep runs INSIDE the state-change transaction.** A disable that committed while its stops did not
  would leave an owner looking at a disabled worker that is still working — precisely the failure the control exists to
  prevent. The stop is *requested*, never forced: it is durable on the task run and the worker honours it at its next
  checkpoint, because killing a call mid-flight is how a half-performed external action happens.
- **The MVP boundary is re-checked at `startWorkerRun`,** not only at allowlist resolution. Checking only in the read
  path would leave the enforcement one caller away from being skipped, and this is the moment work actually begins.

**Not settled here, and deliberately left alone:**

- **METERING IS NOT DONE, and §4 originally understated the gap.** §4 says `usage_events` carries no run link, which
  implies usage events are being written for worker work and merely lack one. They are not: **no usage event is emitted
  for a worker run at all**, this runtime never traverses diagram 07's dispatcher→ledger edge, and `spentMicros` is
  whatever the caller's step closure self-reports — not a metered figure. `worker_runs.spend_micros` is an *enforcement*
  counter and must not be read as a reconciliation or billing source. Per-call attribution stays P5-014's.
- **CRASH RESUME AND HEARTBEAT for worker runs are UNMET.** COMPONENT-CATALOG gives this component *"crash → job resume;
  heartbeat timeout"*, quoted in §0 and then never returned to — review pass 2's finding. There is no `resumeWorkerRun`,
  no heartbeat column, and `UNIQUE(task_run_id)` makes resuming the *same* attempt impossible by construction (a retry
  is a new task run, which is the intended shape). What P5-005 does provide is that a crashed run no longer leaks: when
  `reclaimLostRuns` fails the task run, it now closes the orphaned worker run as `failed`/`worker_lost` and audits it,
  so no run sits at `running` for ever polluting the safe-stop sweep. Resume itself belongs to the ticket that gives
  the coordinator a worker-driven execution loop (P5-006 onward).
- **THE TASK-LEVEL TERMINAL TRANSITION stays the coordinator's.** On a budget or duration halt this runtime requests a
  durable stop on the task run — so NFR-015's *"halt the task"* is real and the task is not left running with no worker
  — but the terminal `failed` transition remains P5-002's `failRun`, driven by the caller.
- **IOQ-12's interim budgets** (0.50 USD-equivalent, 10 minutes) still ride as documented placeholders, not
  owner-ratified values (CDR-056 §3). This ticket enforces whatever those columns say; it does not bless the numbers.
- **The third risk class** — canon names it plain `external`, the shipped set splits it into `external_reversible`.
  Flagged in CDR-051 §0.3, untouched here, and left for the owner to rule on separately.
