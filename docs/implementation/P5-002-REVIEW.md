# ACBP-P5-002 — independent review record

Two full independent passes. **Both returned FAIL.** Design consequences are recorded in `CDR-053`.

---

## Pass 1 — the use cases

### HIGH-1 — `cancelRun` could tell an owner "already terminal" about a *running* run

`cancelRun` reads the run, classifies the cancellation, and for a `queued` run issues a guarded
`queued → cancelled` UPDATE. If the run is picked up by a worker in the window between the read and the write, the
guard matches nothing. The old code answered `already_terminal` there.

That is the worst available wrong answer. `already_terminal` means *"there was nothing left to stop"* — so an owner
who asked to stop a run is told their request landed on work that had already finished, while the work is in fact
still going. The owner walks away; the AI keeps acting. Every other race in this module resolves toward "report what
actually happened"; this one reported the opposite.

**Fix.** Re-read on a missed guard and answer honestly. A run found `running` falls through to the safe-stop path —
which is exactly what the owner would have got had they asked a moment later, and is what they actually want: the
work stopped.

**Proof.** The interleaving is reproduced with a **row lock**, not a sleep. A held-open transaction moves the run to
`running` without committing, so under READ COMMITTED `cancelRun`'s read still sees `queued` while its guarded UPDATE
blocks on the lock; committing releases it, PostgreSQL re-checks the predicate against the new row version, and the
guard misses. Deterministic, every time. The helper polls `pg_locks`/`pg_blocking_pids` and **throws if nothing ever
blocks**, so the test cannot quietly degrade into proving the ordinary running-cancel path.

### MEDIUM-1 — `startRun` had no typed refusal for a bad attempt or a foreign task

Both surfaced as raw constraint errors — the `attempt >= 1` CHECK and the composite task FK — which reach a caller as
an opaque 500 rather than something actionable. Now `invalid_attempt` and `task_not_found`. The task probe is
RLS-confined, so a foreign task reads as absent and the refusal is not an existence oracle.

### LOW-1 — an unreachable branch returned a false status

The post-claim `queued → running` transition returned `attempt_taken` if it missed. That branch is genuinely
unreachable: the row was created moments earlier in the same transaction, so nothing else can have moved it. The
status would therefore have been a false statement about a row sitting in `queued`. It now throws, which rolls the
claim back and leaves no half-started run. A wrong answer to an impossible question is worse than a loud failure.

---

## Pass 2 — the whole slice, against the fixed tree

### HIGH-2 — `startRun` would begin executing a task the owner had DELETED

`tasks` has no DELETE grant, so a deleted task's row physically survives and the deletion lives in `task_deletions`.
The probe added in pass 1 was a raw `selectFrom('tasks')` — `findById` semantics. `TaskRepository`'s own docstring
says it plainly: *no product read may use `findById`*; every use case that answers a user question reads through
`findLive`.

So: the owner deletes a queued task, a coordinator calls `startRun`, the attempt is claimed, the run goes to
`running`, and `task.started` is emitted. **The AI begins executing work the owner explicitly discarded** — and the
deletion, which the owner performed precisely to stop it, has no effect on the one component that starts work.

**Fix.** Read through `findLive`. A deleted task is `task_not_found` — the same answer a foreign task gets, so the
refusal is not an existence oracle either.

### HIGH-3 — a run could be started for a task in *any* state

The same probe accepted `completed`, `failed`, `cancelled`, `draft` and `planned`. A run **is** one execution attempt
of a task; there is no attempt to make at finished work, and no worker was ever asked to run a draft.

**Fix.** New contract `canStartRunForTask`, **derived from canon's own task transition table** rather than restated as
a list: startable means the task is already `running` (a retry attempt while the task itself stays running) or can
legally reach `running` from where it is. A hand-copied set would silently go wrong the day a twelfth task state is
added; a derived one cannot. Refusal is `task_not_startable` with the state, so a caller can say *why* instead of
retrying forever against a task that will never be startable.

### How both hid — worth recording

**Every P5-002 test started runs against `draft` tasks.** `createTask` mints a draft and nothing in the suite moved it
on, so the tests agreed with the bug: the happy path only worked *because* the check was missing. This is the second
time on this ticket that a test has accommodated a defect rather than catching it (see the P5-001c note on
`toBeLessThanOrEqual(maxAttempts + 5)`), and both times the tell was the same — a fixture that was convenient rather
than realistic.

`newTask` now returns a **queued** task (draft → planned → queued), which is the state a coordinator actually picks up
from, and all three refusals are proven against a real database.

### Also folded in

- A duplicated pair of tests from the pass-1 commit. Vitest runs same-named tests happily, so nothing failed — the
  suite simply ran them twice.
- Two claim-without-start call sites collapsed onto a `queuedRun` helper.

### Found clean

The migration's tenant-pinned composite FK and additive `tasks_id_company_uq`; the column-scoped UPDATE grant (no
write path to tenancy, task linkage or attempt number); `requestStop`'s `coalesce` idempotence; `isRunLost`'s
fail-closed reading of a run with neither heartbeat nor start time; `reclaimLostRuns` capturing `now` once for the
whole batch and skipping — never overwriting — a run whose guard no longer matches.
