# Slice C demo — strategy selection (ACBP-P3-007)

The executable proof of the **M3 exit criterion**: confirmed understanding → three options → compare → select →
decision recorded (`MILESTONE-PLAN.md` M3). Governed by **CDR-045**; requirements **STRAT-001, STRAT-003, STRAT-006**;
ADR-015 (audit-or-nothing) and ADR-019 (no fabrication).

## Run it

```bash
pnpm demo:slice-c
```

Requires `ACBP_TEST_DATABASE_URL` pointing at a **disposable** PostgreSQL (the same database the integration suites
use — the script drops and recreates the schema). It uses **no production credentials** and never contacts a live
model. Exit code `0` = every step passed; `1` = a step failed (each is printed with its evidence); `2` = the database
URL was not configured.

## What runs

Everything below the model-**provider** edge is production code: the real `@acbp/core` use cases, the P2-003 model
gateway, `@acbp/database`, and the **restricted `acbp_app` connection** under FORCE RLS. The owner/fixture connection
only inspects evidence (the usage ledger, the audit trail, the decision count) — never to prove a guarantee.

The only seam is the provider, replaced with the deterministic `FakeModelProvider` (CDR-026 §3): **no live model, no
real key, no snapshot pin**. Live-model evaluation is ACBP-P2-011, a separate ticket.

The journey is `runSliceCJourney` in `@acbp/test-support` — the **same implementation** the CI suite asserts
(`packages/core/src/strategy/slice-c.e2e.integration.test.ts`). A demo written separately from its test is a demo
that passes while the product is broken.

## The journey

| # | Step | Requirement |
|---|---|---|
| 1 | Confirmed understanding established — the gate strategy generation checks | UNDER-003 |
| 2 | **Three genuinely distinct options**, each complete on all 16 fields | **STRAT-001** |
| 3 | The advisory comparison names one, with rationale **and sensitivities** | STRAT-002 |
| 4 | **The recommendation has NOT auto-selected anything** | **STRAT-003** |
| 5 | The owner selects, approval bounded to the first phase | STRAT-003 / 005 |
| 6 | The immutable decision is recorded and surfaced on the read | **STRAT-006** |
| 7 | **NEGATIVE** — near-duplicate options collapse, honestly explained | STRAT-001 / ADR-019 |
| 8 | **NEGATIVE** — a failed audit write blocks the decision entirely | ADR-015 / STRAT-006 |
| 9 | Usage verified — a metered ledger row per model call | "Usage verified" |
| 10 | Trail verified — the expected audit events, no content in payloads | "Trail verified" |

### Step 4 is the one worth understanding

STRAT-003 is that the **owner** selects. The failure mode worth proving absent is a recommendation that quietly
becomes a selection — so the journey reads the generation back *after* the advisory comparison and *before* the owner
acts, and fails if a selection already exists. Without that step the whole slice would pass on a system that selected
for the owner.

### The two negatives are named by the backlog, not invented here

**Distinctness rejection** (the acceptance criterion, verbatim: "Demo passes incl. distinctness rejection demo"). The
demo drives a second generation with three options identical on every dedupe axis. They must **collapse** — and the
generation must say so on all three channels: fewer surviving options, `similarityCheckResult =
insufficient_distinct`, a non-empty `fewerReason`, and a `status` of `fewer_than_three`. STRAT-001's bar is *three
genuinely distinct* options; padding the set back to three would be the fabrication ADR-019 forbids. Checking the
option count alone would pass on a generation that returned two while still calling itself complete.

**Record-failure-blocks** (the security consideration, verbatim). `recordDecision` is driven with a failing
in-transaction audit writer. The call must reject **and leave no decision row**. ADR-015 is audit-or-nothing: a
decision persisted without its audit event is precisely the silent state change the invariant exists to prevent — and
STRAT-006's record is the artifact P4-001 planning gates on.

Both negatives run on a **second company**, so a half-written negative cannot corrupt the state the positive steps
already proved, and a failure is never ambiguous about which half broke.

### Usage is verified per call, not as a total

A bare `count > 0` passes when one call meters twice and another not at all. The journey makes a known number of
gateway calls and asserts one successful `model_call` ledger row each, every one carrying its provider and model. No
specific cost is asserted — the fake provider's token counts are not a product claim.

Note the vocabulary: `usage_events.outcome` is `ok | error`, while `audit_events.outcome` is
`success | denied | blocked`. They are deliberately different and easy to conflate.

## What this slice does NOT cover

Planning — roadmap, milestones, tasks — is **Slice D** (ACBP-P4-007, merged). Live-model behaviour is **P2-011**. The
strategy *evaluation area* is **P3-006**, which depends on P2-011 and is blocked behind it.
