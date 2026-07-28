# CDR-059 — Failure detail and visible retries: no blank failures (ACBP-P5-013)

| | |
| --- | --- |
| Ticket | ACBP-P5-013 — Failure detail and visible retries |
| Requirements | TASK-006 (failure detail), TASK-010 (visible retry policy), ACT-005 (failure visibility), NFR-007 |
| Decisions | ADR-017 (redacted logging/observability) |
| Architecture | `FAILURE-AND-RECOVERY.md` — **rows 1 and 4, plus the per-run half of 2 and 3**. See §6 for the other twelve and who owns them. *(The header first said "all 16 rows"; review pass 2 counted them and it was a scope overclaim.)* |
| Depends on | ACBP-P5-002 (task runs), merged |
| Out of scope | The retry MECHANISM (P5-002 owns run lifecycle; P5-001c owns job retries); the support bundle; provider-health banners (row 2); anything needing object storage (P5-011) |

## 0. What canon fixes

`FAILURE-AND-RECOVERY.md` is a 16-row table, and it is the specification. Three of its columns are this ticket's
whole subject: **User-facing status**, **Retry (eligibility / limit)**, and the global rule at the top —
*"no unlimited retries — every retry policy is bounded with backoff"*.

Two requirements pin the standard:

- **TASK-006 — "No blank failures."** The traceability row says it in three words. Every failure a founder can see
  carries a category, a plain-language summary, the attempts made, and whether retrying is safe.
- **TASK-010 — "Bounded retries only."** The policy must be *visible*, not merely obeyed. A founder looking at a
  failed run should be able to see how many attempts it got, how many it was allowed, and whether another is coming.

**ACT-005 — "Suppression-proof feed record."** A failure must reach the activity feed. It cannot be a thing the
system knows and the founder does not.

## 1. Guarantees

- **G1 — a failure detail is TOTAL.** Every `(state, category, attempt)` a run can be in produces a complete detail.
  There is no input for which the answer is a blank field, and the function cannot throw.
- **G2 — UNKNOWN IS A VALUE, not an absence.** When a run failed and no category was recorded, the detail says
  `unknown` and says so in the summary. The backlog's failure behaviour is exactly this: *"Unknown cause labeled
  unknown never blank"*. An empty string, a `null`, or the word "Error" would each be a way of not answering.
- **G3 — the summary is DERIVED, never free text from a provider.** It is a fixed plain-language sentence per
  category, chosen from a closed map. Provider exception text never reaches a founder (ADR-017, and the standing
  security rule that provider exception text is never returned).
- **G4 — retry visibility is HONEST ABOUT THE FUTURE.** The detail distinguishes three things a founder actually
  cares about and which are easy to conflate: attempts *used*, attempts *allowed*, and whether another attempt
  **will** happen. A category that is not retry-eligible says so rather than showing a remaining count that will
  never be used.
- **G5 — retry-safety is a PROPERTY OF THE CATEGORY, not a guess.** `FAILURE-AND-RECOVERY` assigns idempotency
  requirements per row. A category whose safety canon does not establish is reported as unsafe — the direction that
  cannot cause a double-execution.
- **G6 — ACT-005 IS NOT MET, and the attempt to meet it was reverted.** *Corrected after review; both passes found
  the same thing independently.* This ticket first added `task.failed` to the activity taxonomy — and that was worse
  than leaving it out. No migration widened `activity_events_type_valid`, which still names only the four company
  events, so the contract asserted something the schema forbids. Nothing projects today, so it was inert; the danger
  was for the next person, because the projector is **fail-closed**: the first correct wiring would have inserted a
  rejected value, thrown, and rolled back the transaction carrying `failRun`'s terminal transition. A ticket about
  failure visibility would have made failures stop being recorded.

  Completing it properly needs a migration plus a projection call inside the audit transaction, and neither can be
  proven without a real database. So the widening was **reverted**, following the `interview.started` precedent
  (P2-001/CDR-022 §4): the event is audited, its feed projection is deferred, and the deferral is recorded.
  `activityTypesMatchDatabase()` now pins the contracts set against the migration's literals — the divergence was
  silent because nothing tied those two together, and that guard is worth keeping regardless of who finishes ACT-005.

## 2. Shape

| Element | Shape |
| --- | --- |
| `RunFailureDetail` | `{ category, summary, attemptsUsed, attemptsAllowed, retrySafety, nextAttempt }` — every field always present |
| `category` | `RunFailureCategory \| 'unknown'` — the closed P5-002 set plus the honest fallback |
| `summary` | one fixed sentence per category, from a closed map |
| `retrySafety` | `'safe' \| 'unsafe'` — canon's idempotency column, defaulting to `unsafe` |
| `nextAttempt` | `'scheduled' \| 'exhausted' \| 'not_eligible'` — the three real answers |

