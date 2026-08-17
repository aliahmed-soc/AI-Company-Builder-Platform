# CDR-081 — CSRF protection for `apps/web` (ACBP-P7-014)

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
   (`dist/chunk-NVYUROUB.mjs:299`), but the SDK never chooses its attributes: at `:6697` (the handshake
   path) and `:7063` (`attemptRefresh`) it appends provider-minted `Set-Cookie` values **verbatim**, and
   Clerk's Frontend API is what mints them server-side. The only `SameSite` the SDK itself writes is on a
   2-second handshake *counter* cookie (`:6786`). *(An earlier draft labelled `:7063` a handshake site as
   well; the append behaviour is identical, the path is the refresh flow.)*
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
3. **Whether `authorizedParties` is even on this path.** It is not. `proxy.ts` calls `clerkMiddleware()`
   with **no options** — the `sessionProxy` binding — and the route path is `auth()`, not
   `ClerkIdentityProvider`. So the web session surface applies no authorized-party check at all. Recorded as
   a finding (§7.1); it is **not** a CSRF gap and fixing it would not close this one.
   *(Cited by symbol rather than line: this file's line numbers moved inside this very ticket, so a line
   citation would have been stale in the commit that introduced it.)*

### §0.3 Same-origin posture, and what the codebase does today

`apps/web` sets **no** CORS headers anywhere, so cross-origin `fetch` cannot read responses and any request
carrying a custom header is stopped by an unanswered preflight. That is real, and it is also the wrong
control: the CSRF-reachable methods are exactly the ones that need no preflight — a cross-site **form**
POST (`application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`, or no body at all) is a
simple request, is sent, and its side effect lands even though the attacker never reads the reply.

**Nine** of the seventeen state-changing methods go through a body parser that returns 415 unless the media
type is `application/json` — five in `companies-http.ts:20`, two in `members-http.ts:20`, plus
`accounts/profile-http.ts:27` and `admin/admin-http.ts:30`. That is a side effect of bounded body parsing,
not a CSRF control, and it protects none of the rest. **Eight are reachable by a simple request**:
`pause`, `resume`, `interview` (start), `interview/suspend`, `interview/resume`, `provisioning/resume`,
`DELETE` a membership, and `DELETE` a memory item — each reads no body at all.

*(An earlier draft of this section said "three bodied routes" and put the admin `POST` among the bodyless
ones. Both were wrong — an independent review counted them. `POST /api/admin/.../read` requires an exact
`{ reason }` body and rejects a non-JSON media type at `admin-http.ts:30`, exactly as its own route header
says. The ruling is unaffected, but a reader sizing the pre-existing exposure from that sentence would have
been off by a factor of three and would have looked for the admin route on the wrong side of the line.)*

Searched and absent **before this ticket**: no `Origin`, `Sec-Fetch-*`, CSRF token, or same-origin check
existed anywhere in `apps/web/src`; `next.config.ts` sets no `headers()`. Stated in the past tense on
purpose — the first half stops being true the moment this ticket merges, and a present-tense claim in a
decision record is a claim that goes stale by its own success.

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

A token has to be issued to a document and echoed by the client. **No page in this application posts to any
of the seventeen state-changing methods**, and that — not "there is no UI" — is the load-bearing fact.

`apps/web/src/app` *does* render: `layout.tsx` mounts `ClerkProvider`; `(site)/layout.tsx` renders
`SignInButton`, `SignUpButton` and `UserButton`; `(site)/page.tsx` is a server component; there are Clerk's
`sign-in`/`sign-up` catch-alls under `(site)`; and `console/` renders the application shell against mock data.
What none of them contains is a `<form>`, a Server Action (`grep "use server"` across `apps/web/src` and
`packages` returns zero) or a `fetch` to any of those methods. So a token would ship with an issuing
endpoint, a cookie, a verification path, and **no producer of a valid token anywhere in production** — a
control that only tests can satisfy.

*(This section said "this repository has no rendered UI" until an independent review pointed at
`layout.tsx`. That is the repository's own shorthand — PROJECT-STATE uses it at ACBP-P6-008 — and it is
fine as shorthand and wrong as a premise. It matters because §3 leaned on it to defer a different NFR-010
item; that row is corrected too.)*

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
| **Security headers / CSP** (NFR-010) | The third. A different control with its own failure modes, whose policy has to be authored against the actual rendered surface — `(site)/layout.tsx` mounting Clerk's components, plus the `/console` application shell, which now exists rather than being hypothetical. Its own ticket. **Not** deferred because no UI exists: one does (§1), and an earlier draft of this row said otherwise. |
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
2. the proxy `matcher` stops covering **all** of `/api` — the most dangerous of the four, because it is a
   config edit far from any security-looking file that changes nothing a suite calling the gate directly can
   observe. "Covers `/api`" is checked against a closed list of whole-tree forms: a narrowed
   `'/api/companies/:path*'` **fails**, because it reads as coverage while leaving `/api/account/*` and
   `/api/admin/*` — five of the sixteen — unproxied. An **object-form** entry (`{ source, missing }`, which
   lets any request carrying a named header skip the proxy) makes the checker exit 2 rather than mine the
   `source` string and call the tree covered;
