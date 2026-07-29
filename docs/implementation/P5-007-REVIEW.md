# ACBP-P5-007 — review ledger (strategy worker)

Two independent passes; both found real defects. Every finding is mine, from reading this ticket's own code.

| | |
| --- | --- |
| Ticket | ACBP-P5-007 — Strategy worker |
| Branch | `p5-007-strategy-worker`, stacked on `p5-006-research-worker` → `p5-011-artifact-storage` |
| Decision record | `CDR-062` |
| Requirements | **WORK-003**, STRAT-002 (the 16-field standard) |
| Backlog failure clause | **"Insufficient input = specific request"** |
| Backlog acceptance | *"Comparison meets STRAT-002 standard"* |

## The canon conflict this ticket had to resolve

`AI-AND-WORKER-ARCHITECTURE.md:38` gives this worker task types *"business-model comparison, **strategic-option
generation**"*. The closed `TASK_TYPES` set — the PRD's "Initial task types", mirrored in the contract and in the DB
constraint `tasks_task_type_valid` — contains `business_model_comparison` and **no strategic-option-generation type**.

**Already adjudicated.** `EXECUTION-LOG.md:68` records a prior ticket catching this and treating
`strategic_option_generation` as drift to remove, not a type to add. This ticket follows that precedent: the worker's
task type is `business_model_comparison`, and strategic-option generation is delivered by P3-001/002/003 as an
owner-triggered flow. Inventing a task type would have meant widening a closed set **and** a database CHECK to
satisfy a phrase in a table, against a decision that went the other way. **The doc inconsistency is flagged in
CDR-062 §1 — correcting canon is an owner call.**

## Pass 1 — "does each guard do what its comment claims?"

### HIGH — a `void` statement pretending to be a guard

`parseComparisonOutput` opened with `void UNKNOWN_FIELD;` under a comment saying the sentinel was *"referenced here so
the dependency is visible rather than implicit"*. It made nothing visible and guaranteed nothing: had
`isCompleteOptionFields` started **rejecting** the `unknown` sentinel, that line would still have compiled and the
comment would still have claimed the sentinel passes.

- **Fix:** deleted. The property is pinned where it can actually fail — a test — and the comment says so.

### MEDIUM — the artifact render was non-deterministic, and it mattered more than it looked

`renderComparisonMarkdown` iterated `Object.entries(model.fields)`, which follows the parsed object's own key order.
Two identical comparisons whose JSON keys arrived in different orders would render **different bytes**, hash
differently, and become **two artifacts** — so CDR-060 G3's content-addressed idempotence quietly depended on key
ordering nobody controls. The PRD also specifies the field order.

- **Fix:** emitted in `STRATEGY_OPTION_FIELDS` order, with two tests — identical output from forward- and
  reverse-keyed inputs, and canonical ordering in the rendered document.

### LOW — the output was parsed twice

Once through `narrowComparisonOutcome`, then again purely to recover the refusal reason the first parse had already
computed. Parsed once.

## Pass 2 — "which seams are untested, and what edge case escapes typed?"

### MEDIUM — two gateway validators, neither ever called

`comparisonOutputValidator` (this ticket) and `researchOutputValidator` (P5-006) were both added without a single
test. They are the seam the model gateway calls, and an untested deny-by-default is a claim about deny-by-default.

They are also **pure and database-free**, which makes this the rare part of these two tickets that genuinely runs
here rather than being skipped and hoped for.

- **Fix:** six tests. The two that matter: each validator refuses the **other** worker's payload under its own schema
  ref (without which one worker's output could satisfy another's contract), and the research validator is asserted to
  return a **draft** — accepting a never-retrieved source, because that check belongs to certification and this hook
  cannot perform it.

### MEDIUM — a blank title escaping as a raw constraint error

`question.slice(0, 200)` on a question whose first 200 characters are whitespace produces a blank title. That passes
this use case's own non-blank check — the question does have content, further along — and then violates the database's
`artifacts_title_present` CHECK, surfacing as a raw constraint error where every other outcome is a typed result.

- **Fix:** trimmed before slicing, and computed once rather than twice (the title and the document heading were
  derived separately, which is two chances to drift apart).

## Known gaps, named rather than assumed

- **Nothing calls `runStrategyComparison` yet** — the worker dispatch path is a later ticket. Same shape as P5-006's
  `runResearch` and P5-011's `completeTask`.
- **The understanding text is a parameter, not a read.** This worker does not fetch the confirmed understanding
  itself; the caller supplies it. That keeps the worker free of the confirm-gate logic P3-001 already owns, and means
  the gate lives with the dispatch that will call this.
- **`strategy.comparison@1`'s wording is not final.** Like every template in the registry, the deliverable is the
  versioned mechanism; the prompt's fourth sentence (asking is a complete answer) is the part doing real work, and
  `parseComparisonOutput` enforces what it merely requests.

## Evidence status

`pnpm run check` exits 0: **1479 passed / 0 failed / 1074 skipped.**

Locally proven: 18 comparison-contract tests and 6 gateway-validator tests — no database needed. **Unproven:** the 13
integration tests, dropped silently by `describe.skipIf` because no PostgreSQL is reachable. Hosted CI has produced no
run at all since the Actions billing limit was reached; the pushes on this branch started no workflow.
