# CDR-047 — Gateway v2: fallback model (ACBP-P5-009, NFR-019)

Status: proposed by the implementing session. Governs **ACBP-P5-009**. Depends on ACBP-P2-003 (merged). Governing
ADR: **ADR-011**. Security note: **trust-critical #19**.

## 1. What canon asks for

Backlog row `ACBP-P5-009`:

- **Objective:** "Claude Sonnet 4 fallback adapter; eligibility rules; **no silent fallback for material decisions**;
  fallback reason recorded"
- **Acceptance:** "Eligible classes fall back; material classes never silently; **reason recorded**"
- **Required tests:** "**Silent-fallback negative tests** (trust-critical)"

## 2. What already exists, and what genuinely does not

Checked against `model-gateway.ts` / `contracts/model/gateway.ts` / `database/src/schema.ts` before writing anything,
the same discipline that saved P5-010 from re-implementing a working mechanism.

| Clause | Status |
| --- | --- |
| A fallback provider slot | **exists** — `ModelGatewayDeps.fallback?: ResolvedProvider` |
| Fallover on retryable exhaustion | **exists** — `runProvider` on the primary, then the fallback |
| Eligibility rules per task class | **exists** — `isFallbackEligible(request.taskClass)` gates the fallover |
| No silent fallback for quality-bearing generation | **exists** — generation is ineligible by that predicate |
| Usage accumulated across primary + fallback | **exists** — `usage = addUsage(usage, run.usage)` |
| `fallbackUsed` surfaced and persisted | **exists** — on the result and as `usage_events.fallback_used` |
| **Fallback REASON recorded** | **MISSING** — `fallback_used` is a bare boolean; nothing anywhere records *why* |
| **Silent-fallback negative tests** | **MISSING** — no test asserts an ineligible class does NOT fall over |

- **G1 — the ticket's real deliverables are the two MISSING rows.** As in P5-010, the mechanism is not rebuilt: a
  second fallover path would be two behaviours that can disagree about when a material decision may be downgraded,
  which is the worst possible thing to be ambiguous about.

## 3. Load-bearing reading — "reason recorded" is not the same as "fallback happened"

`fallback_used: true` answers *whether*. NFR-019 and the acceptance criterion both say **reason**, and the difference
is operational: an owner or an on-call engineer looking at a degraded answer needs to know it was downgraded
*because the primary timed out* versus *because the primary was rate-limited* versus *because the primary was
unavailable*. Those imply completely different responses, and a boolean collapses them into "something happened".

- **G2 — the reason is the NORMALIZED error category that triggered the fallover**, drawn from the existing closed
  `ModelErrorCategory` set — never provider text. Reusing the taxonomy keeps it reviewable and keeps raw provider
  strings out of the ledger, exactly as `error_category` already does.
- **G3 — it is recorded on the USAGE EVENT, beside `fallback_used`.** That row is already the append-only, per-call
  record the reconciliation path reads; putting the reason anywhere else would mean joining two stores to answer one
  question. Additive column, nullable — **null exactly when `fallback_used` is false**, which a CHECK can enforce so
  the pair can never contradict itself.
- **G4 — no new audit event.** A fallback is an execution detail of one model call, not a state change in the
  company's history; the usage ledger is where per-call facts live (the CDR-026 precedent).

## 4. The negative is the point of the ticket

"Trust-critical #19" and the Required tests name **silent-fallback negatives**, not fallback tests.

- **G5 — the decisive test is that an INELIGIBLE class does NOT fall over even when a fallback is configured and the
  primary fails retryably.** The call must fail on the primary, and `fallback_used` must be false. A suite that only
  proved eligible classes *do* fall back would pass on a gateway that silently downgraded everything — which is the
  precise failure NFR-019 exists to prevent.
- **G6 — and it must be provably not vacuous.** The same configuration with an *eligible* class must fall over. Two
  tests, one control: without the control, a gateway with a broken fallback path passes the negative for the wrong
  reason.
- **G7 — a material decision that fails must fail HONESTLY** — the caller sees the primary's normalized error, not a
  quietly-degraded success. Invariant 20: user-facing status is always truthful.
- **G8 — eligibility is NECESSARY, not SUFFICIENT: the trigger must also be RETRYABLE.** An eligible class whose
  primary fails with a terminal category (`invalid_output`, `content_refused`) must NOT fall over. Those failures are
  deterministic — the same prompt yields the same shape from a second model — so a fallover would spend a second
  provider's budget re-running a bad prompt and then attribute the failure to the wrong model.
  *Added during the second review pass:* the suite covered ineligible-class-does-not-fall-over but not
  eligible-class-on-a-non-retryable-failure, so half the predicate was unpinned.
- **G9 — when BOTH providers fail, the two facts stay distinct**: `fallback_reason` is why we LEFT the primary,
  `error_category` is how the call finally died on the secondary. *Added during the first review pass* — this is the
  case an on-call engineer actually hits during a broad outage, and collapsing the two would lose the fact that a
  fallover was attempted at all, which is the difference between "one provider is down" and "both are".

## 5. "Claude Sonnet 4 fallback adapter" — deliberately NOT built here

The Objective names a concrete adapter. Building a live Anthropic adapter is not reachable from this session:

- **G8 — the adapter is deferred, and this is recorded rather than silently skipped.** Provider selection and the
  pinned identifiers are P0-001 (Done), but *exercising* a live provider requires paid API access, which is the
  standing **ACBP-P2-011** owner gate. The gateway is provider-neutral by construction — `ResolvedProvider` is an
  interface, and the fake provider already substitutes for it in every test — so the fallback BEHAVIOUR is fully
  provable without any real adapter. What is not provable here is that a specific vendor SDK conforms, which is what
  the gate is for.
- This ticket therefore delivers the eligibility + reason + negative-test half, and leaves an explicit note that the
  concrete adapter needs the owner gate. Marking the row Done while claiming a live adapter exists would be the
  hollow-success failure invariant 20 forbids.

## 6. Out of scope

The re-ask/validation half of the gateway (**P5-010**, merged). Live-model conformance (**P2-011**, owner gate).
Execution and the coordinator (P5-002/P5-005). No new authz action, no HTTP route, no UI.

## 7. Slice plan

1. CDR-047 + branch + draft PR.
2. Contracts + migration: the `fallback_reason` column (nullable, closed category set, CHECK-constrained against
   `fallback_used`) and the usage-event field.
   *Corrected during the first review pass:* this slice originally also listed "the reset-list/catalog sweep". No
   sweep is needed — `fallback_reason` is a COLUMN on the existing `usage_events` table, not a new table, so no
   reset list gains an entry and the catalog's table set is unchanged. Overstating the work would have made the
   plan look incomplete when it was finished.
3. Gateway: record the triggering category; the silent-fallback negative suite (§4-G5/G6/G7).
4. Docs + TWO independent review passes + finalization, including the deferred-adapter note (§5-G8).
