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

## §7.5 — Implementation map (traced 2026-08-15; slice 3 starts here)

Recorded because tracing it was most of the work, and because it revealed a layer §1 did not anticipate.

**The routes do not call the use cases directly.** Every existing route follows one shape
(`apps/web/src/server/companies/companies-request.ts`):

```
const runtime = await runtimeOf(deps);              // memoized ClerkIdentityRuntime
const ctx = await resolveActorWithAccount(deps, runtime);
if ('kind' in ctx) return ctx.result;               // unauthenticated / rate_limited / …
const r = await runtime.editRoadmap({ userId, accountId, companyId, … }, {});
switch (r.status) { … }                             // domain result → CompaniesRequestResult
```

So the four generate use cases must first be **bound onto the runtime** in
`packages/core/src/composition/clerk-identity.ts`, each with a gateway from `createAnthropicGateway`. **That
binding is the money-touching step**, not the route files: it is where the paid provider is attached to a use
case, and it is the first place in this repository where that has ever happened. It deserves its own review
attention, separately from the HTTP plumbing above it.

**What already exists and does NOT need building:**
- `rate_limited` is already in the `CompaniesRequestResult` union and already maps to **429 + `Retry-After`**
  (`companies-http.ts:262`, via `rateLimitedResponse`, which floors the header at 1 second).
- `resolveActorWithAccount` already returns the throttle outcome, so the per-SESSION ceiling already applies.

**What is genuinely new:**
1. A `budget_exhausted` arm on the result union → **402, and deliberately no `Retry-After`** (§4). This is the
   whole of §6.4's distinguishability: same envelope, different status, and the *presence or absence* of
   `Retry-After` is the second signal a caller can branch on without parsing a body.
2. The **company** limiter call — distinct from the session one already in `resolveActorWithAccount` — whose
   `throttled` outcome must return before the use case is invoked.
3. Four request-layer functions and four route files.
4. The coverage checker (§6, and see below).

### The checker, and the vacuity trap it has to avoid

Model on `tools/check-rate-limit-coverage.mjs`, which already walks route imports transitively to prove every
handler reaches `verified-identity.ts`. The generate-route analogue must prove each reaches **both**
`checkAuthorization` and the company limiter.

**It must not be written before the routes exist.** A checker that discovers zero generate routes and reports
success is the exact artefact the standing rule in `AUTONOMOUS-RUN-LOG.md` warns about — a check that could not
have told you otherwise. It therefore lands in the same commit as the routes, and it needs a floor assertion
(`expect(discovered.length).toBeGreaterThanOrEqual(4)`) so an empty walk fails loudly, exactly as the
secret-egress SOURCE GUARD does.

