# ACBP-P5-009 — independent review coverage

Ticket: **ACBP-P5-009** Gateway v2, fallback model (NFR-019; trust-critical #19). Branch
`p5-009-gateway-v2-fallback`, PR **#47**, CDR-047.

Both passes returned **FAIL**. Each found a **missing case in a trust-critical negative suite** — which is the
failure mode this ticket is most exposed to, because the whole deliverable is "prove the thing does not happen".

## Before the passes — what already existed

Checked clause by clause before writing code, the discipline that stopped P5-010 rebuilding a working mechanism. From
P2-003/CDR-026 the following were **already present**: the fallback provider slot, the fallover on retryable
exhaustion, `isFallbackEligible` per task class, generation's ineligibility ("no silent fallback"), usage accumulated
across primary + fallback, and the `fallback_used` flag on the result and the ledger.

Two clauses were **missing**, and they are this ticket:

1. **The fallback REASON.** `fallback_used` answers *whether*; NFR-019 says **reason**.
2. **The silent-fallback negatives.** Nothing asserted that an ineligible class does *not* fall over.

## Pass 1 — FAIL (0 Blocker, 0 Critical, 0 High, 2 Medium)

### MEDIUM-1 — nothing covered BOTH providers failing

The suite covered "fallover succeeds" and "fallover refused". It did not cover the case an on-call engineer actually
hits during a broad outage: the primary fails, the fallover happens, and the **secondary fails too**.

That case is where the two fields have to stay distinct — `fallback_reason` is why we *left* the primary,
`error_category` is how the call *finally died* on the secondary. If a future change collapsed them, the record would
lose the fact that a fallover was attempted at all, which is the difference between "one provider is down" and "both
are". Now asserted with two different categories, so a collapse fails loudly.

### MEDIUM-2 — CDR-047 §7 overstated the work

The slice plan listed "the reset-list/catalog sweep" for slice 2. There is no sweep to do: `fallback_reason` is a
**column on an existing table**, not a new table, so no reset list gains an entry and the catalog's table set is
unchanged. Left uncorrected, the plan would have read as incomplete when it was in fact finished — the same class of
inaccuracy as claiming coverage that does not exist, pointed the other way.

## Pass 2 — FAIL (0 Blocker, 0 Critical, 0 High, 1 Medium)

### MEDIUM-1 — half the fallover predicate was unpinned

The suite proved that an **ineligible class does not fall over**. It never proved that an **eligible class does not
fall over on a NON-RETRYABLE failure**. Eligibility is necessary but not sufficient — the trigger must also be
retryable infrastructure.

This matters concretely: `invalid_output` and `content_refused` are deterministic. The same prompt yields the same
shape from a second model, so falling over would spend a second provider's budget re-running a bad prompt and then
attribute the failure to the wrong model. `isRetryableModelError` already excludes them; nothing asserted the
gateway honours that on the **fallover** path rather than only on the retry path. Now pinned, and recorded as
CDR-047 §4-G8.

## The named adapter is DEFERRED, and the record says so

The Objective names a "Claude Sonnet 4 fallback adapter". Exercising a live provider needs paid API access — the
standing **ACBP-P2-011** owner gate. The gateway is provider-neutral by construction (`ResolvedProvider` is an
interface the fake already substitutes for), so the fallback **behaviour** is fully proven here; what is not proven
is that a specific vendor SDK conforms, which is exactly what the gate exists for.

This ticket delivers the eligibility + reason + negative half. Marking the row Done while implying a live adapter
exists would be the hollow-success failure invariant 20 forbids.

## The migration-safety decision, recorded as a test

Migration 0030's natural constraint is symmetric: a reason exactly when `fallback_used`. That was written first and
removed. Rows written **before** the migration carry `fallback_used = true` and no reason, so `ADD CONSTRAINT` would
have failed against existing data — passing in CI, where the schema is rebuilt every run, and breaking the first real
deployment carrying history.

The shipped constraint is one-directional, and the asymmetry is pinned by its **own real-PG test** rather than only a
comment, so anyone who later "tightens" it fails a test with the reason attached.

## Requirement coverage

| Clause | Where |
| --- | --- |
| "eligibility rules" | `isFallbackEligible` (pre-existing), pinned by the negative + control pair |
| "no silent fallback for material decisions" | generation does not fall over even with a healthy fallback configured |
| "fallback reason recorded" | `usage_events.fallback_reason`, normalized category, closed set enforced by CHECK |
| "reason recorded" ↔ never contradictory | one-directional CHECK + the never-fell-over test |
| "Silent-fallback negative tests (trust-critical)" | 8 tests, including the control that stops the negative passing for the wrong reason |
| "Claude Sonnet 4 fallback adapter" | **DEFERRED** — needs ACBP-P2-011 (live model access) |

## Evidence

| Head | Run | Result |
| --- | --- | --- |
| `1a11208` (contract + migration + wiring) | 30241856745 | 1954/1954, 0 skipped |
| `354d736` (real-PG proof of 0030) | 30242818022 | **1962/1962**, 0 skipped |
| `d7a7b8a` (pass-1 findings) | — | **1963/1963**, 0 skipped |
| final head (pass-2 findings) | see PR #47 | recorded at merge |

The unit portions run locally in ~1s; the migration constraints are proven only by hosted CI, since local PostgreSQL
is unreachable from this machine.
