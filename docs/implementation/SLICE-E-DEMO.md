# Slice E demo — safe internal execution (ACBP-P5-015)

The M5 milestone exit: a founder takes a research task off the board, sees what it will cost before it runs,
a worker actually runs it, a document comes back with every claim cited or admitted, the task completes, the
credit settles, the ledger reconciles, and the founder asks for a revision — plus the negative set proving the
platform refuses honestly when things go wrong.

Decisions: [CDR-065](config-decisions/CDR-065-slice-e-integration.md).

## Run it

```bash
pnpm demo:slice-e
```

Requires `ACBP_TEST_DATABASE_URL` pointing at a **disposable** PostgreSQL (the same database the integration
suites use). It resets the schema. It uses no production credentials, reaches no network, and spends nothing.
Exits non-zero if any step does not hold.

## What runs

Everything inside the trust boundary is production code: the real `@acbp/core` use cases, the P2-003 model
gateway, `@acbp/database`, and the restricted **`acbp_app`** connection under dual-keyed FORCE RLS.

Exactly three edges **outside** that boundary are seamed — and only these:

| Edge | Stand-in | Why |
|---|---|---|
| Model provider | `FakeModelProvider` | A milestone exit must be reproducible, and must run in CI with no key |
| Research fetcher | `InMemoryResearchFetcher` | A real fetch reaches the public internet — an owner gate (CDR-061 §3) |
| Object storage | `InMemoryObjectStorage` | Same reason as P5-011's own suites |

Not seamed, deliberately: authorization, RLS, citation certification, the injection screen, the credit CHECK
constraints, and every audit write. Those are the things being demonstrated.

The journey is `runSliceEJourney` in `@acbp/test-support` — the **same** implementation the CI suite asserts
(`packages/core/src/workers/slice-e.e2e.integration.test.ts`) — so the demo cannot drift from the guarantee.

## The journey

Thirteen positive steps:

1. **Preflight** states cost, balance and side-effect class before anything runs (TASK-004).
2. A research task reaches the **queue**.
3. The **run** is claimed and running — the claim is exclusive.
4. One credit is **reserved before the worker is invoked** (BILL-002).
5. **Research** produces a document where every claim is cited or admitted (WORK-002).
6. The artifact records **which run produced it** (TASK-005, ADR-013).
7. The task **completes**, citing the artifact it produced.
8. A succeeded run **consumes** its reservation.
9. The **ledger reconciles** against the balance the product reports (USAGE-001).
10. The run is fully **audited**, carries no content in any payload (NFR-008).
11. A **revision** creates a new linked task and charges nothing yet (J-13, CDR-064 G4).
12. The **lineage** reads back: the original has no ancestor, and carries the revision just requested.
13. The revision **re-executes**, and **both versions are retained** — proven by value, not asserted: the two
    artifacts have different ids *and* different titles, the original is still readable through its own run,
    and the revised document's ancestor is derived by walking run → task → request (CDR-064 G1).

Then the negative set — the part that proves the platform does not lie:

14. A failed generation reports `generation_failed`, **persists nothing**, and names a failure category
    (TASK-006 "no blank failures"). This is the no-hollow-success demo.
15. The failed run **gives the credit back** (`release`) — nobody is charged for a document they never got.
16. A **fabricated citation** is refused as `uncertified` and nothing reaches storage (WORK-002).
17. An **unaffordable** run is refused with the actual numbers, and does no work (TASK-004).

## What the acceptance criterion actually demands

> Demo passes incl. revision + failure-detail demo

Steps 11–13 are the revision half — including the **re-execution**, without which "both versions retained"
would be a claim about a single document. Steps 14–17 are the failure half. The demo exits non-zero unless all
seventeen hold **and** exactly seventeen steps were recorded — a truncated run must not read as a pass.

## What this slice does NOT cover

Stated plainly, because sixteen green steps invite reading more into them than the run demonstrated.

- **The credit is reserved by the journey, not by queueing.** `WORKFLOW-STATE-MACHINES` §4 puts the credit
  check on `planned→queued`, but no code wires that effect yet — `task-management.ts` says so in its own
  header. The demo proves the pieces compose correctly when a caller drives them in the right order; it does
  **not** prove the product meters automatically. See CDR-065 §2-G1.
- **Two task transitions are set on the owner connection.** `planned→queued` and `queued→running` are legal in
  the contract and implemented by no use case; `startRun` advances the *run*, not the *task*. CDR-065 §3-G5c.
- **The founder-facing activity feed shows none of this.** `ACTIVITY_TYPES` is exactly the four `company.*`
  events — no task, run, artifact or credit event projects into it. Execution is fully **audited**; it is not
  yet **visible** in the feed. That is `ACBP-P6-008`'s scope, with `ACBP-P6-009` for usage rollups. Step 10
  asserts this absence on purpose, so widening the taxonomy turns the step red and forces the claim to be
  re-checked. CDR-065 §5-G9.
- **No approvals.** Slice E is *internal* execution — nothing external happens, so the preflight's side-effect
  class is `informational` (CDR-058 §4). Policy and approval gating are Phase 6; Slice F is their milestone
  exit.
- **No live model, no real research.** See the seam table above.
