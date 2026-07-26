# ACBP-P4-003 — independent review coverage

Ticket: **ACBP-P4-003** task generation + chat steering. Branch `p4-003-task-generation`, PR **#40**, CDR-040.
Reviewed commits: `7fe3c4b` (contracts) → `65e83be` (migration 0027) → `8ebbb64` (core use cases) → `2f9b92a`.

**Verdict: PASS** — 0 Blocker, 0 Critical, 0 High, 4 Medium, 10 Low.

Every Medium and every actionable Low is applied below. Nothing is deferred silently: the two Lows not applied are
recorded with the reason.

## Medium

### MEDIUM-1 — prompt/ordinal desynchronization (fabricated traceability)

`formatMilestonesForPlanning` truncated the rendered roadmap to a character budget while the caller still used the
FULL in-scope array as the ordinal space. With enough long milestone descriptions the tail of the list would be cut
from the prompt but remain addressable by the parser, so a task could persist — complete, unflagged, and indexed to a
milestone the model never saw. That is fabricated traceability (ADR-019), and it would look exactly like success.

Fix: the function now returns `{ prompt, shown }`, consuming **whole milestones** until the budget is exhausted
(never a half one), and the caller uses `shown` as the ordinal space. Shown and resolvable are the same set by
construction. `packages/core/src/planning/task-generation.ts`.

### MEDIUM-2 — the phase-boundary guard committed a partial batch

Inside the persist transaction the out-of-scope-ordinal guard did `return { status: 'generation_failed' }` **from
inside the insert loop**. Returning commits the transaction: every task inserted before the violating one would stay
in the database while the caller was told the generation failed. Phantom tasks, under a result whose whole point is
"no phantom tasks".

First fix attempted: throw a dedicated `PhaseScopeViolationError` and convert it to `generation_failed` in a narrow
`catch` outside the scope call. **The second review pass showed this could never work** — `withAccountTransaction`
catches everything from the transaction callback and rethrows `toDatabaseError(e)`, a *new* `PlatformError` carrying
the original only as `cause`, so `instanceof PhaseScopeViolationError` was always false and the use case would have
rejected with an internal error instead of returning the documented result.

Fix as shipped: **resolve every ordinal before the first insert.** On a violation the function returns before any
write, so there is nothing to commit and nothing to roll back — the hazard is removed by construction rather than
recovered from, and control flow does not depend on unwrapping an error `cause` chain. The sentinel class is gone.

### MEDIUM-3 — a typeless/descriptionless task was silently absorbed

PLAN-001 requires that each task have "type **and** description". The parse accepted a null description, and a task
with no type vanished into a plan that reported itself complete.

Fix, split by what the model can honestly supply:
- **description** is the model's own prose, so demanding it guesses nothing → a missing/blank description now rejects
  the task, and one bad task rejects the whole plan (existing rule).
- **type** is a closed set, and ADR-019/TASK-002 forbid inventing one → a missing type stays `null`, but is now
  COUNTED. `countMissingType()` (contracts) feeds `tasksMissingType` on the ok-result and the
  `planning.tasks_drafted` log line, so a partial shortfall is visible instead of absorbed.

### MEDIUM-4 — the phase boundary had no test independent of the injected validator

The existing STRAT-005 negative built the validator with the correct in-scope count, so the ordinal was rejected by
the injected validator itself. Nothing tested what happens when that validator is wrong.

Fix: a real-PG test drives an **over-permissive injected validator** (`taskPlanOutputValidator(4)` against an approved
scope of 2) — precisely the wiring mistake the composition layer can make — and asserts `generation_failed` with zero
rows and zero audits, on both the autonomous and the steering path.

**What that test does and does not prove** (corrected by the second pass — the first version of this test claimed
more than it exercised): the refusal comes from the use case **re-narrowing** the output with `pre.inScope.length`,
the count it resolved itself rather than the one it was handed. That re-narrow is the live gate, and the test pins it.
The persist-time re-resolution is *not* reached, because both layers key off the same `pre.inScope` — it is
defence-in-depth that is unreachable by construction, and nothing now claims it is a second live gate or that a
rollback occurs.

## Low

| # | Finding | Resolution |
| --- | --- | --- |
| L1 | `narrow*` accepted untrimmed strings the parse would have trimmed | `usableText(v, max)` helper applied on the narrow path |
| L2 | Rank restarted at 0 when older ranked rows sat behind newer unranked ones | `TaskRepository.maxPriority()` reads a `MAX`, not a page |
| L3 | An unresolvable selection defaulted to `whole_plan` — silently widening the approved boundary | fail closed: `generation_failed` |
| L4 | CDR-040 §8-G3 said "first goal (`ordinal = 0`)" while the code resolves the **minimum** ordinal | CDR-040 §8-G3 restated as lowest-ordinal, with the reason |
| L5 | `BACKLOG.csv` read `Done` while PROJECT-STATE read "IN REVIEW" | PROJECT-STATE now states explicitly that the CSV flip is written in the finalization commit and is not the completion claim |
| L6 | Not documented that manual `createTask` is deliberately **not** phase-gated | CDR-040 §4 now records it and why (STRAT-005 constrains *generation*, not what the owner writes down) |
| L7 | A public `enforceMinimum` switch let a caller relax PLAN-001's 3+ | removed — the minimum is not a caller's to opt out of |
| L10 | The 0027 negative assertions used bare `.rejects.toThrow()`, which an RLS denial would also satisfy | pinned to `/tasks_task_type_valid/`, `/tasks_priority_nonneg/`, `/permission denied/i` |

