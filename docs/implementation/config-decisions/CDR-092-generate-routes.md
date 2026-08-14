# CDR-092 — Wiring the four generate routes to the model gateway

**Ticket:** ACBP-API-008 · **Depends on:** ACBP-API-006 (CDR-091, the live gateway) · **Bar:** FULL
**Status:** Design accepted; implementation in progress.

The four routes that spend real money:

| Route | Method | Core use case | Authz action |
|---|---|---|---|
| `/api/companies/{companyId}/strategy/generate` | POST | `generateStrategyOptions` | `strategy:generate` |
| `/api/companies/{companyId}/strategy/recommend` | POST | `recommendStrategy` | `strategy:recommend` |
| `/api/companies/{companyId}/roadmap/generate` | POST | `generateRoadmap` | `roadmap:generate` |
| `/api/companies/{companyId}/tasks/generate` | POST | `generateTasks` | `task:generate` |

All four are **owner-only** under the viewer ruling (ACBP-API-004): a viewer reads; spending account budget is
an owner action. The check lives in `@acbp/core`, not in the route — same as every other route here.

---

## §0 — Why this is at the full bar

Every previous route slice in this phase was a *read*. These four are the first HTTP surface that causes a paid
provider call, and the owner set the bar explicitly: **this project has already shipped one double-charge bug on
a money path (D9), and the credit system's idempotency exists because of it.** A route that spends money on a
verb a viewer can reach, or that retries where retry is unsafe, is not a cosmetic defect.

Concretely that means: CDR before code, TDD, real-PostgreSQL proof, mutation tests on the rate-limit and
owner-only guards specifically, two independent review passes before any completion claim, and exact-head then
exact-main CI green with zero skips.

---

## §1 — ~~The domain surface has to open first~~ → **RETRACTED: it is already open**

> **This section originally claimed none of the four use cases was exported from `@acbp/core`, and that wiring
> the routes would require widening the public surface. That was wrong, and no code change is needed here.**
>
> All four functions, their params/deps/options/result types, and `createAnthropicGateway` are exported today:
> `strategy/index.ts` and `planning/index.ts` export the use cases, `composition/index.ts` exports the gateway,
> and `packages/core/src/index.ts` re-exports all three with `export * from './<dir>/index.js'`.
>
> **How the error was made, because the shape recurs.** The claim came from grepping `index.ts` for the function
> names. With `export *`, those names are never written in that file — so the grep could only ever report "not
> found", whatever the truth was. It was a measurement that could not have come out differently, which is the
> same defect as reading a `skipIf`-skipped suite as proof nothing broke, and as running the wrong build command
> twice and calling it corroboration. All three passed unnoticed because the output *looked* like evidence.
>
> **The correction is pinned by a test, not by this paragraph.** `composition/generate-surface.test.ts` imports
> from the package root and asserts each symbol resolves — an anchor that fails if a future refactor drops one
> from a sub-barrel, where a name-grep would keep passing. That test is the deliverable of this slice; the CDR
> text is just the record.

What still holds, and is worth keeping: `apps/web` may reach the domain **only** through `@acbp/core`
(`tools/check-boundaries.mjs`), and **the provider, the SDK client, and anything from `@acbp/adapters` must not
leak out with them.** The route receives a composed gateway from core's composition layer; it never builds one.

---

## §2 — Rate limiting: extend the scoped limiter, do not build a second one

A per-company ceiling is a **new scope on the existing limiter**, not new machinery. `RequestLimitService`
already takes a `RateLimitScopeKind` and consults a real-PostgreSQL token bucket (`consumeBucket`), and
`RequestLimitOutcome.throttled` already carries `scope` so a caller can tell *which* ceiling bound.

Today `RateLimitScopeKind = 'session' | 'account'`. This adds `'company'`:

- `packages/database` — widen the union and the bucket's scope column check.
- `packages/config` — add `companyPerMinute` to `REQUEST_LIMIT_DEFAULTS` (currently `sessionPerMinute: 60`,
  `accountPerMinute: 300`).
- `packages/core` — add a `COMPANY_RULE` to `RULES`.

**Reusing it buys three properties for free, and each one would otherwise have to be rebuilt and re-proven:**
fail-closed on an unreadable bucket (reported `unavailable`, never `throttled` — refusing to lie about *why*),
no write to `usage_events` for a throttled request (a throttled call did no metered work, and inflating the
ledger would make the spend cap and the reconciliation job disagree), and a `scope` on the refusal so a throttled
founder can tell "I am clicking too fast" from "my company is busy".

### §2.1 — ⚠️ PROVISIONAL: 5 requests per minute per company

Per CDR-091 §2.3. **This number is an estimate and is marked provisional in three places** (§7).