**Reachability is necessary but not sufficient**, and this is the subtle half: a route that *imports* the limiter
and ignores its result passes a transitive-import walk. Proving the result is *consulted* needs either an AST
check (the call's result must reach a branch) or a behavioural test per route. Decide which before building —
the import walk alone would reproduce P6-010's shipped-but-unread ceiling while appearing to guard against it.

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

---

## §9 — OWNER RULING 2026-08-15: lazy gateway construction + a non-fatal boot log

**A refinement of CDR-090 §1-G3, explicitly NOT an override.** §1-G3 ruled that a missing model credential should
fail visibly at startup rather than surprising a founder mid-request. That reasoning stands. What was not in view
when it was written is the **blast radius**: the gateway's only home is the identity runtime, a single memoized
object serving every route, so enforcing §1-G3 by construction would mean a deployment without a model key can
serve **no route at all** — including the 32 that never touch a model.

The ruling therefore keeps both properties instead of trading one for the other:

1. **Serving stays lazy.** The gateway is built on first metered call and memoized. A missing key disables the
   four metered routes and nothing else; a metered call without configuration rejects with
   `MODEL_GATEWAY_NOT_CONFIGURED`, naming the cause and carrying no key material.
2. **Startup stays visible.** The web composition root attempts `parseModelProviderConfig` at boot and logs at
   **error level** when it is absent or unparseable — then continues. An operator sees the same signal §1-G3
   wanted, at the same moment, without the availability cost.

The log is deliberately error-level rather than warn: this is a real misconfiguration for any deployment meant
to generate, and warn-level is where such lines go to be filtered out. It is equally deliberately non-fatal.

---

## §10 — ⚠️ THE 402 BRANCH IS DOCUMENTED BUT UNENFORCED — no code path can trigger it

**Asked directly by the owner, and the honest answer is no.** Nothing in the four generate routes reserves or
consumes a company's credit. Verified rather than recalled, 2026-08-15:

- `strategy-generation.ts`, `strategy-recommendation.ts`, `roadmap-generation.ts`, `task-generation.ts` contain
  **zero** references to credit, and zero to policy evaluation.
- `packages/core/src/billing/credit-service.ts` exports `preflightRun`, `reserveCredit`, `settleRun` and
  `readCreditLedger`. Its only non-test importers are the migration that created its table and
  `policy-service.ts` — and `policy-service`'s single match is a **comment** mentioning `preflightRun`, not a
  call. Every other importer is an integration test or a `test-support` journey.

**Consequence, stated plainly: the 402 status CDR-091 §2.4 committed to has no trigger condition. It is
unreachable in the shipped system.** The mapping exists and is correct; nothing can reach it, because nothing
debits a company's balance on a generate call.

This is recorded the way ACBP-P7-008 recorded its two unmeetable scenario rows: as a criterion **disclosed as
not met**, not quietly dropped and not restated as if satisfied. **402 must not be reported as a functional
guarantee** in any completion summary for this ticket.

**Why wiring it is NOT in this ticket's scope.** Credit consumption is a preflight → reserve → call → settle
sequence with idempotency at each step, on the exact path where defect D9 produced a double charge. That is the
work the credit system's idempotency exists for, and it is a ticket of its own — attaching it to an HTTP-wiring
slice would give a money path the review attention of a route change. **What §6.4 can honestly claim after
Slice 3b is narrower: that 429 and 402 are distinguishable by status and by `Retry-After`'s presence.** That the
402 arm is *reachable* is a separate claim, and it is currently false.

**Follow-on ticket required** before any launch that meters generation: wire `preflightRun`/`reserveCredit`/
`settleRun` into the four generate use cases, with the double-charge guard mutation-tested the way CDR-091 §3
demanded of retry. **Filed 2026-08-15 as ACBP-API-009**, a backlog row rather than this footnote, because
P6-010's spend ceiling shipped unread and was nearly lost exactly this way.

---

## §11 — Slice 3b: the consultation-proof decision §7.5 left open (decided 2026-08-16)

§7.5 ended by requiring a choice before building: prove the limiter's result is *consulted* by an **AST check**
(the call's result must reach a branch) or by a **behavioural test per route**. Recording the choice and the
reasoning, because the wrong one reproduces P6-010 while looking like a guard against it.

**Decided: behavioural test per route, with the checker restricted to reachability.** Neither instrument is
asked to do the other's job.

| | The checker (`tools/check-generate-route-coverage.mjs`) | The behavioural tests |
|---|---|---|
| Proves | each generate route *reaches* the enforcement points | the enforcement *changes the outcome* |
| Fails when | a route is added that bypasses the request layer | a limiter result is ignored, or a refusal is not forwarded |
| Cannot see | whether a reached result is acted on | a fifth route added next year with no test |

**Why not the AST check.** It would assert that `checkRequestLimit`'s return value flows into a branch — which
is a *proxy* for the property that matters. A route can branch on the outcome and still call the use case in
both arms; the AST is satisfied and the money still leaves. Worse, it is brittle in the direction that
punishes correct code: an early-return helper, a `switch`, or a destructure into a variable used two lines
later are all legitimate shapes an AST matcher has to be taught individually, and every such lesson is a
chance to accept a shape that does not actually refuse. **The behavioural test asserts the real property
directly: when the ceiling says throttled, the metered use case is never invoked.** A spy proves absence of
the call, which is exactly the thing a bypass would have to do.

**Why keep the checker at all, then.** It answers the question the tests cannot: *does this hold for a route
nobody wrote a test for*. The tests are per-route and a fifth generate route added later would simply have
none. The checker enumerates from the filesystem, so a new route joins the checked set the moment it exists.

**The floor assertion is load-bearing.** The checker must refuse to pass when it discovers fewer than four
generate routes. Without it, a rename of the route directory turns the whole guard into a check that could not
have failed — the exact defect the standing rule at the top of `AUTONOMOUS-RUN-LOG.md` was written for, and the
reason §7.5 said the checker must not exist before the routes do.

**Authorization is proven at a different layer, deliberately.** The request layer makes no authorization
decision (CDR-088 §1) — core does, inside each use case. So a request-layer test with a fake runtime cannot
witness the authz matrix at all, and a test that appeared to would be testing its own fake. The three layers
are therefore: the matrix itself (`authz.test.ts`, mutation-proven M-AZ1/M-AZ2 in §6.1), core's real-PostgreSQL
refusal of a viewer (existing suites), and — new here — that a `forbidden` from core is *forwarded* as an
opaque 403 rather than absorbed. The middle layer is the one that would catch a route wired to a stub, and it
is real-PostgreSQL, which is why zero-skip CI is the only place this ticket's authz claim can be made.

---

## §12 — Slice 3b mutation results (run 2026-08-17)

Every §6 guard, broken one at a time. Each edit was applied, **read back from disk and hashed** before the
suite ran, then restored and hashed again — the harness aborts rather than reporting a result when the edit did
not land, because a mutation that never applied and still "passed" is the false-survival this repository has
already been burned by once.

| | The mutation | What it breaks | Result |
|---|---|---|---|
| M-3B1 | `throttled` recognised but the refusal is not returned | rate-limit **obedience** (§6.2) | **KILLED** — 4 red in `companies-request.test.ts`, one per metered surface |
| M-3B2 | `generateTasksForRequest` switched to the unmetered resolver | rate-limit **reachability** (§6.2) | **KILLED** — checker reports 2 problems; 3 red behaviourally |
| M-3B3 | an unreadable company bucket admitted instead of refused | **fail-closed** (§6.3) | **KILLED** — 4 red |
| M-3B4 | `budget_exhausted` answered with 429 + `Retry-After` | **402 vs 429** (§6.4) | **KILLED** — 2 red in `companies-http.test.ts` |
| M-3B5 | `strategy:generate` widened to admit `viewer` in the matrix | **owner-only** (§6.1, re-confirming M-AZ1) | **KILLED** — 1 red in `authz.test.ts` |
| M-3B6 | the request layer answers core's `forbidden` with `not_found` | refusal **forwarding** (§11) | **KILLED** — 2 red |
| M-3B7 | `lazyGateway` reverted to eager `modelGateway()` for one binding | the §9 lazy-construction ruling | **KILLED** — 2 red in `generate-binding.test.ts` |

**M-3B1 is the row that justifies the two-instrument split**, and it is recorded rather than summarised
because the number that matters is the one that did *not* move: with the same edit in place the coverage
checker **passed**, reporting all four handlers as reaching the ceiling. It is a structural check and the
literal `limit.kind === 'throttled'` was still on the line — only the `return` was gone. That is precisely the
division of labour §11 decided, demonstrated rather than asserted, and it is why the behavioural tests are not
redundant with the checker.

**The checker was validated against a deliberately broken repository before it was trusted**, in the order
§7.5 required: four probes were run against real trees — an unmetered fifth generate route, a renamed money
route, a metered function switched to the unmetered resolver, and a *gutted helper* that every route still
called. All four failed the check. They are no longer one-off probes: each is pinned as a permanent case in
`tools/tests/check-generate-route-coverage.test.mjs`, alongside the ways the check could quietly stop checking
(a vanished directory, an empty API tree, a route with no `POST`, an unresolvable import).

**What these results are NOT.** They are local. Nothing here is a hosted-CI mutation run, so no row above may
be recorded as `measured` in `tools/trust-critical-index.mjs` under the rule in that file's header. And the
authz claim that matters most — a *viewer* being refused by core against real PostgreSQL — cannot be made
locally at all: PostgreSQL is reachable only inside the WSL distro on this machine and not from the Windows
host, so 1,672 tests skipped locally. Zero-skip hosted CI is the only place that claim can be made.
