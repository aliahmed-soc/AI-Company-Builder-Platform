# ACBP-P5-001b — independent review record

Two full independent passes, per the owner's standing instruction to hold the four safety-critical tickets to the
highest bar. **Both returned FAIL.** Design consequences are recorded in `CDR-050`.

---

## Pass 1 — the execution path

### MEDIUM-1 — executing a step was authorized as enqueuing one

`runJobStep` checked `job:enqueue`. Scheduling work and executing it are different capabilities, and conflating them
has a concrete cost: when **P5-002** introduces a worker identity, there is no way to express "may execute, may never
enqueue" without splitting the action anyway — at which point every existing grant has to be re-reasoned.

**Fix.** Added `job:execute` (owner-only, same reading), on the `task:delete` precedent that a named action makes a
future tightening or widening a one-line policy change rather than a refactor.

### HIGH-1 (documentation correctness) — the rollback comment claimed more than a rollback does

The concurrent-conflict branch said the losing worker's effect "is discarded". A transaction abort reverses
**transactional** work and nothing else: a step that made an HTTP call or spent model budget has already done so, and
no rollback recovers it.

Today every step is transactional, so the guarantee held — but it was stated **unconditionally**, and it becomes false
the moment P5-003 lets a step act externally. A comment that is accidentally true is a trap for whoever reads it next.

**Fix.** The comment now says precisely what an abort does and does not undo, and points at the idempotency key
(NFR-006) as the mechanism that covers the rest.

---

## Pass 2 — the store and the read path, against the fixed tree

Checked and found **clean**: the composite FK really is tenant-pinned (RI checks bypass RLS, so `(job_id, company_id)`
→ `jobs(id, company_id)` is what makes a cross-company checkpoint impossible); the append-only grant matches the
migration; `down()` drops the additive UNIQUE only after the child table is gone; the `ON CONFLICT` targets a plain
unique constraint, so it needs no arbiter predicate (unlike P5-001a's partial index).

### MEDIUM-2 — same-transaction checkpoints had no deterministic order

`created_at` defaults to `now()`, which in PostgreSQL is **transaction start time**. Two steps checkpointed in one
transaction therefore carry an identical timestamp, and `order by created_at` left their relative order to the
planner. `completedSteps` is surfaced to callers, so this is both a latent flaky-test source and a confusing read.

**Fix.** `order by created_at, step_name`. A regression test writes two checkpoints in one statement and asserts a
stable, repeatable order.

### MEDIUM-3 — a read that threw on caller-supplied input

`getResumeState` calls `remainingSteps`, which throws `InvalidPlanError` on a duplicate or blank step name. Throwing
there is right — an uncheckpointable plan is a call-site bug, and CDR-050 §2 explains why a duplicated step name is
silent work loss. But letting it propagate out of a **read use case**, when every sibling read returns a typed status,
means a malformed plan surfaces as an opaque 500 instead of something a caller can act on.

**Fix.** `{ status: 'invalid_plan', reason }` added to the result union, with the validation done **once** and reused
rather than caught at each of the three call sites — three catch sites is how one of them gets missed later.

---

## Note on what the acceptance clause actually required

Worth recording because it shaped the whole sub-scope: *"kill-and-resume green"* is not satisfied by a job that
restarts cleanly. Restarting is merely wasteful. The failure being excluded is **double execution** — a step whose
effect already landed running again after a crash. That is why the checkpoint shares the step's transaction, and it is
why the centrepiece test asserts a *negative*: that the completed step did **not** appear in the second run.