The reasoning, such as it is: every call spends real money, so the ceiling is deliberately far below the
read-sized ones — `accountPerMinute` is 300, and applying anything near that to a paid call would be a spend
hazard disguised as a rate limit. Single digits per minute is a *shape* judgement, not a measurement: nobody has
observed how fast a founder actually wants to regenerate a strategy, nor what a generation costs.

**It is the ceiling, not the spend cap.** NFR-015's budget ceiling bounds money per company per day and month
from `usage_events`; this bounds request frequency. They share no key, window, unit or storage, and one request
can spend an unbounded amount while a thousand spend none.

---

## §3 — ⚠️ PROVISIONAL: timeouts (60s provider / 90s route)

Per CDR-091 §2.1 and §2.2, and **both numbers are unmeasured** — see CDR-091's §2 validation block. No live model
call has ever completed from this repository, so the inner/outer split is a guess with a plausible shape:

- **60s** provider deadline — generation calls (16-field strategy, roadmap, task plans) are slower than simple
  completions, and 60s gives headroom without hanging a request indefinitely.
- **90s** route `maxDuration` — must exceed the provider deadline plus the surrounding work (context assembly,
  the DB write, the credit debit, the audit record) or the route is killed while the provider call is still
  legitimately running, which would bill for a generation the founder never receives.

**If the platform's own maximum duration is below 90s, say so plainly rather than silently capping.** That was
the owner's instruction and it is repeated here because a silent cap is exactly how the inner/outer relationship
gets inverted without anyone noticing.

---

## §4 — Budget exhausted is 402, not 429

Per CDR-091 §2.4. A client must be able to tell **"slow down"** from **"you are out of money"** — they call for
opposite actions: 429 means retry later, 402 means the account needs topping up and retrying will never help.
Reusing 429 for both would make an automated client retry a request that cannot succeed until a human pays.

`Retry-After` is set on the 429 and deliberately **not** on the 402.

---

## §5 — What is deliberately NOT in this ticket

- **No live model call.** Every test uses the fake gateway, exactly as every prior ticket does.
- **No retry above the gateway** — CDR-091 §3 ruled this on evidence, and nothing here reopens it.
- **No new persistence.** The four use cases already own their tables, audits and metering.
- **No frontend.** The standing UI gate holds.

---

## §6 — Guards to mutation-test (not optional; these are the money guards)

1. **Owner-only** — a viewer reaching any of the four must be refused, and the refusal must be indistinguishable
   from a non-member's. Mutate: widen the grant. The suite must fail.

   **✅ PRECONDITION VERIFIED (2026-08-15), and it was checked rather than assumed.** The question asked was not
   "is there a test file" but "would a broken authz check actually be killed" — the same question that exposed
   Slice 2's missing `RequestLimitService` test, where a guard looked covered and was not.
   `packages/contracts/src/authz/authz.test.ts` iterates every action × every role and asserts against its own
   `EXPECTED` matrix, which **independently restates** the grants rather than importing them — so widening a
   grant requires two deliberate edits, and doing only one fails the suite. Confirmed by mutation, both applied
   on disk before the result was trusted:
   - **M-AZ1** — `strategy:generate` widened to admit `viewer` → **KILLED**
   - **M-AZ2** — `task:generate` widened to admit `viewer` → **KILLED**

   So the *matrix* is guarded today. What is **not** yet guarded is the route layer: that each of the four routes
   actually consults that matrix. A route that never calls `checkAuthorization` would leave both mutations above
   still passing, because they test the matrix rather than its use. **That is the guard Slice 3 must add**, and
   it is the same shape as §6.2 below — the difference between a control existing and a control being consulted.
2. **Rate-limit enforcement** — mutate the limiter call away, and mutate `throttled` to fall through as allowed.
   Both must fail the suite. A limiter that is called but whose result is ignored is the exact shape of
   ACBP-P6-010's shipped-but-unread spend ceiling.
3. **Fail-closed on `unavailable`** — mutate it to admit. Must fail.
4. **402 vs 429** — mutate the budget-exhausted mapping to 429. Must fail.

---

## §7 — ⚠️ The PROVISIONAL markers, and where they live

The owner's instruction: the estimates must be impossible to forget. They are marked in **three** places, and a
future session that changes any number is expected to remove all three in the same commit:

1. **At the constants themselves** — a comment on the timeout and rate-limit values naming them provisional and
   pointing here.
2. **In this CDR** — §2.1 and §3 above, both flagged inline.
3. **In `PROJECT-STATE.md`** — an entry stating these four routes need recalibration against real observed
   latency before production use.

The reason for three rather than one: a comment is read only by someone already in the file, a CDR is read only
by someone looking for the decision, and `PROJECT-STATE` is read at the start of a session by someone who does
not yet know either exists. A number that is wrong in production is wrong regardless of which of the three the
next person happened to open.
