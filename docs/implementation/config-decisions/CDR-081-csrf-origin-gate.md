# CDR-081 — CSRF protection for `apps/web` (ACBP-P7-013)

Governing: **NFR-010** (security baseline — the ASVS-aligned control set), `SECURITY-ARCHITECTURE.md` §1
(Authentication boundary / Session management / Authorization); ADR-022 (Clerk), ADR-023 (Next.js delivery
boundary). Origin: **CDR-080 §4**, which ruled that NFR-010's three absent ASVS baseline items — CSRF
protection, HTTP rate limiting, security headers/CSP — become separate implementation tickets rather than
being built inside ACBP-P7-007's verification pass. **This ticket closes exactly one of the three.**

> **THE FIRST QUESTION WAS NOT "WHICH CSRF DEFENCE" BUT "IS THERE ALREADY ONE".** The finding says the
> control is absent; the honest answer could have been *"partially covered by the provider"*. §0 is the
> answer to that question, and it is what the rest of this document rests on. The finding stands: there is
> no CSRF defence on this surface that this repository sets, observes, or can test.

---

## §0 What the scoping established, before any code

### §0.1 The surface, counted rather than estimated

23 route modules exist under `apps/web/src/app/**/route.ts`. Enumerated by their exported HTTP methods:

| | Count | Which |
|---|---|---|
| Carry a state-changing method (`POST`/`PATCH`/`DELETE`) **and are cookie-authenticated** | **16** | company create/rename/pause/resume, provisioning resume, interview start/suspend/resume, interview answer, memory create/edit/delete, account profile edit, member invite/accept/revoke, admin tenant read |
| State-changing and **not** cookie-authenticated | **1** | `POST /api/webhooks/clerk` — signature-verified only, no session, and already bypassed in the proxy |
| Read-only (`GET` only) | **6** | activity, decision room, decision-room stream, interview Q&A, provisioning status, `auth-check` |

`POST /api/admin/.../read` is counted as state-changing on purpose despite its name: ACBP-P1-013 makes it
write a target-tenant audit row before it responds, so a forged invocation forges an audit record.

The 16 authenticate through `resolveVerifiedIdentity` → `auth()` (`@clerk/nextjs/server`), which reads the
**`__session` cookie**. That is an ambient credential: the browser attaches it to a cross-site request
without the page that caused the request having any access to it. That is the whole precondition for CSRF,
and it is met here.

`POST /api/companies/{companyId}/pause` is the clearest single case — `route.ts:13` takes **no request
body** and no header beyond the cookie, so the forgery is a bodyless cross-site form post with nothing for
a content-type check to catch.

### §0.2 Does Clerk already cover this? No — and the reason is sharper than "no"

Three provider-side mechanisms were checked, because each is plausibly a CSRF defence and none is:

1. **`SameSite` on the session cookie.** `__session` is named in `@clerk/backend@3.11.7`
   (`dist/chunk-NVYUROUB.mjs:299`), but the SDK never chooses its attributes: at `:6697` and `:7063` it
   appends handshake `Set-Cookie` values **verbatim** from the handshake payload, which Clerk's Frontend
   API mints server-side. The only `SameSite` the SDK itself writes is on a 2-second handshake *counter*
   cookie (`:6786`).
   **So the attribute that would carry the defence is chosen by the provider, outside this repository, and
   is not observable, assertable or pinnable from here.** Whatever its current value, this codebase cannot
   test it, cannot detect it changing, and does not own the instance setting that selects it. A control
   with no local anchor is not this repository's control — and citing one would be precisely the
   "attribution with no test" artefact ACBP-P7-002 and ACBP-P7-007 exist to destroy.
   Recorded honestly: **this is not a claim that `__session` lacks `SameSite`.** It is a claim that the
   repository cannot know, and that a defence it cannot know about cannot be its answer to NFR-010.
2. **`authorizedParties` (the `azp` claim).** It *is* wired — `packages/adapters/src/clerk/identity.ts:47`,
   fed by `CLERK_AUTHORIZED_PARTIES`. It does not stop CSRF, and the reason is structural rather than
   configurational: `azp` records the origin the token was **minted for**. In a forgery against this app the
   victim's token was minted on this app's own origin, so `azp` matches and the check passes. It stops a
   *different* frontend reusing a token; it does nothing about a *different page* causing a request to ours.
