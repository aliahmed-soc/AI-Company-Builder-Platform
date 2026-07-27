# ACBP-P3-007 — independent review coverage

Ticket: **ACBP-P3-007** Slice C integration, strategy selection (STRAT-001 / STRAT-003 / STRAT-006). Branch
`p3-007-slice-c-strategy-selection`, PR **#45**, CDR-045.

Both passes returned **FAIL**. Pass 1 caught an assertion the ticket's **own CDR condemns two sections earlier**;
pass 2 caught a negative that could pass for the wrong reason, and the same hand-rolled-constant defect class that
cost P4-007 three CI round-trips.

Only **one** CI round-trip was lost this time, against P4-007's three — the static field-name audit was done before
the first push, which was that ticket's recorded lesson.

## Pass 1 — FAIL (0 Blocker, 0 Critical, 1 High, 2 Medium)

### HIGH-1 — "usage verified" was a floor, which is the exact failure CDR-045 §5-G10 forbids

G10 says usage is asserted **per model call, not as a total**, and explains why: a bare `count > 0` passes when one
call meters twice and another not at all. The implementation then asserted `metered >= 5` — which is a total with a
floor, and has precisely that hole. The rule was written and then not followed, three sections later, in the same
ticket.

The journey makes a *known* number of gateway calls (two understandings, two generations, one recommendation), so the
assertion can be exact and exact is the only version that means "one ledger row per call". Now `metered === 5`.

### MEDIUM-1 — the record-failure negative was satisfied by ANY throw

The negative asserted that `recordDecision` rejected and that the decision count was unchanged. Both hold if the call
failed for an unrelated reason — a bad id, a broken precondition, a typo in the setup — so the test would keep
passing long after it stopped testing audit-or-nothing.

Added a **control run**: the same call, with a working writer, must then succeed. Proving the only difference was the
audit writer is what makes the negative mean anything.

### MEDIUM-2 — the no-content scan covered only one of the two companies

The claim is "no audit payload carries content", but the scan was scoped to the happy-path company while the
negatives write events on a second one. Widened to the whole account.

## Pass 2 — FAIL (0 Blocker, 0 Critical, 0 High, 2 Medium)

### MEDIUM-1 — the 16 option fields were hand-listed, again

`OPTION_FIELDS` was a local copy of the contract's `STRATEGY_OPTION_FIELDS`. This is the same defect class CDR-045
§2-G5 was written to prevent, reappearing in the file that cites it: the moment a seventeenth field is added, the
fixture builds an option missing it, STRAT-001 validation rejects the whole generation, and the failure points at the
journey rather than at the drift.

Now imported from `@acbp/contracts`. **The identical duplication existed in the Slice D journey** written earlier the
same session; fixed there too rather than knowingly shipping the flaw this ledger documents. Both are one-line
imports in the same package.

### MEDIUM-2 — step 4 could pass vacuously without step 6

"The recommendation has NOT auto-selected" asserts `selection === null`. On its own that also passes if the read
never populates `selection` at all. Step 6 asserts the same field is non-null once the owner has acted, which is what
proves the field works and therefore that the earlier null meant something.

No behaviour change — the pairing was already correct — but it was **undocumented**, and an editor tidying step 6
would have silently made step 4 vacuous. The dependency is now stated at both sites.

## What the backlog asked for, and where it is

| Backlog field | Where |
| --- | --- |
| "incl. distinctness rejection demo" | step 7 — four channels: surviving count, `insufficient_distinct`, non-empty `fewerReason`, **and** `status = fewer_than_three` |
| "Includes record-failure-blocks negative" | step 8 — rejects, decision count unchanged, **plus a control run that succeeds** |
| "Trail verified" | step 10 — expected event set in order, no content in any payload, account-wide |
| "Usage verified" | step 9 — exactly one metered `model_call` row per call, each with provider + model |
| "Demo passes" | `pnpm demo:slice-c`, driving the identical journey |

## Requirement coverage

| Requirement | Clause | Step |
| --- | --- | --- |
| STRAT-001 | ≥3 genuinely distinct options, each complete on 16 fields | 2 |
| STRAT-001 | fewer is HONEST, never padded (ADR-019) | 7 |
| STRAT-002 | comparison names one, with rationale + sensitivities | 3 |
| **STRAT-003** | the **owner** selects — the AI does not | **4**, 5 |
| STRAT-005 | phase-limited approval | 5 |
| STRAT-006 | immutable decision recorded and surfaced | 6 |
| ADR-015 | audit-or-nothing on the decision record | 8 |

## Evidence

Hosted CI, exact head, **zero skips** — the only real-PostgreSQL evidence, since every `skipIf` suite is invisible
locally.

| Head | Run | Result |
| --- | --- | --- |
| `4ec4df1` (journey + suite) | 30237750938 | FAIL — steps 1–8 green incl. both negatives; step 9 filtered `outcome='success'` where `usage_events` uses `ok` |
| `d11ded2` (outcome fix) | 30238064789 | **1947 passed (1947)**, 0 skipped |
| final head (review fixes) | see PR #45 | recorded at merge |

The demo script was **not executed here**: local PostgreSQL is unreachable from this machine. Its guarantee is that
it drives the identical `runSliceCJourney` the CI suite asserts.