**No new table.** Everything is derived from `task_runs` rows that already exist: `state`, `failure_category`,
`attempt`. A stored failure-detail row would be a second copy of facts the run already has, and it could disagree.

## 3. Why the summary map is in CONTRACTS and not the database

A category-to-sentence map is configuration in the loosest sense, and it is tempting to make it a table. It is not,
for the same reason `CREDITS_PER_MANUAL_RUN` is not: it is **behaviour**, not tenant data. Every company gets the
same sentence for the same category, the set is closed by `RUN_FAILURE_CATEGORIES`, and putting it in the database
would mean a failure could render blank because a row was missing — precisely what TASK-006 forbids.

Localization, when it comes, replaces the map with a key lookup; that is a change of one module.

## 4. What this ticket does NOT do

- **It does not change retry MECHANICS.** No run is retried differently because of this ticket. `classifyRetryOutcome`
  and `DEFAULT_RETRY_POLICY` (P5-001c) already bound job retries, and P5-002 owns the run lifecycle. This ticket makes
  the existing policy *legible* — TASK-010 is a visibility requirement, not a scheduling one.
- **It does not add a retry TRIGGER.** Nothing here re-runs a failed task. That is the coordinator's.
- **No support bundle.** The backlog's rollback column names one; it needs the artifact storage P5-011 owns.
- **No provider-health banner** (`FAILURE-AND-RECOVERY` row 2). That is a platform-wide signal, not a per-run detail.

## 6. What this ticket does NOT serve — the other twelve rows, and who owns them

Both review passes independently found the header's "all 16 rows" to be a scope overclaim, so here is the count.
**Served: rows 1 and 4, plus the per-run half of 2 and 3.** The rest are real gaps with real owners, and naming them
converts twelve silent absences into recorded ones.

| Row | Failure | Not served because | Owner |
| --- | --- | --- | --- |
| 2 | Provider outage | The per-run detail is served; the platform-wide *degraded* banner is not a per-run fact | P6/observability |
| 3 | Invalid structured output | Folded into `provider_error`; canon's *"bounded re-asks"* has no representation here | P5-010 (gateway) |
| 5 | Queue/job-store outage | *"Cannot start work right now"* is a pre-run state with no run to describe | P5-001c |
| 6 | Database outage | Platform status, not a run detail | ops |
| 7 | Object-storage failure | Needs artifacts to exist | **ACBP-P5-011** |
| 8 | Tool/API failure | **The one row that cites TASK-006 by name**, and it is unserved: the runtime collapses every thrown step into `provider_error`, so a tool failure is indistinguishable from a provider fault. Splitting them is what would let row 8's *"Required"* idempotency be honoured | P5-006/007/008 |
| 9 | Expired authorization | Approvals do not exist yet | **Phase 6** |
| 10 | Revoked integration | Integrations are post-MVP | post-MVP |
| 12 | Partial completion | Needs checkpoints, which do not exist | P5-001b/c |
| 13 | Usage-recording failure | Ledger-side | **ACBP-P5-014** |
| 14 | Audit-event failure | Audit-side, fail-closed already | P1-008 |
| 15/16 | Emergency stop / company pause | Owner-initiated holds, not failures | **ACBP-P6-007** |

**Other clauses this ticket does not meet, said plainly:**

- **"Failure-injection tests"** (the backlog's required-tests column). Nothing here *injects* anything: the contract
  tests construct input objects and the integration tests write already-failed rows. The 16-scenario injection matrix
  is **ACBP-P7-008**'s ("Failure-injection pass"), which already exists in the backlog and is the right owner.
- **"Charging rules applied"** (usage column). Unaddressed here; the charging rules live in **ACBP-P5-014**'s
  `settleRun`.
- **"Support bundle"** (rollback column). Needs artifact storage. **ACBP-P5-011** is the owner, and note its backlog
  row does not currently carry that obligation — if P5-013 is marked Done without moving it, the obligation evaporates.
- **`attemptsAllowed` is borrowed.** It reports `DEFAULT_RETRY_POLICY.maxAttempts`, which is the **job** retry policy
  from P5-001c. Nothing bounds `task_runs.attempt` at all — `startRun` accepts any integer ≥ 1. So the number is a
  standing-in ceiling, not this run's cap, and a run-attempt cap is genuinely missing from the system.
- **NFR-007 is cited and not enforced here.** This ticket makes the existing bound *legible*; it adds no bound. The
  value is named `retry_eligible` rather than `scheduled` precisely so it does not assert a retry nothing performs.

## 5. Slice plan

1. CDR-059 + branch + draft PR.
2. Contracts: `RunFailureDetail`, the closed summary map, `describeRunFailure` — TDD, pure, total.
3. Activity: project `task.failed` (the deliberate ACT-005 widening) + its redacted DTO.
4. Core: surface the detail on the run read; real-PG proof that a failed run renders a complete detail and that the
   feed carries it.
5. Docs + **TWO** independent review passes + finalization.