3. **Whether `authorizedParties` is even on this path.** It is not. `proxy.ts:21` calls `clerkMiddleware()`
   with **no options**, and the route path is `auth()`, not `ClerkIdentityProvider`. So the web session
   surface applies no authorized-party check at all. Recorded as a finding (§7.1); it is **not** a CSRF gap
   and fixing it would not close this one.

### §0.3 Same-origin posture, and what the codebase does today

`apps/web` sets **no** CORS headers anywhere, so cross-origin `fetch` cannot read responses and any request
carrying a custom header is stopped by an unanswered preflight. That is real, and it is also the wrong
control: the CSRF-reachable methods are exactly the ones that need no preflight — a cross-site **form**
POST (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`, or no body at all) is a
simple request, is sent, and its side effect lands even though the attacker never reads the reply.

Three bodied routes go through `readJsonObject`, which returns 415 unless the media type is
`application/json` (`companies-http.ts:20`) — a side effect of bounded body parsing, not a CSRF control,
and it protects none of the bodyless routes. `pause`, `resume`, `interview/suspend`, `interview/resume`,
`provisioning/resume`, the member `DELETE` and the admin `POST` read no body at all.

Searched and absent: no `Origin`, `Sec-Fetch-*`, CSRF token, or same-origin check exists anywhere in
`apps/web/src` (grep returns zero). `next.config.ts` sets no `headers()`.

### §0.4 One correction to the finding as written

The finding named `apps/web/src/middleware.ts`. **That file does not exist.** Next.js 16 renamed the
request-interception boundary and this app's is `apps/web/src/proxy.ts` — a rename its own header records,
along with the fact that its *location* is load-bearing (at the project root Next silently ignores it,
which `tools/tests/next-proxy-location.test.mjs` already guards). The scoping instruction to check the
middleware was right; the path had moved.

---

## §1 The ruling: an origin gate, not a token

**A synchronizer or double-submit token is the wrong control for this codebase today, and would be worse
than the gap it closes.**

A token has to be issued to a document and echoed by the client. **This repository has no rendered UI** —
`apps/web/src/app` contains route handlers plus Clerk's `sign-in`/`sign-up` catch-alls, and no page posts
to any of the 16. PROJECT-STATE records the API-first posture at ACBP-P6-008 in those words. So a token
would ship with an issuing endpoint, a cookie, a verification path, and **no producer of a valid token
anywhere in production** — a control that only tests can satisfy.

This repository has a name for that shape and a history with it: ACBP-P6-010's ceiling that no production
caller passes, ACBP-P6-011's usage key that nothing supplies, ACBP-P7-002's predicate with zero production
callers whose docstring made a gap look closed for four phases. Adding a fourth is not caution.

**Ruled: a fail-closed same-origin gate on unsafe methods, enforced at the request-interception boundary.**
It needs no client cooperation, no storage, no migration, and no UI — so it is a real control on the day it
merges rather than a reachable one. It is also strictly *stronger* than a token against the actual threat,
because the two headers it reads (`Sec-Fetch-Site`, `Origin`) are **forbidden header names**: page script
cannot set or remove them, and the browser computes them against the real request target.

### §1.1 The decision table, as a closed vocabulary

Evaluated per request. `SAFE_METHODS = GET, HEAD, OPTIONS` (RFC 9110 safe methods; `TRACE` is not in the
allowlist because Next serves no `TRACE` handler and admitting it buys nothing).

| # | Condition | Outcome | Reason code |
|---|---|---|---|
| 1 | Method is safe | allow | `safe_method` |
| 2 | Path is the Clerk webhook | the gate is never reached | *(no reason code — see below)* |
| 3 | `Sec-Fetch-Site: same-origin` | allow | `sec_fetch_same_origin` |
| 4 | `Sec-Fetch-Site: same-site` | **deny** | `sec_fetch_same_site` |
| 5 | `Sec-Fetch-Site: cross-site` | **deny** | `sec_fetch_cross_site` |
| 6 | `Sec-Fetch-Site: none` | **deny** | `sec_fetch_none` |
| 7 | `Sec-Fetch-Site` present, any other value | **deny** | `sec_fetch_unrecognised` |
| 8 | absent; `Origin` matches an allowed origin | allow | `origin_allowed` |
| 9 | absent; `Origin` present, no match | **deny** | `origin_mismatch` |
| 10 | absent; `Origin` absent | **deny** | `no_provenance` |

**Row 2 is not a verdict and has no reason code**, and the distinction is worth keeping straight because
this table would otherwise describe a function that does not exist. `decideSameOrigin` knows nothing about
paths — it takes a method and two headers. The webhook exemption is the proxy's pre-existing early return
(§2, ordering step 1), which happens *before* the gate is called, so the gate never sees that request at
all. Nine rows are the pure function; row 2 is the caller.

Four of the remaining rows deserve their reasons written down rather than assumed:

- **`same-site` denies.** A site is eTLD+1; an origin is scheme+host+port. A sibling subdomain is a
  different security principal, and `SameSite` cookie semantics — which are site-scoped — are exactly the
  gap this gate exists to not inherit.
- **`none` denies.** `Sec-Fetch-Site: none` means user-initiated with no page context (typed URL,
  bookmark). A browser cannot produce a state-changing request that way. On an unsafe method it is
  anomalous, and anomalous resolves to deny.
- **An unrecognised value denies.** The vocabulary is closed. A future value this build has never seen is
  not evidence of same-origin.
- **Row 10 is the fail-closed core.** Absence of provenance is never permission. This is the row that makes
  the gate a control rather than a filter, and it is the one a later "make `curl` work" change would delete.

`Sec-Fetch-Site` is consulted **first and exclusively when present**, because the browser computes it
against the actual target and it cannot be spoofed by the requesting page. `Origin` is the fallback for
clients that do not send it.

**Duplicate headers land on deny by two different mechanisms, and both are asserted.** `Headers.get()`
*joins* repeated same-name headers with `", "`, so an intermediary sending two of either produces a value
no browser can. `"https://app.example.test, https://evil.test"` does not parse as a URL, so it is treated
as no provenance (row 10); `"same-origin, cross-site"` is not a member of the vocabulary, so row 7 refuses
it. Both would have been *allowed* by the obvious wrong implementations — a substring match on the origin,
or `includes('same-origin')` instead of equality — which is why they are tests rather than a remark.

### §1.2 Which origins are "allowed", and why not the request's own Host

The allowed set is derived from **`APP_PUBLIC_URL`** — an existing, already-validated setting
(`packages/config/src/index.ts:215`, required for the web server, forced to `https://` in production). It is
read as a single environment variable at the boundary rather than through `parseWebServerConfig`, and that
is deliberate: the full parser throws on *any* incomplete web env, and a throw inside the interception
boundary is a 500 on every request including the safe ones. The narrow read cannot do that. This is one
setting read at one place, not a second definition of configuration.

**The rejected alternative is comparing `Origin` against the request's own `Host`.** It would need no
configuration and would defeat the browser threat model perfectly well — an attacker cannot make a victim's
browser send a forged `Origin`. It is rejected because this repository's charter says *browser-controlled
claims never authorize*, and `Host` arrives on the request. Comparing one request-supplied header against
another is the shape that maxim forbids, and a reviewer applying it would be right. A configured origin is
the one value in the comparison that an attacker cannot influence.

**If `APP_PUBLIC_URL` is absent or unparseable the allowed set is EMPTY, and rows 8 and 9 collapse into
deny.** Row 3 still admits modern browsers, because `Sec-Fetch-Site` needs no configuration to be
meaningful. So a misconfigured deployment degrades toward refusing state-changing requests, never toward
accepting them — and the degradation is asserted by a test rather than described here.

---

## §2 Where it is enforced, and why there

**`apps/web/src/proxy.ts`, before `clerkMiddleware()` runs.**

The alternative — a wrapper each route opts into — is rejected on the evidence of this repository's own
history. A per-route control is a control someone forgets on route 17, and CDR-080 §0.2's third live
mutation is exactly that shape: *add a fifth autonomous-work entry point without `readLifecycleDecision`
and nothing fails*. Enforcing at the single boundary every request already crosses means **a route module
that does not exist yet is covered the day it is written**, which is a property no opt-in can have.

Ordering inside the proxy is load-bearing and is asserted:

1. Webhook path → return early, unchanged (row 2). It must stay first: Clerk's servers send no `Origin` and
   no `Sec-Fetch-Site`, so any later evaluation would deny an authentic signed webhook by row 10 — the
   ACBP-P1-002 hazard that put the bypass there in the first place.
2. **The origin gate.** A denial returns before any session is established, so a forged request costs no
   Clerk round trip and reaches no handler.
3. `failClosed(clerkMiddleware())`, unchanged.

A denial is `403 {"error":"forbidden"}` — the same coarse, oracle-free denial the companies mapper already
returns (`companies-http.ts:180`). It deliberately does not distinguish which row denied it: the reason
code is for the gate's tests and for the operator, not for the caller.

### §2.1 What this placement does NOT prove, stated because the alternative is to let it be assumed

The gate rejects **before** any route handler runs, so it never reaches the database and its evidence
anchor is an **HTTP response, not a recorded row**. Under CDR-080 §1's vocabulary that is
`return_value_only`, and this document says so rather than letting a reader infer `database_state` from the
word "integration".

That is a property of the control, not a weakness of the test: an effect that is refused before the first
statement leaves nothing in the database to assert on. §6.3 records what was planned here, why it was
**withdrawn as vacuous**, and what would have to exist for a database-anchored proof to be worth having.

---

## §3 What this ticket does NOT deliver

| Not delivered | Why |
|---|---|
| **HTTP rate limiting** (NFR-010) | The second of CDR-080 §4's three. Different control, different failure mode, needs a store and a limit value nobody has ruled. Its own ticket. |
| **Security headers / CSP** (NFR-010) | The third. Needs a rendered UI to have a policy about. Its own ticket. |
| Pen review | External engagement at the General MVP gate (`RELEASE-GATES.md:11`). Untouched by this ticket, and the NFR-010 traceability cells keep saying so. |
| A CSRF **token** | §1. Rejected on the record, not overlooked — and reversible if a UI ever wants defence in depth. |
| Any change to `authorizedParties` | §0.2.3 is a real finding and a different control. Widening this ticket to it would be scope this CDR did not rule on. |
| Non-browser API clients | §7.2. Nothing in this repository is one today, and the escape hatch for a hypothetical one is a bypass with no consumer. |

---

## §4 The source guard

`tools/check-csrf-origin-gate.mjs`, in `check:static` and `test:boundaries`, following
`check-approval-port.mjs` and CDR-080 §6's `check-trust-critical-index.mjs`.

Blanket enforcement moves the risk rather than removing it. The gate cannot be forgotten on a new route —
but it can be **switched off for all of them at once**, silently, by four edits that each look reasonable in
isolation. The guard fails the build when:

1. `proxy.ts` no longer calls the gate, or calls it **after** `clerkMiddleware()` (denial after a session is
   established still refuses the request, but it is no longer the order this document asserts);
2. the proxy `matcher` stops covering `/api`, which would leave every route module uncovered while every
   test that drives the gate directly stayed green — the most dangerous of the four, because it is a config
   edit far from any security-looking file;
3. the exempt-path set is anything other than the single declared Clerk webhook path — a second exemption
   must be an edit to this guard, which is a visible decision rather than a quiet one;
4. a `route.ts` exports a state-changing method from a path the matcher does not cover.

Detection of exported methods matches `export async function POST`, `export function POST` and
`export const POST =` — the webhook uses the second form and a future route may use the third, and a guard
that only knows one shape is a guard that reports clean.

It carries the house **negative self-test**: every detector must still fire on synthetic inputs before a
clean tree is reported, or the checker exits 2. CDR-080 §8.4's lesson is the reason — a checker that stops
matching prints the same line as a clean repository. The self-test runs **before** the tree is read, so a
blind checker exits 2 rather than reaching a verdict it is not equipped to reach.

### §4.1 What it found on its first run against the real tree — its own author's bug

Every fixture in the regression suite passed. The real `proxy.ts` failed, reporting *"config.matcher no
longer covers /api"* about a matcher that covers /api perfectly well.

The matcher's first entry is `'/((?!_next|[^?]*\\.(?:html?|…)).*)'`. **`[^?]` puts a `]` inside a string
literal**, and the array body was being extracted with `\[([\s\S]*?)\]`, which stopped at it. The truncated
body contained no complete string literal, so the entry list came back empty and every entry — including
`'/(api|trpc)(.*)'` — was invisible. Replaced with a scanner that tracks bracket depth *and* string state.

Two things about this are worth keeping. First, **it failed in the safe direction**: a false alarm someone
must think about, rather than a silent pass. Second, **no synthetic fixture could have caught it**, because
every fixture had a simpler matcher than the real file — the bug lived exactly in the gap between the tests
and the thing tested. The real-shaped matcher is now a self-test probe, so the gap is closed rather than
noted.

---

## §5 Slices

1. **CDR + branch** — this document.
2. **The pure decision function + its table-driven suite** — `apps/web/src/server/http/same-origin.ts`.
   Red first: the suite exists against a module that denies nothing.
3. **Wiring into `proxy.ts` + the proxy's first test file.** `proxy.ts` has never had one; the gate's
   production entry point is now asserted through the real exported module.
4. **The source guard + its regression suite.**
5. **Traceability updates** (§6.4), report, review, finalization.

---

## §6 Evidence

### §6.1 The mutation probe — committed, not described

Every control was written red-first, and every one is **measured** by
`tools/probes/p7-013-csrf-origin-gate.probe.mjs` (`pnpm run probe:csrf-origin-gate`). **7 mutations, 0
survivors.** Each neutralises one control without touching a test, and the probe prints the NAMES of the
tests that went red so a reader can check they are the ones the mutation should have broken:

| | Mutation | Result |
|---|---|---|
| M1 | `no_provenance` → allow (row 10) | **killed** — 10 failed / 44 passed |
| M2 | `same-site` → allow (row 4) | **killed** — 3 failed / 51 passed |
| M3 | unrecognised `Sec-Fetch-Site` → allow (row 7) | **killed** — 1 failed / 41 passed |
| M4 | empty allowed set → allow everything (§1.2) | **killed** — 1 failed / 41 passed |
| M5 | Origin compared by `startsWith` | **killed** — 2 failed / 40 passed |
| M6 | the proxy ignores the deny verdict (§2) | **killed** — 6 failed / 6 passed, **and the static guard exits 1** |
| M7 | the webhook bypass removed (§2 step 1) | **killed** — 1 failed / 11 passed, **and the static guard exits 1** |

**It is committed rather than run-and-reported, and that is the point.** ACBP-P6-006's probe was a branch
whose commit is reachable from no ref today; ACBP-P7-002's was not preserved at all, so CDR-079 carries a
figure nobody can re-derive and `P7-002-REVIEW-COVERAGE.md` §2.1 tells the next ticket to fix that. A run id
decays into a number in a document. A script re-derives the claim on any checkout, forever.

### §6.1a The probe's first run reported seven kills having run no tests

`execFileSync` cannot spawn `npx` without a shell on Windows. Every mutation exited **1** with no output,
the probe read "non-zero exit" as "the tests went red", and printed **7/7 killed**. It was wrong in the
direction that looks like success, and only a stricter kill test caught it: a kill now requires the
`Tests N failed | M passed` tally to show real failures, because a probe that dies before the assertions
returns the same exit code as one that fails them.

This is the third door onto the same lesson — ACBP-P7-002's probe went red at *lint* and never reached the
tests; CDR-080 §8.3's mutation ran the tests but never touched their path; this one never started them.
**A red exit code is not evidence.** The strictness is recorded in the probe's own header so the next person
to write one inherits it rather than rediscovering it.

### §6.2 Anchor class
`return_value_only` at the HTTP boundary, per §2.1. Declared, not rounded up.

### §6.3 The real-PostgreSQL test this ticket PLANNED, and why it was withdrawn

The plan was a real-PostgreSQL case composing `proxy(request)` with the route module in the production
order, asserting a cross-site `POST /api/companies` leaves **no `companies` row** — the database-state
anchor this repository prefers over a returned value.

**It was withdrawn during slice 4, because it is vacuous.** The test would call `proxy()`, receive a 403,
*decline to call the route on that basis*, and then assert that no row exists. The thing it asserts is that
**the test harness did not call the route** — a fact the harness itself decided. CDR-080 §8.3 states the
governing rule in a different context and it applies exactly: *a mutation that does not reach the assertion
proves nothing about the assertion.* Delete the entire gate and this test still passes, because the deleted
code is not on the path between the harness's choice and the row count.

**What would be non-vacuous** is driving a running Next.js server so the framework — not the test — composes
the proxy with the route. No harness in this repository does that: `http-routes.adversarial.integration
.test.ts` imports route modules directly and never loads `proxy.ts`, which is precisely why the proxy had no
test file before this ticket. Building a server-driving harness is a testing-infrastructure ticket, not this
one, and doing it badly here would produce the artefact ACBP-P7-007 exists to destroy.

**Recorded as a named limitation rather than papered over**, with the consequence stated plainly: the claim
*"a forged request reaches no route handler"* rests on the ORDER of statements in `proxy.ts` — asserted by
`proxy.test.ts` through the real module, and pinned statically by `tools/check-csrf-origin-gate.mjs` — and
on Next.js running the proxy before the handler, which is framework behaviour this repository does not
verify. It is not backed by a database observation, and no line in this ticket says it is.

*(Local PostgreSQL is unreachable and `ACBP_TEST_DATABASE_URL` is unset, as it has been for this repository
throughout — but that is NOT why this test is absent. It is absent because it would not have measured
anything even with a database behind it.)*

### §6.4 Traceability
`REQUIREMENT-TRACEABILITY.csv` and `REQUIREMENT-TO-TICKET-TRACEABILITY.csv`, NFR-010 rows only, and **only
the CSRF clause**: rate limiting, security headers/CSP and the pen review stay named as unmet in the gap
cell. NFR-010 does not become `Covered`; it becomes partially covered with a shorter gap.

**These two cells are also rewritten by the unmerged `p7-007-security-test-pass` branch** (CDR-080 §5),
which downgrades them from `Covered (MVP)` and names CSRF as ABSENT. Whichever lands second must **merge**
rather than overwrite, and if ACBP-P7-007 lands first its "CSRF ... ABSENT" wording is stale the moment this
ticket merges. Recorded here because a conflict resolved by taking one side wholesale is how a corrected
record silently reverts — the failure ACBP-P7-002 hit three times.

---

## §7 Open owner decisions

1. **`clerkMiddleware()` takes no `authorizedParties`** (§0.2.3) while `CLERK_AUTHORIZED_PARTIES` is
   configured and honoured on the adapter path. Either the web session path should pass it or the setting's
   scope should be documented as adapter-only. Not a CSRF gap; a real inconsistency, and outside this
   ticket's ruled scope.
2. **Non-browser clients are denied by row 10.** Correct today — none exists — and it will surface the day
   one does. The principled carve-out (a request bearing `Authorization` rather than a cookie is not
   CSRF-able, because a cross-site attacker cannot add that header without a preflight this app never
   answers) is **not built**, because it would be a bypass with no consumer. Whoever adds the first such
   client owns that decision.
3. **Whether the gate should apply to Clerk's `/__clerk/*` proxy paths.** It does today, by matcher
   inclusion; same-origin browser traffic satisfies row 3. If a Clerk flow is ever observed being denied,
   the fix is an exemption in the guard's declared set — a visible decision — not a widening of row 3.
4. **A binding rule for whoever adds method-override support.** Nothing in `apps/web` reads
   `X-HTTP-Method-Override` or an equivalent today, so the gate's method check cannot be sidestepped. If
   anything ever honours one, the override must be applied **before** this gate sees the method, or a
   forged `GET` carrying `X-HTTP-Method-Override: DELETE` walks through row 1. Written here as an
   obligation rather than built as a control, because building for a feature nobody has requested is the
   inert-control shape §1 rejects — but the failure is silent enough to deserve the sentence.
5. **Ticket `Done`, PR ready, and merge** are owner gates and have not been taken.