3. **anything returns from the proxy handler before the gate runs**, other than the single declared Clerk
   webhook bypass — a second exemption must be an edit to this guard, which is a visible decision rather
   than a quiet one;
4. a `route.ts` exports a state-changing method from a path the matcher does not cover.

Detection of exported methods matches **four** shapes — `export async function POST`, `export function
POST`, `export const POST =`, and a renamed re-export (`export { h as POST }`). The repository already uses
the first two (the companies routes and the webhook respectively) and nothing stops the next route reaching
for either of the others; a guard that knows one shape is a guard that reports clean.

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

### §4.2 The independent review defeated this guard FOUR ways, and the rule had to change

The exemption check originally matched `return undefined`. A review built fixture trees and ran the real
checker: `return;`, `return NextResponse.next();`, `return new Response(null, {status:200});`, and
`if (request.url.startsWith('https://internal.example')) return undefined;` **each added a fully working
second CSRF exemption with the checker exiting 0.**

The last one is the instructive one. `stripCommentsAndStrings` removed line comments *before* string
literals, so `line.slice(0, line.indexOf('//'))` truncated at the `//` inside the URL and everything after
it vanished. That bug was in a **shared helper**, so it could have blinded any detector — not only the one
that happened to be probed.

**The rule is now "no early return before the gate except the declared webhook bypass",** which cannot be
evaded by changing *what* is returned, because the defect was never about the value: it is about control
leaving the handler before the gate runs. The stripper is a single-pass scanner, it is probed directly in
the self-test, and all four evasions are regression cases.

This is the same class **and the same count** as the four evasions `check-approval-port.mjs` records against
its own first version. That file's lesson had been read and quoted in this one's header while the same
mistake was being made underneath it — which is the argument for adversarial review rather than for reading
more carefully.

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
`tools/probes/p7-014-csrf-origin-gate.probe.mjs` (`pnpm run probe:csrf-origin-gate`). **7 mutations, 0
survivors.** Each neutralises one control without touching a test, and the probe prints the NAMES of the
tests that went red so a reader can check they are the ones the mutation should have broken:

| | Mutation | Killed by |
|---|---|---|
| M1 | `no_provenance` → allow (row 10) | the bodyless-forgery and header-stripped cases, in both suites |
| M2 | `same-site` → allow (row 4) | the sibling-subdomain cases, in both suites |
| M3 | unrecognised `Sec-Fetch-Site` → allow (row 7) | the closed-vocabulary case |
| M4 | empty allowed set → allow everything (§1.2) | the missing-`APP_PUBLIC_URL` case |
| M5 | Origin compared by `startsWith` | the prefix (`…test.evil.test`) and non-default-port cases |
| M6 | the proxy ignores the deny verdict (§2) | the proxy suite **and the static guard (exit 1)** |
| M7 | the webhook bypass removed (§2 step 1) | the webhook-passthrough case **and the static guard (exit 1)** |

**No pass/fail counts are recorded here on purpose.** An earlier version tabulated them and they were
**stale within the same working tree** — two tests were added to `same-origin.test.ts` during review and
every figure was wrong by two. The probe prints current counts and the names of the red tests on every run,
so a number frozen into this document can only ever contradict it. Write the claim that cannot go stale.

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

**THESE TWO CELLS ARE A THREE-WAY COLLISION, and every party is writing about the same requirement:**

| Branch | What it writes into the NFR-010 cells |
|---|---|
| `p7-007-security-test-pass` (unmerged) | downgrades from `Covered (MVP)`, names CSRF, rate limiting and headers/CSP as **ABSENT** (CDR-080 §5) |
| **this branch** | CSRF **closed**; rate limiting, headers/CSP and the pen review still unmet |
| `p7-013-http-rate-limiting` (unmerged, a concurrent session) | rate limiting **closed** |

Whichever lands second, third or fourth must **merge** rather than overwrite. The failure mode is concrete:
if ACBP-P7-007 lands after this ticket and its wording is taken wholesale, the record goes back to saying
CSRF is absent when it is built — a corrected record silently reverting, which is the failure ACBP-P7-002
hit three times. The safe resolution is to keep the **union of what is closed** and the **intersection of
what is unmet**; no single branch's version of these cells is correct on its own after the first merge.

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
