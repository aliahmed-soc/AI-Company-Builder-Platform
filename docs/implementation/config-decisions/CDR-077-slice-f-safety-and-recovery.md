# CDR-077 — Slice F integration: safety and recovery (ACBP-P6-012)

Governing: **POL-005**, **APPR-004**, **ADMIN-001**, **TASK-009**, **TASK-006**; ADR-009, ADR-010;
`MILESTONE-PLAN.md` **M6**; launch gates 4, 5 and 8 (as composed evidence, not as their primary proof).

M6's exit criterion, verbatim:

> **Policy blocks a disallowed action; modified approved payload requires reapproval; emergency stop blocks new
> work; duplicate delivery does not duplicate execution; account + company usage totals reconcile**

---

## §0 What this slice is for, and what would make it worthless

Every one of the five mechanisms already has a dedicated real-PostgreSQL suite, listed in §2. If Slice F were
another pass over those same assertions it would add running time and no information, and — worse — it would
read like independent confirmation while being a copy.

**The thing no existing suite tests is that the five controls hold TOGETHER, in one company's continuous
lifetime, in the order a real incident presents them.** Each suite establishes its own world, exercises one
mechanism against a clean fixture, and tears it down. None of them ever asks:

- Does a **policy deny** still refuse when a human approval is standing against the same call? (An approval that
  could buy past a deny is POL-005 inverted, and the two mechanisms are read at the same gate.)
- Does an **emergency stop** outrank a valid, bound, unexpired approval — and leave it unspent, so the halt costs
  nothing but time?
- Does a **duplicate delivery** of an approved external action spend a **second** approval? Both mechanisms are
  single-use guards; nothing has ever run them against each other.
- After a **worker is reaped**, is the work recoverable — or does the safety machinery leave a task that can
  never run again?
- Do the account's usage totals still reconcile **after** all of that: refusals, a suppressed duplicate, a lost
  worker, a stop and a resume?

Those five questions are the slice. They are compositional, and composition is exactly where a system made of
individually correct parts fails.

**The failure mode this slice exists to catch** is a platform where every safety control passes its own test and
the combination is unsafe or unusable — a stop that cannot be resumed from, an approval spent twice by one
delivery, a total that stops reconciling the moment anything abnormal happens.

## §1 The five scenarios, and the sixth criterion

The backlog names five scenarios; M6 names five user-visible criteria, and they are not the same list — M6's
fifth is usage reconciliation, which the backlog's scope column leaves out. **Both lists are served**, because
the ticket's acceptance clause is "all five scenarios pass live" and the milestone's is its own sentence.

| # | Scenario | Requirement | Composition claim added here |
|---|---|---|---|
| 1 | Policy blocks a disallowed action | POL-005 | The block is **scoped** (a sibling class still runs) and **an approval cannot buy past it** |
| 2 | Modified approved payload requires reapproval | APPR-004 | The refusal does **not burn** the approval, and the unmodified action still runs afterwards |
| 3 | Emergency stop blocks new work | ADMIN-001 | The stop **outranks a live approval**, leaves it unspent, and the halt is **recoverable through review** |
| 4 | Duplicate delivery does not duplicate execution | TASK-009 | A re-delivered **approved** action spends **no second approval**; three surfaces, each with a recorded incident |
| 5 | Worker failure recovery | TASK-006 | The reaped task is **startable again** — recovery, not a dead end — and is never completed |
| 6 | Account + company usage totals reconcile | USAGE-001 | Reconciles **after** all of the above, with the suppressed duplicate counted once |

## §2 What Slice F does NOT re-test (and where each mechanism is actually proven)

Named so that a reader does not mistake this slice for the primary evidence, and so that a future weakening of a
mechanism is not expected to turn this file red:

| Mechanism | Primary proof |
|---|---|
| Policy determinism, versioning, supersession race | `packages/core/src/policy/policy-service.integration.test.ts`, `packages/core/src/tools/policy-enforcement.integration.test.ts` |
| Every bound element (payload, tool, tool version, cost) | `packages/core/src/tools/policy-enforcement.integration.test.ts` §gate 4, `packages/contracts/src/approvals/binding.test.ts`, `packages/database/src/integration/approvals.integration.test.ts` |
| Seven stop scopes, five enforceable, ≤5s halt timing | `packages/core/src/stops/stop-service.integration.test.ts` |
| Duplicate suppression on every surface | `packages/core/src/idempotency/replay.integration.test.ts` |
| Lost-run detection, grace, worker-run reaping | `packages/core/src/runs/coordinator.integration.test.ts`, `packages/core/src/workers/runtime.integration.test.ts` |
| Rollup determinism, drift, repair, alert threshold | `packages/core/src/usage/usage-rollup-service.integration.test.ts`, `usage-reconciliation.integration.test.ts` |

**Launch gate 8's ≤5s halt is NOT re-timed here.** It is timed where it can be timed meaningfully, in the stop
suite. This slice asserts the *ordering* fact instead — the very next call after activation is refused — which
is the property that makes the timing claim mean anything, and which is bounded by transaction visibility rather
than by an interval anyone could tune.

