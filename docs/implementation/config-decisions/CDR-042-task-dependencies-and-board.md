# CDR-042 — Task dependencies and board views (ACBP-P4-004, TASK-001 views)

Status: proposed by the implementing session. Governs **ACBP-P4-004**. Depends on ACBP-P4-002 (merged; the state
machine + `task_dependencies` table). Governing ADR: **ADR-008**.

## 1. What canon asks for

**TASK-001** (`REQUIREMENTS.csv`), MVP, Must, *directly observed*, confidence 97:

> Tasks move through defined states: To Do, Recurring, In Progress, Completed, Rejected, Failed (plus Cancelled).
> **Acceptance:** all state transitions are server-enforced, audited, and visible; invalid transitions are rejected.

The backlog row scopes THIS ticket to `TASK-001 (views)` — the state machine itself is P4-002 (CDR-033, merged), which
implemented **eleven** internal states and server-enforced transitions. The backlog's own acceptance is narrower than
the requirement: *"Board filters by state; dependencies visible."*

## 2. The load-bearing reading — the six buckets are a VIEW, not the state set

The obvious misreading is that TASK-001 names six states and P4-002 therefore implemented the wrong machine. It did
not, and the evidence says so directly. `raw-audit/evidence/task-states.csv` records what was actually seen:

| bucket | observed | note |
| --- | --- | --- |
| To Do | **yes** | "queued task" |
| Recurring | **empty tab** | "existence observed; instances unknown" |
| In Progress | **empty tab** | "existence observed; execution not tested" |
| Completed | **empty tab** | "existence observed; completion receipt unknown" |
| Rejected | **empty tab** | "existence observed; rejection reason unknown" |
| Failed | **yes** | one failed task |

Four of the six were **empty tabs**. What was directly observed is a set of BOARD TABS in the reference product's UI —
not six persisted states. TASK-001's own title in `MASTER-PRD-v1.md §8.4` calls it a "six-state task machine", but the
evidence behind the 97-confidence rating is tab existence, and the backlog assigns the *views* to this ticket.

So this ticket adds a **projection** from the eleven internal states onto the observed buckets. It adds NO state, NO
transition, and NO column: inventing a `recurring` or `rejected` state to make the requirement's wording literally true
would be fabricating a mechanism the evidence never observed, and would silently widen P4-002's ratified machine.

## 3. Decisions (G-numbered)

- **G1 — `draft` is NOT on the board.** Already ratified: CDR-033 §4 and CDR-040 §2 define a draft as "not on the
  board, no audit" — it is the planning PREVIEW. A board that showed drafts would show work the owner has not accepted
  as work. `planTask` (`draft → planned`) is what puts a task on the board.
- **G2 — `Recurring` renders as a bucket that is EMPTY BY CONSTRUCTION in this version, and says so.** Nothing can
  enter it: recurrence is `PLAN-003` (recurring scheduled planning cycles) and `TASK-003` (scheduled autonomous work
  windows), and **both are Post-MVP** in `MASTER-PRD-v1.md §8.3/§8.4`. The honest options were to omit the bucket or to
  show it empty with a stated reason; omitting it would misrepresent the product as not having the concept, while
  showing it unlabelled would imply the owner simply has no recurring work yet. It is therefore surfaced as
  `availability: 'not_in_this_version'` rather than as an ordinary empty column.
- **G3 — `Rejected` is likewise empty by construction here**, for a different reason: the reject CONTROL is
  `ACBP-P4-005` (TASK-008, "repeat/delete/reject controls"), which has not landed. The bucket is declared now so the
  board's shape is stable, and P4-005 fills it. Same honest `availability` treatment.
- **G4 — HELD tasks are their own visible bucket, not folded into `In Progress`.** The four hold states
  (`waiting_for_input`, `waiting_for_approval`, `blocked_by_policy`, `paused`) are stalled, not progressing. Counting
  them as "In Progress" would make a task that is waiting on the owner — the exact thing the Decision Room exists to
  surface — indistinguishable from one actively running, and TASK-001's failure clause ("stuck tasks time out to
  Failed with reason") shows canon treats stuck-ness as a first-class concern. This is a bucket the reference product
  did not have; it is added because hiding it would be dishonest, not to add a feature.
- **G5 — the projection is TOTAL and closed.** Every one of the eleven states maps to exactly one bucket, asserted by
  a compile-exhaustive switch plus a test that iterates `TASK_STATES`. An unrecognized value renders as `unknown` —
  never silently dropped from the board and never folded into a healthy bucket (the `toTaskDisplayPhase` precedent).
  A task that vanished from every bucket would be worse than one in the wrong bucket: it would be invisible.
- **G6 — dependencies are READ-ONLY on the board.** `task_dependencies` (migration 0021) is already append-only with
  its own insert path. This ticket surfaces edges (`dependsOn` / `blocks`) and derives a `blocked` indicator; it adds
  no new write path, no cycle-breaking, and no automatic transition.
- **G7 — the `blocked` indicator is DERIVED, never stored.** A task is *dependency-blocked* when any task it depends
  on is not in a terminal-success state. Storing it would let it drift from the edges it summarizes, exactly as
  `isFullyExplained` (CDR-041) is derived.
- **G8 — no new audit event and no new state transition.** This ticket is entirely a read projection. `task.created`
  and the P5/P6 transition events remain the only task audit events.
- **G9 — no migration.** No new table, no new column, no grant change. If this ticket needs a migration, the design is
  wrong.
- **G10 — no HTTP route and no UI** (CDR-026 §0). The board is a core-level query returning a typed DTO.

## 4. Out of scope

The reject control (**P4-005**, TASK-008); recurrence (**PLAN-003 / TASK-003**, both Post-MVP); execution transitions
that would actually populate `In Progress` (**Phase 5**); the Slice D demo (**P4-007**); cycle detection on dependency
insert (P4-002 owns the edge table and did not require it); any HTTP route or UI.

## 5. Slice plan

1. CDR-042 + draft PR + board contracts (bucket set, total projection, derived blocked indicator) + unit tests.
2. Core `getTaskBoard` (company-scoped read, bucket counts, dependency edges) + real-PG integration.
3. Docs + TWO independent review passes (fix every finding from both) + finalization.
