# ACBP-P5-005 — review ledger

Two independent passes, both FAILED. Pass 1 was adversarial security/correctness; pass 2 was canon-fidelity and
scope ("does this deliver what the backlog says, and does every claim it makes hold?").

Every finding below was fixed on the branch. The pattern worth carrying forward is at the end.

## Pass 1 — adversarial security and correctness

| # | Sev | Finding | Fix |
| --- | --- | --- | --- |
| H1 | HIGH | **A worker run could become permanently UNSTOPPABLE.** `runWorkerStep` read the task run and consulted only `stop_requested_at`, never its STATE. A task run reclaimed as `worker_lost` or failed by its owner is no longer `running`, and `requestStop` is guarded on `running` — so it could never be marked again. The worker kept stepping and spending, possibly beside a retry attempt, while the WORK-006 sweep reported `stopsRequested: 0`. **Every test passed because the fixtures only ever built live task runs** — the same shape as the P5-002 pass-2 defect. `taskRun === undefined` also failed OPEN. | The checkpoint now checks the stop flag, the task run's state, and the worker's company state; absent task run fails CLOSED. Test: *"a worker run whose TASK RUN is over stops at its next step"*. Recorded as CDR-057 §1-G8. |
| M2 | MED | **The halt halted the worker run only.** The comment quoted NFR-015's *"cap breaches halt the task and alert"* while the task run was never touched — it stayed `running` with no worker until the reaper failed it as `worker_lost`, destroying the honest `policy_blocked`/`timeout` category. | The halt now requests a durable stop on the task run. The terminal transition stays P5-002's `failRun`, and CDR-057 §6 says so. |
| M3 | MED | **Disable/start write skew.** A disable committing concurrently with a start cannot see the uncommitted worker run, so that run began with nothing asking it to stop, and nothing re-read the state later. | The checkpoint re-reads the company worker state; `!workerAcceptsTasks` is a stop. |
| M4 | MED | **Double admission.** Two concurrent steps read the same spend, both found headroom, both executed — turning NFR-015's one-increment bound into N. The in-SQL increment prevents a lost update, not a double admission. | `findByIdForUpdate` takes a row lock before the decision. |
| M5 | MED | **A throwing step lost its spend entirely.** The throw propagated, rolling back the whole transaction, so a step that spent real provider money and then failed left the counter untouched — a caller retry loop could spend indefinitely without advancing toward the cap. | `try`/`catch`; the run is closed `failed`/`provider_error` and a typed `step_failed` is returned. Exception text never surfaces. |
| M6 | MED | `finishWorkerRun` checked only that a failure category was **non-empty**, while the comment claimed the P5-002 shape — which validates the VALUE. An out-of-set category reached the DB CHECK and surfaced as an internal error where a typed refusal was promised. | `isRunFailureCategory`. |
| M7 | MED | **One-directional drift guards on two of three CHECK lists.** Only the outcome list had set equality. Worse, `HaltReason` was a bare union with no runtime array, so its guard was not even constructible — a fourth reason would compile, pass, and break the halt path in production only. | `HALT_REASONS` exported as an array; set-equality guards on all three lists, plus a contract test that every reason the decision can PRODUCE is in the set. |
| L8 | LOW | A task run with a pending stop was still stamped, emitting `started` then immediately `stopped` with zero steps. | Refused at `startWorkerRun`. |
| L9 | LOW | `already_stamped` returned another worker's run under a status that reads as "you already have one". | New `stamped_by_other_worker`. |
| L10 | LOW | `spend_micros` is `integer`; an enormous reported spend raised 22003 and rolled back instead of halting. | Clamped to `MAX_STEP_SPEND_MICROS`. |

Verified clean by pass 1, with no finding: the same-transaction sweep (traced through `withAccountTransaction` —
one real transaction, `elevateToCompanyScope` reuses it), audit-metadata nulls, resolve-then-compare direction,
tenant isolation, secrets/PII in logs and errors, package boundaries, and the check ordering itself.

## Pass 2 — canon fidelity and scope

