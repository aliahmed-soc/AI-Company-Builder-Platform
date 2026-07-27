# ACBP-P4-005 — independent review coverage

Ticket: **ACBP-P4-005** task detail and controls (TASK-002 / TASK-008). Branch
`p4-005-task-detail-and-controls`, PR **#43**, CDR-043.

Both passes returned **FAIL**. Pass 2's single finding was a **race the first pass did not look for**, in code pass 1
had already read and approved — the pattern that keeps the second pass non-optional.

## The two readings both passes upheld

**There is no task "reject" control.** The backlog Objective says "repeat/delete/**reject** controls", but no
requirement defines task rejection anywhere. `TASK-002` and `TASK-008` — the two the backlog row itself names — cover
repeat and delete only; the `reject` verb belongs to `UNDER-003` (understanding items), `STRAT-003` (strategy options)
and `APPR-007` (approvals), all different objects; the same row's own Acceptance criteria say "Controls behave per
state; repeat links lineage"; and `raw-audit/04-task-and-agent-system.md` lists task rejection under **"Controls not
exercised"**. Building it would have meant inventing a state transition and a user-facing control from one word in a
summary field. Recorded in CDR-043 §2, and it **corrects CDR-042 §3-G3**, which had said the board's `rejected` bucket
was "pending P4-005" — it is not pending, it is unreachable because nothing defines it.

**Delete cannot be a `DELETE`.** `tasks` grants SELECT + INSERT + a column UPDATE pinned to exactly
`(state, updated_at)`, with the adversarial catalog pinning that set. TASK-008 requires the delete be *audited*, so
granting DELETE would destroy the evidence the requirement demands, and adding `deleted_at` would mean widening a
grant the tenant-isolation suite pins. The append-only `task_deletions` table is the same shape CDR-039 chose for
`task_review_flags`, for the same reason (CDR-043 §3). The catalog suite now asserts the unchanged `tasks` grants **in
the same commit that adds the feature**, so a later "simplification" that widens either one fails.

## Pass 1 — FAIL (0 Blocker, 0 Critical, **1 High**, 2 Medium)

### HIGH-1 — a deleted task could still be planned onto the board, and audited as such

`planTask` and `addTaskDependency` read through `findById`, which deliberately still returns deleted rows. Only the
*new* reads had been switched to `findLive`. So after deleting a draft, `planTask` on it still succeeded: it
transitioned `draft → planned` and wrote a **`task.created` audit event** — for a task that every board read then
filtered out. An audit trail claiming a task was put on the board when it can never appear there is worse than no
trail, and it is exactly the G9 invariant ("deleted tasks disappear from the board and the list") leaking through a
door the ticket had not swept.

`addTaskDependency` had the matching hole: a new edge could name a deleted task at either end, which would then either
block its dependent forever or quietly resolve as satisfied — neither being something the caller could have meant.

Fixed: both read through `findLive`. Two real-PG tests added; the defect existed precisely because nothing covered it.

### MEDIUM-1 — the `unavailable` reason was a bare `string`

`RepeatTaskResult` / `DeleteTaskResult` typed `reason` as `string`, discarding the closed
`ControlUnavailableReason` union the contract had just gone to the trouble of defining. A caller rendering "why not"
could not switch exhaustively, and the result would have become an unreviewable message surface. Tightened to the
union.

### MEDIUM-2 — a doc comment described behaviour the code did not have

`findById`'s comment claimed "the delete use case itself needs to read one to know it is already gone". `deleteTask`
reads through `findLive`; nothing used `findById` for that. Left uncorrected it would have invited a future change to
route a product read back through the unfiltered method. Rewritten to state the actual rule: no product read may use
`findById`.

## Pass 2 — FAIL (0 Blocker, 0 Critical, **1 High**)

### HIGH-1 — `deleteTask` was a check-then-insert, so a task could be deleted *while running*

Pass 1 read this code and approved it. The sequence is: `findLive` reads the state → `controlAvailability` decides →
`insertDeletion` writes. Nothing tied the decision to the write. A task read as `queued` (deletable) that started
running in that window was **still deleted** — which is the precise thing TASK-008's failure clause forbids, and the
whole point of G2.

It is not hypothetical in shape: `state` is a writable column today, and the `queued → running` transition is exactly
what P5/P6 will drive. The unguarded version would have shipped a guarantee that held only when nothing was happening
concurrently — the condition under which it least matters.

Fixed structurally rather than by retrying: `insertDeletion` is now an `INSERT ... SELECT` carrying
`where state = <the state that was read>`, so the check and the write are one statement and the window closes at the
database. This is the same optimistic-guard idiom `updateState` already uses for transitions, and it needs no grant
change (SELECT + INSERT are both already held).

The caller now distinguishes the two ways the guarded insert can write nothing — someone else deleted it first
(`not_found`) versus the state moved underneath (`unavailable`) — by re-reading rather than assuming, because
returning `ok` for either would claim a deletion that never happened and emit an audit event to match.

**A note on how this was tested.** The first attempt at a regression test flipped the task to `running` *before*
calling `deleteTask`. It passed — and proved nothing: the verdict check refuses a running task long before the guard
is reached, so the test exercised the old path and would have stayed green with the fix reverted. This is the same
trap as P4-004's MEDIUM-3. Replaced with a repository-level test that passes a `stateAtDelete` which no longer matches
the row, which *is* the race, and which fails without the guard.

## Requirement coverage

| Requirement | Clause | Where it is enforced |
| --- | --- | --- |
| TASK-002 | type / created / structured description | `TaskDetailDTO`, no defaulting |
| TASK-002 | "controls appropriate to its state" | `controlAvailability`, derived per read, total over the control set |
| TASK-002 | failure: "missing fields render explicitly as missing" | every optional field stays `null`; contract test |
| TASK-008 | "repeated (re-queued as a new task)" | `repeatTask` mints a NEW `draft` row |
| TASK-008 | acceptance: "repeat creates a linked new task" | `tasks.repeated_from_task_id`, tenant-pinned, INSERT-only |
| TASK-008 | "with confirmation for delete" | `confirmed: true` parameter, checked before the task is read |
| TASK-008 | acceptance: "delete ... is audited" | `task.deleted` in the same transaction (ADR-015) |
| TASK-008 | **failure: "delete of a running task is refused; cancel first"** | verdict check **and** the DB-level state guard (pass 2) |
| Backlog | "Controls audited" | `task.repeated` + `task.deleted`, scalars only |

## Evidence

Hosted CI, exact head, **zero skips** — the only real-PostgreSQL evidence, since every `skipIf` suite is invisible
locally (local PostgreSQL is unreachable from this machine).

| Head | Run | Result |
| --- | --- | --- |
| `8e4ecda` (slices 1–3, pre-review-fix) | 30232481576 | **1942 passed (1942)**, 0 skipped |
| final head (review fixes) | see PR #43 | recorded at merge |
