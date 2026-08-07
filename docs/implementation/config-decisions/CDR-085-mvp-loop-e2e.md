# CDR-085 — End-to-end MVP suite (ACBP-P7-009)

Governing: **PLAN-001** (tasks trace to an approved phase), **TASK-005** (evidence-backed completion),
**ACC-002** (provider identity resolves to one internal user), **NFR-001** (tenant isolation), **J-13**
(revision retains both versions). Depends on **ACBP-P4-007** (Slice D, Done), **ACBP-P5-015** (Slice E, Done),
**ACBP-P6-012** (Slice F, Done). Release gate: `RELEASE-GATES.md`, Closed beta — *"the MVP loop runs end to end"*.

> **THIS TICKET HAS TWO HALVES AND ONLY ONE IS DELIVERED HERE.** The backlog row asks for the MVP loop proven
> end to end. The headless half — the loop driven through the real use cases against real PostgreSQL — is what
> this CDR records. The staging-real half depends on **ACBP-P7-006**, which does not exist, so it is not
> attempted, not stubbed, and not counted. The backlog row is therefore NOT complete on this branch, and saying
> so here is the point: a green suite that quietly redefines its own acceptance criterion is the artefact class
> ACBP-P7-007 and ACBP-P7-008 were built to remove.

## 1 The gap this closes

Slices A–F each prove one vertical, and each of them **establishes its own preconditions**:

| Slice | Starts from | Proves |
| --- | --- | --- |
| A | a seeded user | sign-in → account → company → switch → cross-tenant denial |
| B | a seeded company | interview → memory → understanding |
| C | an understanding **it confirms itself** | strategy options → comparison → decision |
| D | a decision **it records itself** | roadmap → planned tasks → board → controls |
| E | a task **it creates itself** with `createTask` | run → document → completion → settlement → revision |
| F | a seeded company + policy | policy → approval → stop → duplicate delivery → recovery |

Every one is sound. Every one begins mid-river. Nothing in the repository showed that the river is
**continuous** — that the document a founder finally revises descends, hop by hop, from the answer they typed.

The specific unproven hop is the seam between D and E. Slice D stops at the board; Slice E starts by minting its
own task. **No test executed a task that planning produced.** A regression that broke the link between a planned
task and an executable one would have left Slices D and E both green.

## 2 What this suite deliberately does NOT do

It does not re-prove the mechanisms. Distinctness collapse, phase bounding, citation certification, the
audit-or-nothing block, settlement, release-on-failure, the fabricated-citation refusal and the unaffordable
refusal are proven in Slices B–E with their own negatives. Re-asserting them here would be duplication counted
as coverage — the precise failure ACBP-P7-007 §0 documents.

What it asserts is that they **compose**. Accordingly the journey contains **no negative set of its own**: its
falsifiability comes from the continuity walk in §4, not from a second copy of each slice's rejections.

## 3 The sequence — eleven verdicts, one company

1. **The founder's own answer becomes a memory item, verbatim.** `startInterviewSession` →
   `addInterviewQuestion` → `evaluateAnswer`. Asserted by **content**: the `user_fact` must carry the phrase the
   founder typed. "A `user_fact` appeared" would pass against a memory item the platform invented.
2. **Understanding is generated from that memory and confirmed.** The strategy gate must move `false → true`, so
   the next stage is unlocked **by** this one rather than despite it.
3. **Strategy options are generated** behind that gate.
4. **The owner selects and an immutable decision is recorded**, phase-limited to the first phase.
5. **A roadmap is generated from the decision.**
6. **Tasks are planned from the approved phase** — three, because PLAN-001 mints three or more or refuses.
7. **THE HOP NOTHING ELSE PROVES: the task that runs is the task planning produced.** Never a fresh
   `createTask` — `MvpLoopOps` does not even expose one. Verified against `task_runs.task_id`, not by trusting
   the variable the journey happened to pass.
8. **The run produces a document where every claim is cited or admitted.**
9. **The planned task completes citing that document, and the credit settles.**
10. **The founder asks for a revision and it re-executes; both versions are retained** — checked by title
    **value**, since a row count passes against a revision that overwrote the original.
11. **The loop closes** (§4).

## 4 The continuity walk, and why it is falsifiable

Steps 1–10 could all pass while the stages sat in unrelated silos. The last step is the one that would notice:

1. **The chain resolves.** A single join walks `artifacts → task_runs → tasks → companies → memberships`
   backwards from the **revised** document and must land on this company, this account and this owner. A broken
   link returns no rows rather than a wrong answer.
2. **No stage was skipped.** All seven upstream stages — interview, memory, understanding, strategy, decision,
   roadmap, revision — must have left a row under this company. Without this, step 1 proves only that the
   *tail* is connected while the head could have been bypassed.
3. **Nothing leaked.** The unrelated second account must end the loop holding **zero** rows across
   `artifacts`, `task_runs`, `artifact_revisions` and `credit_transactions`. Checks 1 and 2 are both satisfiable
   by a platform that files everything under one tenant and leaks across accounts; this is the half that fails
   if it does.

**The walk was verified live, not assumed.** Pointing `foreignAccountId` at the loop's own account makes step 11
fail with `9 row(s) from this loop landed in the unrelated account` — so the check is load-bearing rather than
vacuous. That probe is a deliberate mutation in the sense of CDR-084 §3 and was reverted immediately.

## 5 The two owner-connection hops, named rather than hidden

`planned→queued` and `queued→running` run on the **owner** connection because **no use case implements them**
(CDR-065 §3-G5c). They are preconditions, not demonstrations. They are written once in the journey's two
helpers rather than retyped at each call site, and the demo prints a NOTE saying so, because a reader who sees
eleven green steps should not conclude more than the run demonstrated.

## 6 One implementation, two consumers

`runMvpLoopJourney` lives in `@acbp/test-support` and is driven by **both** the CI suite and
`pnpm demo:mvp-loop`, so the demo can never drift from the guarantee — the pattern established by CDR-021 and
carried through every slice since. The use cases are **injected**, never imported: `@acbp/core`'s own tests
import `@acbp/test-support`, so test-support importing core would be a workspace-graph cycle. The ops object is
**annotated, never cast**, which is what makes the structural types load-bearing.

Three edges outside the trust boundary are seamed — model provider, research fetcher, object storage. One
object store serves the whole loop, so "both versions retained" is a claim about documents rather than rows.

## 7 What a green run does NOT license anyone to say

- **It is headless.** It drives use cases, not a browser. It says nothing about whether a founder could complete
  this loop in the UI. That is the staging-real half, and it needs ACBP-P7-006.
- **It is one path.** One creation mode, one strategy mode (`select`), one task type (`market_research` — the
  only worker that exists), one revision. It is not a claim about the product's breadth.
- **It does not prove the queue reserves credits.** The journey reserves explicitly, as the caller, because
  nothing wires that yet (CDR-065 §2-G1).

## 8 Status

| Item | State |
| --- | --- |
| Headless MVP loop suite | **Delivered**, green on real PostgreSQL, 11/11 |
| Runnable demo (`pnpm demo:mvp-loop`) | **Delivered**, exits non-zero on any failed step |
| Continuity walk falsifiability | **Verified** by live mutation, reverted |
| Staging-real half | **BLOCKED on ACBP-P7-006** — not attempted, not stubbed |
| Backlog row `Done` | **NOT set** — owner gate, and the criterion is half-met |
