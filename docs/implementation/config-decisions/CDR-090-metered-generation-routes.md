# CDR-090 — HTTP routes for metered generation

**Status:** PARTIAL — settled where it can be settled, **BLOCKED on ACBP-P2-011** for every number that
needs a real provider to measure. · **Ticket:** ACBP-API-006 · **Base:** `main` at `cf769bc`.

> ⚠️ **READ THIS BEFORE §3. LANDED LATE, AND PARTLY SUPERSEDED.**
>
> This document was written 2026-08-14 and reached `main` on 2026-08-22 — it sat on the branch
> `p8-api-006-cdr` with **no pull request tracking it**, while `CDR-091` and `API-BACKLOG.csv` (both merged)
> cited it as governing. CDR-091's own link to it was broken for eight days.
>
> **§3.1–§3.5 are SUPERSEDED by [CDR-091](CDR-091-model-gateway-live-provider.md).** It settled four of the
> five numbers this document refused to default, and says so in its own header: *"Everything CDR-090 settled
> (§1 composition, §2 error envelope) stands unchanged."* So §1, §2 and the G-rulings below are LIVE — G3 in
> particular is what `API-BACKLOG.csv` cites as governing for ACBP-API-012 — and §3 is history.
>
> Read §3 as the record of what was deliberately left open and why, not as a list of open questions.

**Number:** 090. 087–089 are the three shipped route tickets. (When written, 086 was "claimed by
ACBP-P3-006 on an unmerged branch"; that branch merged 2026-08-22 as `dd4d9ae`, so CDR-086 now exists on
`main` and the two numbers no longer collide.)

---

## §0 — Scope, and why this one is NOT pure exposure

Four routes, wrapping four use cases that already exist and are already tested:

| Route | Use case | Action (owner-only since ACBP-API-004) |
|---|---|---|
| `POST .../strategy` | `generateStrategyOptions` | `strategy:generate` |
| `POST .../strategy/recommendation` | `recommendStrategy` | `strategy:recommend` |
| `POST .../roadmap` | `generateRoadmap` | `roadmap:generate` |
| `POST .../tasks/generate` | `generateTasks` | `task:generate` |

**These were held back from the ACBP-API-005 batch on discovery, not on principle.** All four take a
`deps` slot — a fourth positional argument carrying a **model gateway**. Every one makes a live model
call and meters it against account budget. `deleteTask`, the fifth held route, takes no `deps`, was
genuinely pure exposure, and shipped in ACBP-API-005.

Under the owner's process rule these fall on the **full-bar** side: they touch money.

## §1 — THE GATEWAY COMPOSITION QUESTION (settled enough to state, not to build)

**VERIFIED, NOT ASSUMED: the composed runtime has NO gateway.** A search of
`packages/core/src/composition/clerk-identity.ts` for `gateway` returns **zero** matches.
`createClerkIdentityRuntime` builds a database client, a webhook verifier, an identity reader and the
webhook service. Nothing else. All fourteen shipped HTTP routes are database-only, which is why this has
never come up.

So a fifth thing has to be composed, and **that is a real architectural decision, not wiring**:

- **G1 — Where is the gateway constructed?** Almost certainly alongside the database client in
  `createClerkIdentityRuntime`, so `apps/web` never touches a provider SDK — the same boundary that keeps
  `@clerk/backend` in `@acbp/adapters`. **DECIDED IN PRINCIPLE, not in code.**
- **G2 — One gateway per runtime, or one per request?** A runtime-scoped gateway shares connection reuse
  and any client-side rate limiting; a request-scoped one isolates failures. **OPEN.** This is decidable
  without a provider and should be settled when the ticket is built.
- **G3 — What happens when the gateway is absent or misconfigured?** The route must fail CLOSED with a
  bounded envelope, never fall through to a partial result. **DECIDED:** absent gateway ⇒ `unavailable`,
  and it must be a startup-visible failure rather than a per-request surprise.

## §2 — THE ERROR-ENVELOPE CONTRACT (decidable now, and decided)

A model call fails in ways no existing route can produce. `CompaniesRequestResult` today has no arm that
honestly carries them, so the contract is stated here rather than improvised per route:

| Failure | Arm | HTTP | Reasoning |
|---|---|---|---|
| gateway absent/misconfigured | `unavailable` | 503 | Not the caller's fault, not retryable by them |
| provider timeout | `unavailable` | 503 | Same envelope; a `Retry-After` MAY be added once §3.1 has a number |
| provider refusal / content filter | `validation` | 400 | The request was reachable and the domain judged it |
| budget/quota exhausted | **NEW ARM NEEDED** | 402 or 429 | See §3.4 — **BLOCKED** |
| model returned unusable output | `validation` | 400 | The existing `invalid` arms already cover this |

**NON-NEGOTIABLE, and it applies regardless of the open numbers:** provider exception text NEVER crosses
the boundary. The repo's standing rule already forbids returning provider exception text, and the
artifact refusal-string work (CDR-088 §2.1a) is the precedent for how easily a raw provider value
reaches a client when nobody names the hazard.

## §3 — OPEN NUMBERS, EACH BLOCKED ON ACBP-P2-011

**These are NOT defaulted, and must not be.** Picking them without a provider would be inventing
requirements — and every one is a number whose wrong value is expensive in production. What each depends
on is stated so the measurement can be taken once, deliberately, rather than guessed four times.

### §3.1 — Request timeout — **BLOCKED**
Depends on: observed p50/p95/p99 latency of the real provider for each of the four call shapes. Strategy
generation produces a 16-field structured object; a recommendation is far smaller. **They will not share a
timeout, and assuming they do is the error to avoid.**

### §3.2 — Route `maxDuration` — **BLOCKED**
Depends on §3.1, and on the deployment edge's own ceiling — which is itself an OWNER-ACTION-PACK item
(the deployment edge is undecided). A `maxDuration` shorter than the p99 turns a working call into a
truncated one; longer than the platform allows is silently ignored.

### §3.3 — Rate-limit ceiling — **BLOCKED**
The existing `check:rate-limit-coverage` ceiling was sized for **reads**. Applying it unchanged to a paid
call would be far too permissive: a read costs a query, a generation costs money. Depends on the observed
per-call cost and on the account budget model. **The guard will pass either way, which is exactly the
trap** — coverage is not calibration.

### §3.4 — The budget-exhausted arm and its status code — **BLOCKED**
402 (Payment Required) versus 429 (Too Many Requests) is not a style choice: it tells a client whether to
retry later or to buy more. Depends on how the credit ledger (ACBP-P5-014) reports exhaustion and whether
exhaustion is per-account or per-period.

### §3.5 — Retry policy — **BLOCKED**
Whether a timed-out generation may be retried automatically depends on whether the provider call is
idempotent from the meter's perspective. **If a retry double-charges, the answer is no**, and that fact
comes from the provider's billing semantics, not from this repo.

## §4 — What CAN be built before P2-011 lifts

Nothing that would need a blocked number, which is most of it. Specifically **NOT** the routes.

What is safe to prepare, if the owner wants the ticket moving: the `unavailable` mapping in §2 (which any
gateway failure needs regardless of timing), and G2's runtime-versus-request scoping decision. Neither
requires a provider. **Both are small, and neither unblocks the routes on its own**, so there is a real
case for simply waiting rather than banking partial work.

## §5 — Verification standard when it does unblock
Full bar: TDD with each test watched to fail, real-PostgreSQL proof, the §4-equivalent adversarial matrix,
mutation testing on any genuinely new guard, two independent review passes, exact-head CI green with zero
skips. Metered generation touches money — this is the category the owner explicitly kept at full bar.