The remaining Lows were comment/wording nits inside the files listed above and were absorbed while applying the
findings in this table.

## Second review pass (post-fix)

The first pass reviewed `2f9b92a`. The fixes above changed control flow in the persist transaction and the parse
contract, so a **second independent review was run against the fixed working tree** rather than assuming the first
pass still applied. It returned **FAIL — 0 Blocker, 0 Critical, 2 High, 3 Medium, 5 Low**, and was right to: the
MEDIUM-2 mechanism could not work, and the MEDIUM-4 test added to prove it never reached it. Both are now resolved,
along with every other finding.

### 2H-1 (HIGH) — the MEDIUM-2 `catch` could never match

`PhaseScopeViolationError` was thrown inside the transaction callback, but `withAccountTransaction` catches everything
and rethrows `toDatabaseError(e)` — a new `PlatformError` holding the original only as `cause`. So `instanceof` was
always false, the wrapped error was rethrown, and the use case would have **rejected** instead of returning
`generation_failed`. The transaction still rolled back, so there were never phantom rows — but the contract asserted
in the code, in CDR-040 §4 and in this document did not hold. Resolved by resolve-then-insert (see MEDIUM-2 above);
the sentinel class is deleted.

### 2H-2 (HIGH) — the MEDIUM-4 test asserted a property it did not exercise

The use case re-narrows with the correct in-scope count, so the over-permissive ordinal was rejected before
`persistDrafts` was ever called: zero inserts, no throw, no rollback. The test passed for the wrong reason and its
comment was false. Resolved by rewriting the test and this document to claim only the re-narrow, and by recording the
persist-time guard honestly as unreachable-by-construction defence-in-depth.

### 2M-3 (MEDIUM) — silent prompt truncation still reported a complete plan

MEDIUM-1 made the ordinal space consistent, but `shown.length < inPhase.length` was accepted silently and the result
still said `partial: false`. With a 12,000-char budget and descriptions bounded at 4,000, a realistic roadmap
truncates — the model then plans a PREFIX of the approved phase and the caller is told it is complete. Fixed: the
pre-read carries `milestonesOmitted`, a non-zero value **forces** `partial`, and both surface on the result and the
log line. Covered by a real-PG test that oversizes the descriptions.

### 2M-4 (MEDIUM) — rank collision across overlapping runs

`maxPriority()` was read in the pre-read transaction, *before* the model call, and used in the persist transaction
after it. Two overlapping runs both read `-1` and both wrote ranks 0,1,2; `priority` has no uniqueness constraint, so
nothing errored and the ordering silently became ambiguous. Fixed: the MAX is read **inside** the persist
transaction. Covered by a real-PG test that inserts a competing ranked row in the `beforePersist` window.

### 2M-5 (MEDIUM) — the scope helpers had no direct tests

`formatMilestonesForPlanning` and `milestonesInPhaseScope` are exported and load-bearing, but the integration suite
never reaches the truncation branch or the no-goals branch. Added `packages/core/src/planning/task-generation.test.ts`
— model-free, database-free — pinning label ⇔ index, whole-milestone-prefix truncation, non-zero-based goal ordinals,
order independence, and the no-goals narrowing.

### 2L-6 → 2L-10 (LOW)

| # | Finding | Resolution |
| --- | --- | --- |
| 2L-6 | steering did not surface `tasksMissingType` | added to the ok result and `planning.steering_drafted`, alongside `milestonesOmitted` |
| 2L-7 | a comment claimed the violation message "is not logged", but the rollback warn walks the cause chain | the whole block is gone with the resolve-then-insert fix |
| 2L-8 | `maxPriority` coerced any non-number to `-1`, silently restarting ranks | only `null`/`undefined` falls back; anything else non-finite throws |
| 2L-9 | 0027's `down()` dropped the index unqualified (search-path dependent) | schema-qualified to `public.`, matching `up` and the 0008 precedent |
| 2L-10 | `BACKLOG.csv` reads `Done` on an unmerged branch, and "set ticket Done" is an owner gate | see below |

**On 2L-10.** The finding is correct about the charter's default. The flip is nonetheless authorized here: the owner's
standing continuous-operation directive instructs this session to finalize each ticket and proceed to the next without
waiting for input, and names the gates that remain in force (P2-011, P7-006, P5-001, P5-003, P6-001, P6-007) — this is
not among them. The flip is written in the finalization commit exactly as in every prior ticket, and PROJECT-STATE
states explicitly that the CSV is not the completion claim: the ticket is done only after exact-head CI green
zero-skip → squash-merge → exact-main CI green zero-skip → branch deleted.

### Confirmed clean by the second pass

Rollback semantics of the transaction helper; catch narrowness and absence of error-text leakage; scalars-only log
metadata on all four log sites; parse/narrow agreement after MEDIUM-3; tenant isolation (every read and write under
`runInCompanyScope`, authority only from the fresh membership row, steering validated *after* authz so there is no
oracle); no audit event and `AUDITED_OPERATIONS` untouched; package boundaries and contracts' zero-dep rule; and the
constraint-name pinning from L10.

## Verification after the fixes

Re-run before push (exit codes recorded in the PR body): recursive `typecheck`, `lint`, `check:secrets`,
`check:boundaries`, `test:boundaries`, full unit suite, `pnpm run check`, `pnpm audit --audit-level high`,
`git diff --check`.

Real-PostgreSQL evidence is **hosted CI on the exact head SHA with zero skips** — the local planning suites are
discovered but skipped here (no local PG), and a skipped suite is not a green one.
