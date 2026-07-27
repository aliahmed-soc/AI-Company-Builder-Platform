# Slice D demo — planned work (ACBP-P4-007)

The executable proof of the **M4 exit criterion**: the vertical from a confirmed understanding through strategy,
decision, roadmap and milestones to tasks and their board states (`MILESTONE-PLAN.md` M4). Governed by **CDR-044**;
requirements **ROAD-001, PLAN-001, TASK-001** (plus TASK-002/TASK-008 for the detail and controls, and PLAN-004 for
planning transparency); ADR-008.

## Run it

```bash
pnpm demo:slice-d
```

Requires `ACBP_TEST_DATABASE_URL` pointing at a **disposable** PostgreSQL (the same database the integration suites
use — the script drops and recreates the schema). It uses **no production credentials** and never contacts a live
model. Exit code `0` = every step passed; `1` = a step failed (each is printed with its evidence); `2` = the database
URL was not configured.

## What runs

Everything below the model-**provider** edge is production code: the real `@acbp/core` use cases, the P2-003 model
gateway, `@acbp/database`, and the **restricted `acbp_app` connection** under FORCE RLS. The owner/fixture connection
appears only where the journey inspects *evidence* (the planning-run rows and the audit trail) — never to prove a
product guarantee, because a guarantee demonstrated with a superuser is not the guarantee.

The only seam is the provider itself, replaced with the deterministic `FakeModelProvider` (CDR-026 §3): **no live
model, no real key, no snapshot pin**. Live-model evaluation is ACBP-P2-011, a separate ticket.

The journey is `runSliceDJourney` in `@acbp/test-support` — the **same implementation** the CI suite asserts
(`packages/core/src/planning/slice-d.e2e.integration.test.ts`). A demo written separately from its test is a demo that
passes while the product is broken, so there is exactly one implementation and both callers drive it.

## The journey

| # | Step | Requirement |
|---|---|---|
| 1 | Confirmed understanding established — the gate strategy generation checks | UNDER-003 |
| 2 | Strategy options generated and genuinely distinct | STRAT-001 / 002 |
| 3 | Owner selects a **phase-limited** option | STRAT-003 / 005 |
| 4 | Immutable decision recorded — what planning gates on (J-08) | STRAT-006 |
| 5 | Roadmap generated with goals + milestones, ordinal-sequenced | **ROAD-001** |
| 6 | Tasks generated from the approved phase's milestones, minted as drafts | **PLAN-001** |
| 7 | Planning run + input snapshot recorded (links, never copies) | PLAN-004 |
| 8 | Drafts confirmed onto the board (server-enforced `draft → planned`) | **TASK-001** |
| 9 | A dependency edge is added | **TASK-001** |
| 10 | The board places **every** task; drafts counted off-board; the dependency reports as blocking | **TASK-001** |
| 11 | Detail exposes type / created / description + rationale — and a **missing** rationale renders as missing | TASK-002 / PLAN-004 |
| 12 | Delete requires confirmation, is audited, and removes the task from view | TASK-008 |
| 13 | Repeat re-queues a **new linked** task, only from a finished one | TASK-008 |
| 14 | The audit trail is verified end to end, with no content in any payload | "Trail verified" |

Fourteen verdicts. Delete and repeat are separate steps rather than one "controls" step: a repeat that works while a
delete silently does nothing is not one outcome.

## What the acceptance criterion actually demands

The backlog asks for "rationale/dependency/status **inspectable**". That is a claim about what an *owner* can see, so
each of the three is read through a **product read** — the task detail, the board projection, and the board buckets —
not through a fixture query against the tables. Proving it with an owner-connection `select` would prove something
else.

Step 11 is the one worth understanding. The task fixture deliberately includes a task with **no rationale**, and the
journey fails if every task happens to have one. PLAN-004 counts missing rationales rather than inventing them
(ADR-019), and a fixture where the gap never occurs would let the honest-gap path rot untested while the demo kept
printing PASS.

Step 14 asserts the **set** of expected audit event names, not a count — a count passes when the right number of
wrong events fire — and then searches every payload for the exact strings the journey wrote (task titles, the
deletion reason, the customer description). Renaming a fixture cannot make that check vacuous.

## What this slice does NOT cover

Execution. No runs, workers, tool calls, approvals or credit spend — those are Phase 5 and Phase 6. Slice D ends at
*planned work*, which is what its name says. Live-model behaviour is **ACBP-P2-011**; Slice C's own harness is
**ACBP-P3-007**.
