# CDR-062 — The strategy worker: a comparison, or a specific request (ACBP-P5-007)

| | |
| --- | --- |
| Ticket | ACBP-P5-007 — Strategy worker |
| Requirements | **WORK-003**, STRAT-002 (the 16-field content standard) |
| Decisions | ADR-012 (worker/tool boundaries), ADR-019 (model configuration) |
| Depends on | ACBP-P5-005 (worker runtime); **ACBP-P5-011** (artifacts — the backlog's Data column says `artifacts`) |
| Canon | `AI-AND-WORKER-ARCHITECTURE.md` §2 |
| Backlog objective | *"Business-model comparison / option docs as tasks"* |
| Backlog failure clause | **"Insufficient input = specific request"** |
| Backlog acceptance | *"Comparison meets STRAT-002 standard"* |

## 0. Branch position

Stacked on `p5-006-research-worker`, which is stacked on `p5-011-artifact-storage`. The backlog marks P5-006 and
P5-007 parallelizable, and they would be — if either could merge. Neither can: hosted CI has produced no run since
the Actions billing limit was reached. Both edit the same barrels (`contracts/src/workers/index.ts`,
`TEMPLATE_FAMILIES`, `composition/index.ts`, `adapters/src/index.ts`), so building them side by side would guarantee
merge conflicts and buy nothing while both sit in a queue. Stacking makes the merge order linear:
`main → p5-014 → p5-013 → p5-011 → p5-006 → p5-007`.

## 1. Canon disagrees with canon about this worker's task types — and the repo already ruled

`AI-AND-WORKER-ARCHITECTURE.md:38` gives the strategy worker *"Task types: business-model comparison,
**strategic-option generation**"*. The closed `TASK_TYPES` set — MASTER-PRD-v1's "Initial task types", mirrored in the
contract and in the DB constraint `tasks_task_type_valid` (migration 0027) — contains `business_model_comparison` and
**no strategic-option-generation type at all**.

**This was already adjudicated.** `EXECUTION-LOG.md:68` records a prior ticket catching exactly this: *"my first
draft invented `strategic_option_generation` and `general`"* — and treating it as drift to be removed, not a type to
be added. That is an accepted decision in the repo, and this ticket follows it rather than reopening it.

So: **the strategy worker's task type is `business_model_comparison`.** Strategic-option generation is not missing
from the product — it is delivered by ACBP-P3-001/P3-002/P3-003 as an owner-triggered flow with its own tables, its
own distinctness check and its own audit event. It simply is not a *task type*, and inventing one here would mean
widening a closed set and a database CHECK to satisfy a phrase in a table, against a precedent that went the other
way.

**Flagged, not silently resolved:** the architecture doc's wording remains inconsistent with the PRD's task-type list.
Correcting canon is an owner call, so this records the conflict and the reading taken.

## 2. The rule this worker exists to keep

The backlog's failure clause is the whole ticket: **"Insufficient input = specific request."**

A strategy worker handed too little has three tempting ways out, and all three are worse than useless to a founder:

- **pad** — produce a comparison of models it cannot actually distinguish, which is STRAT-002's field standard
  satisfied in form and violated in substance;
- **guess** — fill fields with plausible values, which is precisely the fake precision ADR-019 forbids;
- **shrug** — return "insufficient information", which tells the founder nothing they can act on.

So the output is a CLOSED two-shape union and there is no third:

- **G1 — a comparison, or a request. Never both, never neither.** `ComparisonOutcome` has exactly two members.
- **G2 — a comparison compares.** At least two models; one model is not a comparison, and the count is checked rather
  than assumed.
- **G3 — every compared model meets STRAT-002 in full**, reusing `isCompleteOptionFields` rather than restating the
  16 fields — one list, one meaning. An undeterminable field carries the `unknown` sentinel, never a guess.
- **G4 — a request is SPECIFIC or it is refused.** Each item names *what* is missing, *why* this comparison needs it,
  and *what a usable answer looks like*. A blank or generic request ("more information") is a refusal, because
  "insufficient input = specific request" is unmet by a vague one — that is the difference between a worker that
  moves the founder forward and one that returns the problem unchanged.

## 3. What this ticket does NOT do

- **No new task type** — see §1.
- **No web access.** The backlog's security column is *"Internal tools only"*: `memory_read` and `artifact_write`.
  Unlike research, this worker never touches untrusted external content, so NFR-021's screening does not apply here —
  and that absence is a property to state, not an omission to hide.
- **No live model** (P2-011 remains gated) and **no UI** (standing owner gate).

## 4. Slice plan

1. CDR-062 + branch (this).
2. Contracts: `ComparisonOutcome`, `ComparedModel`, `InputRequest`, `parseComparisonOutput` — TDD, pure, reusing
   `isCompleteOptionFields`.
3. Core `runStrategyComparison`: gateway → parse → persist artifact (comparison) or return the request (no artifact).
4. Real-PG integration.
5. Docs + **TWO** independent review passes + finalization.