| # | Verdict | Finding | Fix |
| --- | --- | --- | --- |
| 1 | not met, SILENT | **"Resume via coordinator" had no path and no record.** CDR-057 §0 quoted COMPONENT-CATALOG's *"crash → job resume; heartbeat timeout"* and never returned to it. | Recorded in §6, including that `UNIQUE(task_run_id)` makes same-attempt resume impossible by construction (a retry is a new task run) and which ticket owns the loop. |
| 2 | not met, SILENT | **A worker run could end with no audit record at all.** `reclaimLostRuns` ended the task run without touching `worker_runs`: the run sat at `running` for ever, with no `worker.failed`, and `listRunningForWorker` returned a zombie the sweep would keep finding. | `reclaimLostRuns` now reaps the orphan as `failed`/`worker_lost` and audits it. Test asserts the sweep list is empty afterwards. |
| 3 | not met, SILENT | Same as M2. | Same. |
| 4 | OVERCLAIM ×5 | **"Every tool call goes through `dispatchToolCall`" was asserted in CDR-057 §1-G5 and §3, the module header, PROJECT-STATE and EVENT-CATALOG — and enforced nowhere.** The runtime does not import the dispatcher and nothing stops a step closure from calling a tool directly. | All five corrected to the true, narrower statement: the runtime has no tool-invocation path at all; the chokepoint is a forward obligation on P5-006/007/008. This is the "structural, not procedural" failure that failed P5-004's review, repeated in prose. |
| 5 | wrong + audit gap | §1-G6 said the sweep calls `cancelRun`; it calls `requestStop`, bypassing `cancelRun`'s audit — so N task runs got durable stops with **no `task.cancelled` record**. | The sweep emits `task.cancelled`/`running_safe_stop` per stop; §1-G6 rewritten to say what the code does and why. |
| 6 | half-recorded | §4's premise implied usage events were being written and merely lacked a run link. **None are written at all**, and `spentMicros` is caller-reported, not metered. | §6 states this plainly. |
| 7 | unproven | **`worker.*` audited — zero tests asserted an audit ROW.** Factories were unit-tested and emitted, but the suite never selected from `audit_events`; the registry guard passes unchanged if the writer is never called. P5-003b lost auditing on exactly one path this way. | Four tests assert rows, subjects, and payloads for start / halt / stop / finish, including that no key is null. |
| 8 | unproven | NFR-015's *"and alert"* was inert — no test supplied a logger. | Spy logger asserts `worker.run_halted` and its reason. |
| 9 | gap | `worker_runs` was **missing from the central grant catalog**; the local test listed forbidden columns but never the exact allowed set, so widening the grant would have passed silently. | Added to `TENANT_TABLES`, `EXPECTED_GRANTS`, and the column-privilege block with an exact-set assertion. |
| — | dead code | `isWorkerRunOutcome` / `isTerminalWorkerRunOutcome` were called only by their own unit test while the code compared bare strings and `WorkerRunDTO.outcome` was typed `string` — the P5-004 defect repeated. | Both applied: `toDTO` validates on the way out, the DTO carries the closed type, terminal checks use the guard. |
| — | correctness | **Clock-source mixing:** `Date.now() - started_at` subtracts a Postgres timestamp from a Node one; negative skew reads as an unreadable bound and halts a healthy run. | Elapsed time is computed in SQL from one clock. The duration test now uses a tiny real bound instead of an injected clock. |

## The pattern

Three tickets running, the finding has been a guard that was **written but not applied**, or a claim that was
**stated but not enforced** — `isMvpSafeAllowlist` uncalled in P5-004, `listActiveDefinitions` uncalled, and here two
closed-set guards plus a five-document chokepoint claim. The cheap check at authoring time: for every guard exported,
name its caller; for every "always"/"never" written in prose, name the line that makes it impossible to violate. If
neither exists, the sentence is a wish.

And H1 is the second time fixtures have agreed with a bug in this area. Building only live, healthy rows makes the
"what if this thing already ended" branch untestable by construction — the fixture helper should be able to produce
a *dead* one from the start.
