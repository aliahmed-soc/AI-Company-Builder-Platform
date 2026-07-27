# CDR-045 — Slice C integration: strategy selection (ACBP-P3-007, STRAT-001 / STRAT-003 / STRAT-006)

Status: proposed by the implementing session. Governs **ACBP-P3-007**. Depends on ACBP-P3-005 (merged). Governing
ADRs: **ADR-015** (audit-or-nothing), **ADR-019** (no fabrication). Milestone: `MILESTONE-PLAN.md` **M3**.

## 1. What canon asks for

Backlog row `ACBP-P3-007`:

- **Objective:** "E2E: confirmed understanding→3 options→compare→select→decision recorded"
- **Requirement IDs:** `STRAT-001`; `STRAT-003`; `STRAT-006`
- **Acceptance criteria:** "Demo passes **incl. distinctness rejection demo**"
- **Required tests:** "E2E **+ negative set**" · **Verification:** "Run demo script" · **Docs:** "demo doc"
- **Security considerations:** "Includes **record-failure-blocks** negative"
- **Audit behavior:** "Trail verified" · **Usage behavior:** "**Usage verified**"

An INTEGRATION ticket: it builds no new product behaviour. Every use case it drives is merged and separately proven.

## 2. Shape — the CDR-031/CDR-044 precedent, unchanged

- **G1 — `runSliceCJourney` lives in `@acbp/test-support`,** returning `JourneyStep[]` and never throwing for a
  failed step: the demo prints and exits non-zero, the suite asserts.
- **G2 — the use cases are INJECTED, not imported** (test-support importing `@acbp/core` would be a workspace-graph
  cycle).
- **G3 — everything runs on the RESTRICTED `acbp_app` connection under FORCE RLS.** The owner connection may only
  inspect evidence or set up a precondition the product cannot reach, marked at the site — never demonstrate a
  product behaviour. (Adopted from CDR-044 §2-G3 as refined by that ticket's first review pass.)
- **G4 — the only seam is the model PROVIDER edge** (`FakeModelProvider`). Live-model evaluation is **P2-011**, a
  standing owner gate this ticket must not approach.

**G5 — types come from `@acbp/contracts`, never hand-rolled subsets.** Recorded as a decision because P4-007 lost
three CI round-trips to exactly that: an *optional* field in a hand-written structural subset left the real DTO
assignable, so the compiler passed while the journey read `undefined`. A subset allowed to be wrong about a name is
not a cheaper type, it is a silent one. Every field name used here was checked against the contract **before** the
first push.

## 3. The journey

Starts from a confirmed understanding, because `generateStrategyOptions` is gated on one (`UNDER-003`) — established
by the shortest honest path through the real use cases and recorded as an explicit setup step, not by re-running
Slice B.

| # | Step | Requirement |
| --- | --- | --- |
| 1 | confirmed understanding established (precondition) | UNDER-003 |
| 2 | **three genuinely distinct options** generated, each complete on all 16 fields | **STRAT-001** |
| 3 | the advisory recommendation compares them and names one, with rationale + sensitivities | STRAT-002 |
| 4 | the recommendation has **NOT** auto-selected anything | **STRAT-003** |
| 5 | the owner selects, phase-limited | **STRAT-003** / STRAT-005 |
| 6 | the immutable decision is recorded and surfaced on the read | **STRAT-006** |
| 7 | **usage verified** — a metered `usage_events` row per model call | "Usage verified" |
| 8 | **trail verified** — the expected audit event set, in order, no content | "Trail verified" |

**G6 — step 4 is not decoration.** STRAT-003 is that the OWNER selects. The failure mode worth proving absent is a
recommendation that quietly becomes a selection, so the journey asserts `selection === null` *after* the
recommendation and *before* the owner acts. Without that step the slice would pass on a system that auto-selected.

## 4. The negative set — both negatives the backlog names

- **G7 — the distinctness rejection demo** (acceptance criterion, verbatim). A second generation is driven with
  near-duplicate options; the journey asserts they COLLAPSE rather than persisting three lookalikes, that
  `similarityCheckResult` is `insufficient_distinct`, and that `fewerReason` states honestly why there are fewer than
  three. STRAT-001's bar is *three genuinely distinct* options; padding to three would be the fabrication ADR-019
  forbids, and this is the case that proves the platform would rather return two.
- **G8 — the record-failure-blocks negative** (security consideration, verbatim). `recordDecision` is driven with a
  failing in-transaction audit writer; the journey asserts the call rejects AND that **no decision row survives**.
  ADR-015 is audit-or-nothing: a decision recorded without its audit event is exactly the silent state change the
  invariant exists to prevent, and STRAT-006's record is the artifact planning gates on.

**G9 — the negatives run on their own company**, not the one carrying the happy path. Sharing would let a
half-written negative corrupt the state the positive steps already proved, and make a failure ambiguous about which
half broke.

## 5. Usage verified

**G10 — usage is asserted per model CALL, not as a total.** The journey makes a known number of gateway calls
(generation, recommendation, and the near-duplicate generation), so it asserts one `usage_events` row each with
`outcome = 'success'` and a non-null model/provider — never a bare `count > 0`, which passes when one call meters
twice and another not at all. Costs are integer micro-units; nothing asserts a specific number, because the fake
provider's token counts are not a product claim.

## 6. Out of scope

No new product behaviour, no migration, no authz action, no audit event, no HTTP route, no UI. Planning (roadmap,
tasks) is Slice D, already merged. Live-model evaluation is **P2-011** (owner gate). The strategy *evaluation area*
is **P3-006**, which depends on P2-011 and is therefore blocked.

## 7. Slice plan

1. CDR-045 + branch + draft PR.
2. `runSliceCJourney` + the CI integration suite (real PostgreSQL), including both negatives.
3. `pnpm demo:slice-c` + the demo doc.
4. Docs + TWO independent review passes (fix every finding from both) + finalization.
