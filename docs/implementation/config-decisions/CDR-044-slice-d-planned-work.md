# CDR-044 — Slice D integration: planned work (ACBP-P4-007, ROAD-001 / PLAN-001 / TASK-001)

Status: proposed by the implementing session. Governs **ACBP-P4-007**. Depends on ACBP-P4-005 (merged `d517203`) and
ACBP-P4-006 (merged `b8dc466`). Governing ADR: **ADR-008**. Milestone: `MILESTONE-PLAN.md` **M4**.

## 1. What canon asks for

Backlog row `ACBP-P4-007`:

- **Objective:** "E2E: strategy→goals→roadmap→milestones→tasks→states"
- **Requirement IDs:** `ROAD-001`; `PLAN-001`; `TASK-001`
- **Acceptance criteria:** "Demo passes; **rationale/dependency/status inspectable**"
- **Required tests:** "E2E set" · **Verification procedure:** "Run demo script" · **Documentation changes:** "demo doc"
- **Audit behavior:** "Trail verified"
- Type **Testing**, size **S**, `Parallelizable: No`.

This is an INTEGRATION ticket. It builds no new product behaviour: every use case it drives is already merged and
already has its own real-PostgreSQL proof. What it adds is the evidence that they compose.

## 2. The shape — one journey, two callers (the CDR-031 precedent)

Slice B (`ACBP-P2-012`, CDR-031) established the pattern this ticket follows exactly, and the reason it exists:

> the journey is implemented ONCE in `@acbp/test-support` and shared by the runnable demo (`pnpm demo:slice-b`) and
> the CI integration suite, **so the two can never drift**.

A demo that is written separately from the test is a demo that passes while the product is broken. The backlog asks
for both an "E2E set" and a "Run demo script" verification procedure, so they must be the same code.

- **G1 — `runSliceDJourney` lives in `@acbp/test-support`,** beside `slice-a-journey.ts` and `slice-b-journey.ts`,
  returning `JourneyStep[]` (`{step, requirement, ok, detail}`) and **never throwing for a failed step**. The demo
  prints and exits non-zero; the suite asserts. A failure must always arrive with its evidence, not as a stack.
- **G2 — the use cases are INJECTED, not imported.** `@acbp/core`'s own tests import `@acbp/test-support`, so
  test-support importing `@acbp/core` would be a workspace-graph cycle. Both callers may import core and pass the real
  functions (CDR-031's reasoning, unchanged).
- **G3 — everything runs through the RESTRICTED `acbp_app` connection under FORCE RLS.** The owner/fixture connection
  is used for evidence inspection only, never to prove a guarantee — otherwise the journey would prove that a
  superuser can do things, which is not the claim.
- **G4 — the only seam is the model PROVIDER edge** (`FakeModelProvider`, CDR-026 §3). No live model, no key, no
  snapshot pin. ACBP-P2-011 is a standing owner gate; this ticket must not approach it.

## 3. The journey — where it starts, and why that is not "strategy" from nothing

The Objective says the slice runs "strategy→goals→roadmap→milestones→tasks→states". Strategy generation is itself
GATED on an owner-confirmed understanding (`UNDER-003`, enforced in `generateStrategyOptions`), so the journey cannot
begin at strategy on an empty company.

- **G5 — Slice D begins by establishing a confirmed understanding, then runs its own vertical.** It does NOT re-run
  Slice B's thirteen steps: that would make this suite fail for Slice B's reasons and double the runtime for no new
  evidence. It establishes the precondition by the shortest honest path through the real use cases, and records that
  as an explicit setup step so the journey is readable.
- **G6 — Slice D does not depend on ACBP-P3-007 (Slice C).** The backlog scopes P4-007 to `ACBP-P4-005;ACBP-P4-006`.
  Every P3 use case it needs (`P3-001`…`P3-005`) is merged; what P3-007 will add is Slice C's own harness, not
  behaviour. Waiting for it would invent a dependency canon does not state.

The sequence, each step naming the requirement it evidences:

| # | Step | Requirement |
| --- | --- | --- |
| 1 | confirmed understanding established (precondition, G5) | UNDER-003 |
| 2 | strategy options generated, distinct | STRAT-001/002 |
| 3 | owner selects a phase-limited option | STRAT-003/005 |
| 4 | immutable decision recorded | STRAT-006 |
| 5 | roadmap generated with goals + milestones | **ROAD-001** |
| 6 | tasks generated from the approved phase's milestones, ranked, typed | **PLAN-001** |
| 7 | planning run + input snapshot + per-task rationale recorded | PLAN-004 |
| 8 | drafts confirmed onto the board (`draft → planned`) | **TASK-001** |
| 9 | a dependency edge is added and the board reports it | **TASK-001** |
| 10 | the board places every task in a bucket, drafts counted off-board | **TASK-001** |
| 11 | task detail exposes type/created/description + state-appropriate controls | TASK-002 |
| 12 | repeat and delete behave per state; delete is audited | TASK-008 |
| 13 | the audit trail is verified end to end | "Trail verified" |

## 4. "Rationale / dependency / status inspectable" is the acceptance criterion, so it is asserted, not narrated

- **G7 — each of the three is inspected through a PRODUCT read, not a fixture query.** "Inspectable" is a claim about
  what an owner can see, so proving it with an owner-connection `select` would prove the wrong thing. Rationale comes
  from the task detail / planning-run read, dependency from the board projection, status from the board buckets.
- **G8 — a task whose rationale is absent is asserted to render as absent**, not skipped. PLAN-004 counts missing
  rationales rather than inventing them (ADR-019); a journey that only ever exercised the populated case would let the
  honest-gap path rot.

## 5. Trail verified

- **G9 — the audit assertion is on the SET of events the journey should have produced, in order**, not on a count.
  A count passes when the right number of wrong events fire. The expected names are
  `understanding.confirmed` → `strategy.generated` → `strategy.selected` → `decision.recorded` →
  `roadmap.generated` → `task.created`(×n) → `task.deleted` → `task.repeated`.
  (An earlier draft of this line also listed `task.planned`. **No such event is registered** — confirming a draft
  emits `task.created`, which is CDR-033 §4's deliberate choice: a draft is not on the board, so the event that
  matters is the one marking its arrival there. The journey asserts the registered names only.)
- **G10 — no event payload may carry content.** The journey asserts the absence of the company name, the task titles
  and the deletion reason text from every audit row it produced — the same check Slice B makes for interview content.

## 6. Out of scope

No new product behaviour, no migration, no new authz action, no new audit event, no HTTP route, no UI. Live-model
evaluation (**P2-011**) is a standing owner gate. Slice C's own harness is **P3-007**. Execution — runs, workers,
tool calls — is Phase 5 and is deliberately absent: Slice D ends at *planned work*, which is what its name says.

## 7. Slice plan

1. CDR-044 + branch + draft PR.
2. `runSliceDJourney` in `@acbp/test-support` + the CI integration suite driving it (real PostgreSQL).
3. `pnpm demo:slice-d` runnable script over the same journey + the demo doc.
4. Docs + TWO independent review passes (fix every finding from both) + finalization.