## §3 Decisions

**G1 — One journey, shared by the demo and the suite.** `runSliceFJourney` lives in `@acbp/test-support` and is
driven by both `pnpm demo:slice-f` and a CI integration suite, exactly as Slices A–E are. The alternative — a
suite plus a separately written demo — was rejected the first time it was proposed (CDR-065 §1) because the
demo is the artifact an owner runs at a milestone gate, and a demo that has drifted from the suite is worse than
no demo: it is a green screen backed by nothing.

**G2 — The use cases are INJECTED, never imported.** `@acbp/core`'s own tests import `@acbp/test-support`, so
test-support importing core would be a workspace-graph cycle. The ops interface is annotated (`const OPS:
SliceFOps`), never cast, so a renamed field in a real DTO is a compile error rather than a runtime `undefined`
that CI discovers ten minutes in — the failure Slice D shipped twice.

**G3 — Everything runs through the restricted `acbp_app` role under FORCE RLS.** The owner connection is used
for exactly three things, each named at its call site: seeding preconditions the product role has no path to
(the tool registry, a policy rule), performing task-state hops no use case implements, and reading evidence.

**G4 — Policy rules are edited on the OWNER connection, and that is a real limitation.** There is no shipped
product surface for authoring a rule; `initializeCompanyPolicy` writes the baseline and nothing edits it. So the
"disallowed action" of scenario 1 is installed by an owner-side `update policies set rules = …`. The journey
says so in its step detail rather than letting a reader conclude a founder can configure this today.

**G5 — The forbidden action is expressed on `risk_class`, not on `forbidden_action`.** POL-005's own dimension
is in `POLICY_DIMENSIONS`, but the dispatcher supplies **no observation** for it, so a rule on it is
*unevaluable* and by CDR-066 §3-G9 contributes `deny` — every call in the company would be refused. That is
fail-closed and therefore not a defect, but it would make scenario 1 indistinguishable from a tenant outage, and
the scoping half of the claim ("the block is a block, not a blackout") could not be asserted at all. The rule is
therefore written on the observed dimension, and this paragraph is the record of why.

**G6 — Scenario 2 uses the baseline policy's OWN approval demand, not a fixture rule.** `initializeCompanyPolicy`
already ships `baseline-risk-approval`: `risk_at_least external_reversible → require_approval`. Driving the
approval path through the shipped default rather than a test-authored rule is the difference between proving the
product's behaviour and proving the fixture's.

**G7 — The approval is raised and decided through the real services.** Every dispatcher-level approval elsewhere
in the repo is seeded with owner SQL, for good reasons local to those suites. A milestone slice must not: the
claim being made is that a founder can approve an action and have it run, and an owner-inserted row does not
demonstrate `requestApproval` → `decideApproval` → dispatch as one path.

**G8 — Zero drift threshold for reconciliation.** `reconcileAccountUsageRollup` requires a threshold and defaults
one nowhere (CDR-073 §3.1 — the value is the owner's). The journey passes **zero** on every lane, because it is
not asserting the owner's alerting policy; it is asserting exactness. Any drift at all is a failure of the
milestone criterion, and a non-zero threshold here would silently accept the very disagreement the criterion is
about.

**G9 — Two companies in ONE account, not two accounts.** The sibling company `companyA2` carries the tenancy
half of scenarios 3 and 6 at once: a `company`-scoped stop must not halt the sibling, and the account rollup
must be the sum across both. A second *account* would prove less about the rollup, which is account-keyed by
design.

**G10 — The journey never throws for a failed step.** It records a verdict and bails, so the demo prints the
failure with evidence and the suite reports it as a named step. A stack trace from step 9 tells an owner at a
milestone gate nothing about which guarantee broke.

**G11 — No production code is added by this ticket.** If a step needs a transition no use case implements, the
owner connection performs it and the step's detail names the gap. Adding a use case to make a demo pass would be
the demo defining the product.

## §4 What a green Slice F does NOT prove

Stated here because a milestone-exit run with every step green invites over-reading:

1. **No external action has ever actually executed.** No tool implementation exists; the dispatcher authorizes
   and records, and `send_email` is a registry row with a risk class. "The approved action ran" means "the
   chokepoint authorized it and spent the approval", which is the only execution instant that exists today
   (CDR-069 §1-G7).
2. **The five scopes are not all exercised.** Scenario 3 uses `company`. The per-scope enforcement matrix is the
   stop suite's job, and `capability`/`integration` are refused by name and enforce nothing at all (CDR-072 §1-G10).
3. **The held-work queue is not a roster of everything a stop covers** — it records what the stop *interrupted*
   (CDR-072 §1-G6). A step that read the queue as a complete list would be asserting something false.
4. **Nothing here is a performance or latency claim.** Reconciliation is exact on three usage events, which says
   nothing about a month of real traffic.
5. **The founder cannot see any of this in a UI.** Every P6 surface is API-first; no Decision Room rendering
   exists (ACBP-P6-008 ships the read model, not a screen).
