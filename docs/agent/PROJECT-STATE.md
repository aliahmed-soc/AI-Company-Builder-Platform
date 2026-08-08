# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## CI IS STILL BLOCKED — and six branches were merged anyway, on the owner's explicit authority

**Hosted CI has produced no run since 2026-07-28 12:46 UTC.** The GitHub Actions spending limit was reached; jobs
either fail to start or die in seconds with zero steps executed. Only the owner can clear it — it is a billing
setting on their account, and payment settings are outside what this agent may touch. The last hosted run was the
exact-main verification of `bf381e7`.

**CORRECTED 2026-07-28 23:35 — two things I recorded here earlier were wrong.** (a) The zero-run observation was NOT
all billing: `ci.yml` runs on `pull_request` and `push: [main]` only, and five of the six branches have no PR, so
they were never going to produce a run. The billing block is proven on `p5-014` (PR #62) alone. (b) These are NOT one
six-deep stack. Verified by `git merge-base --is-ancestor`: there is ONE 4-deep stack (`p5-011` → `p5-006` →
`p5-007` → `p5-008`) plus TWO INDEPENDENT branches (`p5-014`, `p5-013`), all rooted at current `main`. Nothing sits
above `p5-014`. Full diagnosis in `AUTONOMOUS-RUN-LOG.md` under "STOPPED — NEEDS OWNER: CI DOWN".

Six branches are complete, reviewed, pushed and unmergeable. Verify and merge BOTTOM-UP in this order:
**The owner authorised merging on LOCAL verification on 2026-07-29**, one branch at a time, bottom-up, with a full
local sweep on `main` after each and an instruction to stop dead if any merge turned `main` red. That is what
happened; nothing was merged on a red or unverified tree.

**What the local evidence is.** Every sweep runs against a REAL PostgreSQL on a database created fresh for that run
and dropped afterwards, migrations applied from zero, suites serial, no retries, and **zero skips** — the
`skipIf(!hasTestDatabase)` suites all execute, which is the part that actually exercises RLS predicates, grants,
constraints, triggers and races.

**What it is NOT.** It is not the hosted zero-skip CI on the exact SHA that this repo's completion standard names,
and it is one machine with one PostgreSQL version. Every merge commit and every backlog row from this sequence is
labelled *"merged on local verification, CI still blocked by the GitHub spending limit"*.

### RESOLVED 2026-07-31 — hosted CI run `30632188407` confirmed this sequence on `main`

The owner made the repository public, which restored unlimited free Actions minutes. The outstanding requirement
above was then discharged, and this is the precise scope of what was proven:

| | |
|---|---|
| **Run** | [`30632188407`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/30632188407) — workflow `CI`, job `verify`, conclusion **success** |
| **Commit** | `4c12da39dae71ae5292deae2171f83b6e3a0a0c5` — the tip of `main`, re-run in place so the SHA is genuinely main's |
| **Result** | **225 files / 3053 tests / ZERO SKIPS** — the DB preflight step passes only if the real-PostgreSQL suites would actually execute |
| **Covers** | every merge of the local-verification sequence, because `4c12da3` contains all of them: `338ae08` (P6-001 + P6-002), `9e339a3` (P6-003), `7a5a9ea` (P6-004) — verified with `git merge-base --is-ancestor` |

**WHAT IT DOES NOT COVER, stated so the label is not read as more than it is.** This is one run on the CUMULATIVE
TIP. The intermediate merge commits `9e339a3` and `7a5a9ea` were each pushed to `main` and each produced a **red**
run — `30590300693` and `30632014201` — and those were never re-run green. So the *end state* of the sequence is
CI-proven; each individual step in it is not, and cannot be retroactively.

**THOSE TWO REDS WERE VOID, NOT REGRESSIONS**, diagnosed before anything was touched, as the outage instructions
required. Both runs report `steps=0`: the `verify` job never executed a single step, which is the GitHub billing
startup-failure signature, not a test failure. The same workflow on the same code ran green as soon as the account
block lifted. No code was changed in response to them, because there was nothing in them to respond to.

A **full-history secret scan** was run at the same time, since a public repository exposes every past commit and not
just the tip: 8,689 objects / 3,989 blobs swept, 35 pattern matches, all synthetic fixtures or allowlisted; the only
`.env`-shaped file ever committed is `.env.example`. Nothing to rotate.

**Migration numbers are no longer provisional.** They were assigned assuming this merge order and the order held:
`0041`/`0042` (credit ledger) then `0043` (artifacts), strictly ascending, none applied anywhere before now.


## Active

_Newest first. When a ticket merges, a one-line **DONE** entry is added ABOVE its working block; the working block is
kept as historical detail (what was built, which commits, which gates). **The DONE line is the authoritative status** —
a "CORE DONE / FINALIZING" block below a DONE line for the same ticket is history, not an open item. Only the topmost
ticket without a DONE line above it is genuinely in flight._

- **DONE — ACBP-P7-009 end-to-end MVP suite (headless half).** Squash **`e1bbc1c`**, PR **#83**, branch
  `p7-009-e2e-mvp-suite`, no migration. Exact-head CI
  [`31190616787`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31190616787) on
  `a5706be`: **276 files / 4038 tests, zero skips**; exact-main
  [`31191559654`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31191559654) on
  `e1bbc1c`: the same 276 / 4038, zero skips. Both anchored against a local run of the same 4038 with zero skipped,
  so the CI total is not larger than what ran here. **The backlog row is NOT `Done`** — see below.
  - **WHAT IT PROVES THAT THE SLICE SUITES DID NOT.** One continuous journey for ONE company across eleven steps —
    account, interview, understanding, strategy, roadmap, task planning, approval, execution, artifact, revision —
    where each stage CONSUMES the previous stage's real output rather than a fixture shaped like it. A stage that
    silently stops feeding the next one now fails here while every slice suite stays green. The load-bearing case is
    that **the task that executes is the task planning produced**, resolved by id out of the plan rather than
    created fresh in the executing step — the shortcut that would have made the whole loop vacuous.
  - **THE JOURNEY LIVES IN `packages/test-support`, NOT IN THE TEST.** `runMvpLoopJourney` takes injected ops, so the
    same journey drives both the CI integration test and a runnable demo (`pnpm run demo:mvp-loop`). A journey that
    exists only inside a test cannot be run by a human against a real database, which is why the slice demos exist.
  - **THE CONTINUITY WALK IS FALSIFIABLE AND WAS PROVEN SO.** It re-reads the finished company through a second,
    unrelated account to confirm the loop's data does not cross the tenant boundary. That assertion was MUTATED to
    point at the loop's own account, where it must fail, **and it did** — it is not a check that passes because
    nothing is there.
  - **THE ACCEPTANCE CRITERION IS HALF MET, WHICH IS WHY THE ROW IS NOT `Done`.** This is the HEADLESS half: it
    drives use cases directly, so it proves the domain composes and proves **nothing** about the web delivery
    boundary, the UI, or a browser. There is no rendered interface to drive and building one is an owner gate, so
    the other half is *unbuildable here* rather than skipped for convenience.
  - **ONE DEFERRED ITEM, NAMED RATHER THAN DROPPED** (CDR-085): the planned `assertNoSecretsInAuditPayloads` sweep is
    absent because its `SweepableClient` parameter is structurally looser than the `DatabaseClient` this journey
    holds and no existing caller bridges the two. Changing a shared test helper's contract does not belong inside
    this ticket.

- **DONE — ACBP-P7-013 HTTP rate limiting.** Squash **`c9c3aa1`**, PR **#79**, branch `p7-013-http-rate-limiting`,
  migration **0055**. Exact-head CI
  [`31188483460`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31188483460) on
  `2f46a53`: **275 files / 4037 tests, zero skips**; exact-main
  [`31189399856`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31189399856) on
  `c9c3aa1`: the same 275 / 4037, zero skips. Both anchored against a local run of the same 4037 with zero skipped.
  Merged THIRD of four, after `main` was merged into the branch and five conflicts resolved (`package.json`,
  `PROJECT-STATE.md`, `BACKLOG.csv`, and the two NFR-010 rows) — none in application code, because this ticket and
  its two siblings touch different layers. **The backlog row is NOT `Done`** (owner gate); **AOQ-14 remains open**,
  so the shipped values are CDR-008 §8's accepted figures and not final ones.

- **ACBP-P7-013 HTTP rate limiting — BUILT AND WIRED, NOT OWNER-ACCEPTED** (CDR-082; NFR-010; CDR-008 §8;
  ADR-003's beta launch condition). Branch `p7-013-http-rate-limiting`, draft PR **#79**, commit `b20b036`,
  migration **0055**. Ledger: `P7-013-REVIEW-COVERAGE.md`.
  - **RAISED BY ACBP-P7-007** (CDR-080 §4), which ruled NFR-010's absent ASVS items into separate tickets rather
    than building them inside a verification pass. **P7-007 is still unmerged** and edits the same two NFR-010
    rows and the same plan line — whichever merges second resolves that conflict. Recorded in CDR-082 §7.
  - **THE FINDING THAT MADE IT SMALL: nothing here was undecided.** CDR-008 §8 (Accepted **2026-07-18**) ruled
    the values — per-session 60/min sustained, burst 120; per-account 300/min — and named **ACBP-P6-010** as its
    consumer. P6-010 implemented the SIXTH layer (hard cost caps) and left the FIRST. The figures sat accepted
    and unimplemented for nineteen days. `USAGE-AND-BILLING-ARCHITECTURE.md` §3 had likewise already ruled the
    placement — *"api layer (per session/account)"* — which settles middleware-vs-route-vs-edge AND the key.
    **This ticket invents no number and chooses no location.** What was missing was not a decision.
  - **SCOPE ESTABLISHED, NOT ASSUMED.** (a) Clerk covers the auth surface and ONLY it — sign-in/sign-up are
    Clerk-HOSTED components, so credentials never reach a route here; all 22 API routes had no bound at all.
    (b) **There is no deployment configuration in this repository at all** — no vercel.json, render.yaml,
    Dockerfile, fly.toml, terraform, and no `middleware.ts` — so an edge answer is UNBUILDABLE here and is
    recorded as a constraint (CDR-082 §1.4) rather than proposed. (c) State is PostgreSQL, because a per-process
    counter is not a limit under more than one instance and the topology is unknown. (d) Keyed on the
    server-verified session and account, **never IP**: with no trusted proxy an `x-forwarded-for` limit is
    evadable AND lets an attacker spend a VICTIM's bucket — a protection turned into a targeted DoS.
  - **IT IS WIRED, WHICH IS THE WHOLE POINT.** The session ceiling is consumed in `verified-identity.ts` — the
    chokepoint all five protected surfaces call — positioned BEFORE `getBackendUser`, which is a Clerk Backend
    API network call on every protected request; the account ceiling is consumed in the request modules at the
    first point the account id exists. `tools/check-rate-limit-coverage.mjs` (in `check:static`) fails the build
    if a handler stops reaching it, walking imports TRANSITIVELY rather than matching names, and failing on
    zero-handlers-found and on a stale exemption. Both limiter dependencies are **REQUIRED, never defaulted to
    allow** — an optional permissive port is the stop-port defect P6-007 deleted (CDR-072 §1-G1).
  - **THE DECISION HAPPENS INSIDE THE ROW LOCK** — one `INSERT … ON CONFLICT DO UPDATE … WHERE`. A
    read-then-write pair is a lost-update race in which two concurrent requests both spend the last token: the
    exact defect this control exists to prevent, reintroduced inside its own implementation. The pure token
    bucket in `@acbp/contracts` is the SPECIFICATION and the SQL is a second implementation; a real-PostgreSQL
    DIFFERENTIAL suite replays the specification's own cases through the database so the two cannot drift.
  - **I SHIPPED THE DEFECT THIS TICKET WARNS ABOUT, AND CAUGHT IT IN MY OWN PROSE.** A canon correction I wrote
    claimed the ACCOUNT ceiling was enforced when only the SESSION half was wired — the reachable-but-unwired
    shape of P6-010's `caps`, written by the author of the §2 section warning against it. Fixed by WIRING the
    account half, not by softening the sentence. Five further findings, all mine against my own work, in
    `P7-013-REVIEW-COVERAGE.md` §2 — including `genericErrorBody(429)` returning `internal_error`, which told a
    throttled caller their request FAILED when it was REFUSED, implying the opposite client behaviour.
  - **THE FINDING THAT OPENED THE TICKET WAS OVERSTATED.** The plan's Authentication row names *credential
    stuffing*, and that surface IS rate limited — by Clerk, because the credential surface is Clerk-hosted. The
    defect is a missing ATTRIBUTION, not a missing control, and correcting it to "absent" would have replaced one
    wrong sentence with another. **A second row made the same claim and the brief did not name it** —
    `REQUIREMENT-TRACEABILITY`'s **ACC-001** — found by sweeping the defect CLASS rather than the named instance.
  - **The mutation probe is PRESERVED as a reproducible table**, unlike P7-002's: 4 mutations, **2 / 1 / 1 / 11**
    of 16 cases red, baseline restored 16/16 with zero markers resident. The static checker was probed too.
  - **NOT CLOSED, and none of these is an engineering gap I may close alone:** CSRF protection and security
    headers/CSP (NFR-010's other two items — CDR-082 §8.2/§8.3); the pen review (external vendor, General MVP
    gate); **unauthenticated pre-session traffic, which nothing in this repository bounds** and which needs the
    deployment edge §1.4 established does not exist (§8.1, OWNER); `USAGE_LIMIT_EXCEEDED` declared with zero
    usages, so a spend refusal and a rate refusal are indistinguishable (§8.4, pre-existing); and the final
    values (**AOQ-14 still open**). Ticket Done / PR ready / merge are owner gates and none has been taken.

- **DONE — ACBP-P7-015 security response headers and Content Security Policy.** Squash **`53a35a6`**, PR **#82**,
  branch `p7-015-security-headers-on-main`, no migration. Exact-head CI
  [`31186016007`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31186016007) on
  `2398cf8`: **273 files / 3992 tests, zero skips**; exact-main
  [`31187092271`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31187092271) on
  `53a35a6`: the same 273 / 3992, zero skips. Both anchored against a local run of the same 3992 with zero skipped.
  **The backlog row is NOT `Done`** (owner gate). No working block was ever added for this ticket while it was in
  flight, so this record is the whole of it.
  - **WHAT SHIPPED.** Five enforced response headers plus a strict **report-only** CSP at `apps/web/src/proxy.ts`,
    plus `poweredByHeader: false`. The boundary is the only place that covers pages and route handlers with ONE
    implementation *and* covers responses the middleware generates itself — the `failClosed` 401, Clerk's sign-in
    redirects, and now the CSRF 403 — which `next.config.ts` `headers()` can never reach, because those requests
    never arrive at the routing layer that would apply them.
  - **TWO INDEPENDENT REVIEWS RAN BEFORE ANY COMMIT AND CHANGED THE OUTCOME.** They agreed on five defects and the
    most serious was a header **already shipped**: COOP, justified in four separate places by a claim about Clerk
    this repository cannot check, whose fuller analysis pointed the other way — COOP on the callback page *causes*
    the `window.opener` loss it was claimed to prevent. COOP is enforcing, so unlike the report-only CSP it cannot
    be published then corrected. It was REMOVED and its absence is asserted (CDR-083 §6.2). They also showed the
    first source guard guarded nothing (both sides of its comparison came from the same call) and that a claimed
    TypeScript enforcement did not exist; both are now real and mutation-verified.
  - **WHAT DELIBERATELY DID NOT SHIP, each with its deciding evidence rather than its intention:** HSTS (ADR-020
    picks Render, but no deployment config, environment or domain exists, so the parameters cannot be chosen and
    delivery cannot be verified — deferred to **ACBP-P7-006**); COOP (above); **CSP enforcement**, which needs a live
    Clerk sign-in pass and is an owner gate; and **CSP report collection**, because no endpoint exists, so a
    violation is visible in the browser console only. Claiming collection would have been false.
  - **ONE THING HERE HAS NO EVIDENCE AND IS LABELLED AS SUCH:** `poweredByHeader: false` cannot be asserted by any
    test in this repository, because CI never serves a response (CDR-083 §6.3).
  - **THE MERGE WITH P7-014 WAS COMPOSED, NOT CHOSEN.** Both tickets rewrote the same function in `proxy.ts`, which
    is why they were merged adjacently. Order is now webhook bypass → CSRF gate (before any session) → session proxy
    with headers applied. **The CSRF 403 carries the headers**, which neither branch could decide alone: it is
    exactly the middleware-generated response CDR-083 §2.4 argues the boundary exists for, and leaving it bare would
    have made `security-headers.test.ts`'s *"the webhook path is the ONLY bypassed path"* true in letter and false in
    substance, since that test defines bypassed as returning `undefined` and a 403 is a `Response`. Both static
    guards were checked against the composition BEFORE the edit — `check-csrf-origin-gate.mjs`'s `denies` detector
    tests for `403` and `forbidden`, both still present inside the wrapper call.

- **DONE — ACBP-P7-014 CSRF protection for the web delivery boundary.** Squash **`0bad8ba`**, PR **#78**, branch
  `p7-013-csrf-origin-gate` (the branch name keeps the old number; see the collision note below). No migration.
  Exact-head CI
  [`31143827343`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31143827343) on
  `868dbec`: **271 files / 3958 tests, zero skips**; exact-main
  [`31184196218`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31184196218) on
  `0bad8ba`: the same 271 / 3958, zero skips. Both anchored against a local run of the same 3958 with zero skipped.
  **The backlog row is NOT `Done`** (owner gate).
  - **⚠️ A DEFECT IN THE MERGE ITSELF, RECORDED BECAUSE IT IS ON `main` AND CANNOT BE UNDONE WITHOUT AUTHORISATION.**
    This squash commit carries a **`Co-authored-by: aliahmed-soc` trailer**, which CLAUDE.md forbids. The cause was
    procedural, not the shell wrapper: `--body` was omitted, so **GitHub generated the default squash body** — the
    concatenated branch commits *plus* a co-author trailer derived from their authors. The three later merges
    (`53a35a6`, `c9c3aa1`, `e1bbc1c`) each passed an explicit `--body-file` and are all clean, which confirms the
    diagnosis. Removing the trailer now would mean rewriting a pushed `main`, which is an owner gate and has NOT
    been taken. **Anyone squash-merging here must pass `--subject` AND `--body-file`.**

- **ACBP-P7-014 CSRF protection for the web delivery boundary — BUILT, TICKET NOT DONE** (CDR-081; NFR-010;
  ADR-022/ADR-023; origin: **CDR-080 §4**). Branch `p7-013-csrf-origin-gate` — **the branch name keeps the
  old number and the ticket is ACBP-P7-014**; see the collision note below. **No migration**, no schema, no
  new contract. A NEW ticket: ACBP-P7-007 found the gap and the owner ruled it a separate implementation
  ticket rather than work to do inside a verification pass.
  - **⚠️ TICKET-ID COLLISION, RESOLVED BY YIELDING — OWNER MAY WANT TO REVISIT.** A concurrent session
    independently took **ACBP-P7-013** for **HTTP rate limiting** (branch `p7-013-http-rate-limiting`,
    commit `b20b036`, branched from the same `2c4f0f5`). Both sessions picked "the next free number" from
    the same backlog within minutes of each other, and both add a `BACKLOG.csv` row — so a **duplicate
    ticket id would have merged**. This ticket renumbered itself to **ACBP-P7-014** rather than wait,
    because yielding is the only move that removes the failure mode WITHOUT requiring the other session to
    act, and one session cannot edit another's branch. The branch name and PR #78 title still say
    `p7-013`; renaming a pushed branch means closing and reopening the PR, which is the owner's call.
    **This is not a claim that the other session's number is correct** — CDR-080 §4 lists CSRF first, and
    this branch was pushed eight minutes earlier. It is a claim that a duplicate id is worse than a
    number nobody argued about.
  - **THE SAME COLLISION HAPPENED AGAIN ONE LAYER DOWN, AND IS RESOLVED THE OTHER WAY: the CDR number.**
    Both branches added a file called `CDR-081` — this one `CDR-081-csrf-origin-gate.md`, the rate-limiting
    branch `CDR-081-http-rate-limiting.md`. Unlike the ticket id, this one has a **tie-breaker on the
    record**: CDR-080 §4 names the three missing ASVS items in the order *CSRF, HTTP rate limiting,
    security headers / CSP*, and the third branch has already taken **CDR-083** for headers/CSP. That fixes
    the scheme — CSRF **081**, rate limiting **082**, headers **083** — so this branch KEEPS `CDR-081` and
    the rate-limiting branch is the one that must renumber to `CDR-082`. Recorded here because the cheaper
    renumber is the wrong one (49 references here versus 75 there), and a future session optimising for
    effort would pick it.
  - **THE FIRST JOB WAS TO DISPROVE THE FINDING, NOT TO BUILD.** *"CSRF protection is absent"* could
    honestly have been *"partially covered by the provider"*. Three provider mechanisms were checked and
    none covers it (CDR-081 §0.2). The sharpest is the first: **`__session`'s `SameSite` attribute is
    chosen by Clerk's Frontend API**, not by the SDK — `@clerk/backend` appends handshake `Set-Cookie`
    values verbatim (`chunk-NVYUROUB.mjs:6697`, `:7063`), and the only `SameSite` it writes itself is on a
    2-second handshake counter cookie. So the attribute that would carry the defence **is not observable,
    assertable or pinnable from this repository**. That is deliberately NOT a claim that `__session` lacks
    `SameSite` — it is a claim that the repository cannot know, and a control it cannot know about cannot
    be its answer to NFR-010. `authorizedParties` is wired but structurally irrelevant: `azp` records the
    origin the token was MINTED for, which in a forgery against this app is this app's own origin.
  - **A CORRECTION TO THE FINDING AS WRITTEN:** it named `apps/web/src/middleware.ts`, which does not
    exist. Next 16 renamed the boundary; this app's is `apps/web/src/proxy.ts`.
  - **WHAT LANDED.** A fail-closed same-origin gate at the request-interception boundary: `Sec-Fetch-Site`
    first and exclusively when present, `Origin` against `APP_PUBLIC_URL` as the fallback, and **deny when
    neither is present** — absence of provenance is never permission. **Nine rows in the pure function**
    plus the proxy's pre-existing webhook early return, closed vocabulary, asserted by REASON rather than by
    allow/deny so a row that stops denying cannot pass by coincidence.
    `proxy.ts` gained its **first test file**, which is where the ordering claim lives (refused before any
    session is established, so a forgery reaches no Clerk round trip and no handler).
  - **A TOKEN WAS REJECTED ON THE RECORD** (CDR-081 §1). There is no rendered UI, so a synchronizer token
    would ship with **no producer of a valid token anywhere in production** — the shape this repository has
    been bitten by three times (P6-010's caps, P6-011's usage key, P7-002's zero-caller predicate).
  - **ENFORCED IN ONE PLACE, WHICH IS THE STRENGTH AND THE WHOLE RISK.** A route module that does not exist
    yet is covered the day it is written; and the gate can be switched off for all sixteen at once by four
    edits that each look reasonable alone. `tools/check-csrf-origin-gate.mjs` fails the build on each, plus
    two exemption rules. It reports **17 state-changing of 23 route modules**, so the CDR's count is
    machine-re-derivable rather than prose.
  - **THE CHECKER'S FIRST RUN AGAINST THE REAL TREE FAILED, ON ITS AUTHOR'S BUG.** The matcher's first
    entry contains `[^?]` — a `]` **inside a string literal** — and a non-greedy bracket regex truncated the
    array, so every entry went invisible and a perfectly correct matcher was reported as not covering
    `/api`. **No synthetic fixture could have caught it**: every fixture had a simpler matcher than the real
    file. Replaced with a depth-and-string-state scanner; the real-shaped matcher is now a self-test probe.
  - **AND THEN AN INDEPENDENT REVIEW DEFEATED THAT CHECKER FOUR WAYS.** Its exemption rule matched
    `return undefined`, so `return;`, `return NextResponse.next();`, `return new Response(...)` and
    `if (request.url.startsWith('https://internal…')) return undefined;` **each added a working second CSRF
    exemption with the checker exiting 0** — the last because the comment stripper removed line comments
    BEFORE string literals and truncated the line at the `//` inside the URL, a bug in a *shared* helper
    that could have blinded any detector. Rule changed to **no early return before the gate**, which cannot
    be evaded by changing what is returned. This is the same class AND the same count as
    `check-approval-port.mjs`'s four evasions — whose header was **read and cited in this checker's own
    header** while the same mistake was being made underneath it. Knowing the lesson did not prevent it.
  - **THE REVIEW RETURNED NO BLOCKER, 2 HIGH, 5 MEDIUM, 6 LOW — and every finding except the guard's was in
    PROSE.** It could construct no attacker path to a handler, no URL that satisfies `isClerkWebhookPath`
    while routing elsewhere, and no vacuous assertion; the gate itself came through unchanged. The second
    HIGH was this file's sibling claim in CDR-081 §0.3 that *three* routes had a media-type check when
    **nine** do, with the admin POST — which requires an exact `{ reason }` body — filed among the bodyless
    ones. Third consecutive ticket where the defects are in the sentences, not the code.
  - **NO REAL-POSTGRESQL PROOF EXISTS AND NONE IS CLAIMED — and the reason is not the missing database.**
    The planned composition test was **withdrawn as VACUOUS** (CDR-081 §6.3): it would call `proxy()`, get a
    403, decline to call the route *on that basis*, and then assert no row exists — asserting only that the
    harness did not call the route. Delete the entire gate and it still passes. What would be non-vacuous is
    driving a running Next server so the FRAMEWORK composes proxy with handler; no harness in this
    repository does that. So *"a forged request reaches no handler"* rests on statement ORDER in `proxy.ts`
    (asserted through the real module, pinned statically) plus Next running the proxy first, which this
    repository does not verify. Local PostgreSQL is unreachable as always, but that is **not** why the test
    is absent.
  - **CLOSES ONE OF THREE.** CDR-080 §4 named CSRF, HTTP rate limiting and security headers/CSP. **Rate
    limiting and security headers/CSP remain ABSENT** and are still owed their own tickets; the pen review
    is untouched and stays at the General MVP gate. The NFR-010 traceability cells say exactly that.
  - **⚠️ THE TWO NFR-010 TRACEABILITY CELLS ARE ALSO REWRITTEN BY THE UNMERGED `p7-007-security-test-pass`
    BRANCH** (CDR-080 §5), whose wording names CSRF as ABSENT — true when written, stale the moment this
    merges. Whichever lands second must **merge, not overwrite**. Flagged because a conflict resolved by
    taking one side wholesale is how a corrected record silently reverts, which P7-002 hit three times.
  - **HOSTED CI IS GREEN WITH ZERO SKIPS ON THE EXACT HEAD.** Run
    [`31119574444`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31119574444) on
    `5c6f2b5`: **262 files / 3765 tests, all passed, not one `N skipped` line in the job log**, DB preflight
    passed. Locally this suite is 148/114-skipped and 2162/1603-skipped, and **2162 + 1603 = 3765** — so
    every suite that silently skips on this machine ran against real PostgreSQL there. The earlier run
    `31117906801` on `1357508` said `cancelled` and was **VOID, not a regression** (`steps=0`, no runner
    ever assigned); the green run on the same code plus the review fixes is what confirms that reading.
  - **Ticket Done / PR ready / merge are OWNER GATES and none has been taken.**

- **DONE — ACBP-P7-008 failure-injection pass.** Squash **`7730d84`**, PR **#81**, branch
  `p7-008-failure-injection-pass`, no migration. Exact-head CI
  [`31141709340`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31141709340) on
  `76facb5`: **268 files / 3874 tests, zero skips**; exact-main
  [`31142383986`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31142383986) on
  `7730d84`: the same 268 / 3874, zero skips. The working block below described this as *"IN FLIGHT — draft PR #81"*
  and was left stale to avoid a four-way conflict while the other tickets were merging; this line supersedes it.
  **The backlog row is NOT `Done`, and that is a substantive refusal rather than an unopened gate:** the acceptance
  criterion is *"16-scenario matrix green"*, and two of sixteen scenario rows have no injectable subject in this
  system at all (CDR-084 §0.1). Marking it `Done` would make the backlog assert something
  the evidence contradicts — the exact artefact class this ticket was built to remove.
  *(The count in this paragraph read "twelve of sixteen scenario rows remain unmeasured while two have no
  injectable subject" until `442456d` measured ten of them; only the subject-less pair is left. The refusal is
  unchanged — the criterion still cannot be met on its literal wording — but its arithmetic is now different, and
  the reason it holds is now ONLY rows 5 and 10.)*

- **DONE — ACBP-P7-008 scenario measurement completed.** Squash **`442456d`**, PR **#88**, branch
  `p7-008-record-wave12`, no migration. Exact-head CI
  [`31223200241`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31223200241) on
  `e28218d`: **277 files / 4056 tests, zero skips**; exact-main
  [`31223904952`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31223904952) on
  `442456d`: the same 277 / 4056, zero skips.
  **FOURTEEN OF SIXTEEN SCENARIO ROWS ARE NOW `measured` — every row that has a subject.** The two that remain are
  row 5 (`absent`: nothing injects it) and row 10 (`unbuildable`: the failure has no subject in this system), so
  `MAX_UNPROVEN` moved **12 → 2 and is at its floor**. Its doc comment now states that a future commit lowering it
  further is claiming a test or a subject that did not exist here; the checker enforces the ceiling, not the floor.
  Rows measured: 1, 2, 3, 4, 6, 7, 8, 11, 12, 13.
  - **THREE ROWS PASSED THE SLICE-6 STATIC RULE WHILE BEING WRONG**, and each was caught only by a human reading a
    test body or a run log — which is the finding, not the count. **Row 11's recorded mutation was INERT**: skipping
    `enqueueJob`'s `findByIdempotencyKey` read-back cannot create a second job, because dedupe is the partial unique
    index plus `ON CONFLICT DO NOTHING`; corrected to storing `idempotencyKey: null` on the insert. **Row 12's named
    the wrong one of two call sites**: `listCheckpoints` is called in `runJobStep` (already-completed guard) and in
    `getResumeState` (plan-minus-inventory), the cited test never asks `runJobStep` to re-run anything, and mutating
    it reddened three neighbours while leaving the cited test **green** (run `31212362663`) — the ACBP-P7-007 row-19
    shape caught from the other side. **Row 2's first attempt was rejected by lint** and never ran.
    The rule verifies that a mutation names REAL SYMBOLS IN REAL FILES; it cannot tell whether the edit achieves the
    effect the row claims. That is its known ceiling, and it is recorded in the rows themselves.
  - **ROW 6'S COLLATERAL IS RECORDED, NOT AVERAGED AWAY.** Its mutation reddened **175 tests**, because
    `withTransaction` wraps every database write in the platform and there is no narrower edit — the row's claim is
    about the wrapper itself. The row states what the run proves (the rollback is load-bearing across the suite) and
    what it does not (with 175 failures a cascade explains any single one, so it does **not** isolate row 6's own
    assertion the way row 8's **single-test** run does).
  - `verify:mutation-runs` — the CDR-080 §7.11 resolver, built and merged at **`ca2a901`**, which the backlog row
    had listed as *"RECOMMENDED AND NOT BUILT"* — confirms all **18** measured rows across both indexes against the
    logs GitHub serves. Its own caveat stands: it does not prove the described edit produced the run.
  - **`442456d` also carries a nanoid override unrelated to the measurement work.** GHSA-2v37-7h3g-55p8
    (`nanoid <3.3.17`) landed after `main` last ran green at `ca2a901`, and the branch changed no dependency file,
    so the same red was waiting on `main` and every open branch. The override is a **caret, not the `>=` its three
    neighbours use**: nanoid 4+ is ESM-only while postcss asks for `^3.3.11` and requires it from CommonJS, so
    `>=3.3.17` would resolve to the 6.x line and break postcss at runtime while the audit went green. `apps/web`
    was built to check that, because hosted CI does not run `next build` and postcss is the Next.js CSS pipeline.
  - **The branch `p7-008-record-wave12` (`e28218d`) and ~11 `p7-008-probe-*` branches still exist; deleting them is
    an owner action.** Unlike the P7-008 probe branches, these were NOT reverted commit-by-commit: each probe branch
    carries a live mutation and IS the evidence behind a recorded run id.
    **(`p7-008-record-wave12` and `p7-008-postmerge-docs` were deleted on the owner's instruction after each squash
    was proved tree-identical to its CI-green head. The ~11 `p7-008-probe-row*` branches remain.)**

- **DONE — the TRUST-CRITICAL index, 4 measured → 12 of 20.** Squash **`5b7ad92`**, PR **#90**, branch
  `p7-trust-critical-measurement`, no migration, **no production code change** — every mutation lived on a
  disposable probe branch. Exact-head CI
  [`31232429428`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31232429428) on
  `6fbf001`: **277 files / 4056 tests, zero skips**. `MAX_UNPROVEN` **16 → 8**. Measured: rows 2, 3, 5, 9, 11,
  12, 18, 19 (joining 7, 10, 15, 16). Rows 2 and 18 are **single-test results**.
  - **THE AUDIT CAME BEFORE THE PROBE AND IS THE SUBSTANTIVE RESULT.** Reading the cited test body of all fifteen
    unmeasured rows found **five whose recorded text cannot prove what the row claims** — the same rate P7-008 hit.
    **Row 4 cites a test for a DIFFERENT CONTROL** (it claims the worker allowlist denies unregistered tools; the
    cited test compares key sets of the emergency-STOP scope map and dispatches nothing). **Row 6 cites the
    CONTROL, not the property** (`the UNCHANGED action still runs`, which stays green under the recorded
    mutation). **Row 9** named a mutation that ADDS an entry point, which cannot redden a test calling `startRun`.
    **Row 11** carried the same inert mutation the scenario index did. **Row 19 had been corrected once and the
    correction was ALSO wrong** — it proposed re-labelling a template family the cited test never touches.
    Rows 4 and 6 stay `unmeasured` rather than `not_covered`: whether a correct test exists has not been searched.
  - **ROW 12 KEEPS BOTH OF ITS RUNS, and the pair is the finding.** Dropping UNIQUE from the usage idempotency
    index does not remove deduplication — it removes what `ON CONFLICT` needs to resolve, so every usage write
    raised `SQLSTATE 42P10` and **94** tests went red; the cited test failed on the FIRST insert throwing, so its
    question was never reached. **That run PASSED the §7.11 cross-check and reported CONFIRMED** — a real limit of
    that tool, which cannot tell a broken property from thrown code. The stack trace and the blast radius (94 vs
    3) are what separated them. The recorded mutation now drops the KEY instead: 3 red, zero 42P10.
  - **ROW 13 CANNOT BE MUTATED AS WRITTEN, and that is a result about the control.** Every `usage_events` column
    is typed `ColumnType<T, T, never>` — the third parameter is the UPDATE type — so making `recordUsageCorrection`
    edit the original is a compile error. The "never edits" property has a **second enforcement layer above the
    test**, in the schema type. Measuring it needs a two-file mutation, which proves less; left `unmeasured`.
  - **Rows 1, 14, 17 and 20 are sound but UNPROBED**, and deliberately so: their mutations need call paths that
    were not traced, and guessing produces exactly the artefact this index removes — three of the five defects
    above are that shape. Row 8 stays `unprovable`; no integrations entity exists to revoke.

- **ACBP-P7-008 failure-injection pass** (CDR-084; NFR-005, NFR-019 — **NFR-020 removed**, see below).
  Branch `p7-008-failure-injection-pass`, draft PR **#81**, head **`668198f`**. No migration.
  Rendered evidence: `docs/implementation/P7-008-SCENARIO-EVIDENCE.md` (generated; `check:scenario-evidence`
  fails the build if it drifts from the index).
  - **Built:** `tools/failure-scenario-index.mjs` (16 rows) + `check-failure-scenario-index.mjs`;
    `tools/lib/test-citation.mjs` extracted and shared with the P7-007 checker; the fake-provider naming trap
    closed (`FakeModelProvider` → `AlwaysSucceedsModelProvider`); `check:duplicate-exports`; two new dispatcher
    integration tests (an **expired** approval is denied `approval_invalid` and the denial is RECORDED, with a
    control; launch **gate 8** measured through the **production** `activateStop` use case rather than a raw
    INSERT helper, which was trust-critical #10's recorded defect); the `mutation` column of BOTH indexes made
    machine-checkable and **eighteen of thirty-three rows rewritten** from wishes into applicable edits.
  - **NFR-020 removed from the backlog row** per CDR-084 §5 and the owner ruling — the repository already said
    three times that it was deferred scope governed by an ADR this ticket does not cite. Verified by re-parsing
    the CSV and diffing all 101 rows: exactly one cell changed.
  - **THE PROBE RAN (2026-08-07), and four rows are now GREEN in the sense CDR-084 SS1 defines.**
    **(SUPERSEDED BY `442456d` — it is FOURTEEN now. This bullet records the first four and the runs that bought
    them; the other ten are in the `442456d` block above.)** Five
    mutations on a disposable branch `p7-008-mutation-probe`, one live at a time, each type-safe and lint-clean
    so it reached the tests: M1 `31129056434` (approval expiry, both halves; 2 red) measured scenario 9 AND
    trust-critical #7; M2 `31129196873` (account_wide covers nothing; 9 red) measured scenario 15; M3
    `31139103437` (company scope matches nothing; 4 red) measured trust-critical #10; M4 `31140011057` (paused
    company enqueues; 1 red) measured scenario 16; M5 `31140772210` (audit rejection swallowed; 1 red) measured
    scenario 14. Every failed test name was READ OUT OF THE RUN LOG. Ceilings moved DOWN for the first time:
    failure-scenario 16 to 12, trust-critical 18 to 16 (`Ceiling 16 <= baseline 18 (origin/main)`). Full table
    and the green-half reasoning: CDR-084 SS11.
    **(SUPERSEDED TWICE: `442456d` took the failure-scenario ceiling to 2, and `5b7ad92` took the trust-critical
    ceiling 16 → 8. Neither half is at 16 any more.)**
  - **~~TWELVE SCENARIO ROWS~~ TWO SCENARIO ROWS AND ~~SIXTEEN~~ EIGHT TRUST-CRITICAL ROWS ARE STILL `unmeasured`**, and
    the acceptance criterion "16-scenario matrix green" is still NOT met — SS0.1 explains why it cannot be on its
    literal wording. **The reason has changed and the sentence is corrected rather than left to read as though it
    had not:** when this was written, twelve rows were unmeasured and the blocker was a GitHub Actions outage
    (15:22 UTC 2026-08-06, webhooks ~15%) that created no run for this branch at all; the `workflow_dispatch`
    trigger added at `2314ef7` re-opened the route, and the claim in that commit that it could not help its own
    branch was tested and found FALSE. Ten of those twelve were then measured on `442456d`. The two that remain,
    rows 5 and 10, are not waiting on a probe — they have no injectable subject, so no run can ever measure them.
  - **BOTH BRANCHES WERE DELETED on the owner's instruction (2026-08-07)** — `p7-008-failure-injection-pass`
    (was `76facb5`) and the disposable probe branch `p7-008-mutation-probe` (was `6cf0d6f`). Neither held
    content that existed nowhere else, and that was checked rather than assumed: `git diff 76facb5 7730d84` is
    EMPTY, so the squash is tree-identical to the verified head, and `git diff b42101b 6cf0d6f` is EMPTY, so
    the probe branch carried no change at all.
    **THE FIVE PROBE COMMITS ARE NOW REACHABLE FROM NO REF, AND THAT IS THE DESIGN RATHER THAN AN OVERSIGHT.**
    It is precisely what happened to ACBP-P6-006's probe commit `fe85082`, which `tools/trust-critical-index.mjs`
    cites in its own header as the reason a measurement is recorded as a hosted RUN ID and never as a SHA. All
    five still resolve under `gh run view`: `31129056434`, `31129196873`, `31139103437`, `31140011057`,
    `31140772210`. This bullet previously read *"still exists … deleting it is an owner action"*, which the
    deletion made false — recorded here rather than silently rewritten.
  - **(superseded) The open item WAS the probe, and it WAS blocked.** "16-scenario matrix green" means a recorded mutation
    reddened the cited test in a hosted run. **GitHub Actions entered a major outage at 15:22 UTC on 2026-08-06**
    (webhooks throttled to ~15%) and **has created no workflow run for this branch at all** — not for `f90566b`,
    not for `9c34123`, not since. So **0 of 16 rows are measured**, and the slice-4 and slice-5 tests are
    written, typechecked and cited but **UNVERIFIED**: they are `describe.skipIf(!hasTestDatabase)` and skip
    locally (51 collected, 51 skipped). Nothing claims they pass.
  - **Owner decisions still open** (CDR-084 §7): rows 5, 6, 8, 10 and 16, the NFR-019 coverage cell, and the
    Closed-beta launch-gate sign-off.
- **MERGED — ACBP-P7-007 security test pass.** Squash **`1bb4751`**, PR **#76**, merged 2026-08-06 18:19 UTC on
  the owner's instruction. Exact-head CI **`31123686961`** on `381601a`: **265 files, 3782 passed, ZERO skips**;
  the merged tree hash `c236ea1` is byte-identical to that verified head, checked because a squash discards
  ancestry. **Exact-MAIN CI never ran**: GitHub created no workflow run anywhere in this repository between
  17:45 UTC and at least 19:11 UTC, the merge fell inside that window, and `ci.yml` has no `workflow_dispatch`
  trigger to force one. That step of the completion standard is **unmet, not waived** — tree-identity is an
  argument, not the run.
  **Its backlog row is deliberately NOT `Done`**: the acceptance criterion cannot be met on its literal wording,
  and **18 of 20 index rows are unproven**. Branch `p7-007-security-test-pass` still exists at `381601a`
  (deletion not authorized, and it is the only remaining copy of that history until exact-main runs).
  **One thing IS now proven that could not be before the merge**: `tools/trust-critical-index.mjs` exists on
  `main`, so the ratchet's no-rise rule resolves (`Ceiling 18 ≤ baseline 18 (origin/main)`) and raising
  `MAX_UNPROVEN` to 19 exits **1**. That closes the review finding that the word "ratchet" named no enforcer.

- **ACBP-P7-007 security test pass — working block** (CDR-080; NFR-010, NFR-018, NFR-021; ADR-007/009/014;
  `SECURITY-VERIFICATION-PLAN.md`; **launch Gate 12** feeds from here). Branch `p7-007-security-test-pass`,
  PR **#76**. No migration. Ledger: `P7-007-REVIEW-COVERAGE.md`.
  - **THE FINDING: the list this ticket is judged against was itself unreliable.** The acceptance criterion is
    *"all suites green"*, and **all twenty trust-critical negatives already had something green beside their
    names.** Reading the test **bodies** behind all twenty, as of `main` at `2c4f0f5`: **11** genuinely assert
    database state or a recorded row through the production entry point; **4** rest on a returned value or
    weaker; **3** never execute the claim as worded; **2** are not covered at all — 11+4+3+2 = 20. **Seven of the
    twenty attribution lines were wrong**, plus a misgrouped `#9` in a second canon file and **four coverage
    cells across the two traceability matrices** naming tests, rigs and reviews that do not exist.
    (This paragraph said `12` and totalled twenty-one until the second review pass. A classification of exactly
    twenty things that does not add to twenty is the cheapest possible self-check, and it went unrun in five
    documents at once.)
  - **THE ACCEPTANCE CRITERION CANNOT BE MET ON ITS LITERAL WORDING, and that is a finding, not a delay.**
    **#8 can never go green** — it asserts a revoked-integration denial and **no integrations entity exists
    anywhere**: no table, no migration, no service, no contract, no integration value in `TOOL_DENIAL_REASONS`.
    CDR-067, the decision record of the ticket credited with the rig, never mentions integrations. **#15's
    canonical wording is unbuildable** — it names a provider API key that does not exist in the runtime.
  - **THE RULING THAT SHAPES THE TICKET: a negative is GREEN only when its index row carries a recorded mutation
    with a hosted CI RUN ID** — the exact edit that weakens the control, and the run in which the named test
    actually went red. Not a probe SHA: P6-006's probe commit `fe85082` is reachable from **no ref today**, and
    P7-002 recorded none at all. Enforced by `tools/trust-critical-index.mjs` + `check-trust-critical-index.mjs`
    (new static gate): 20 rows, each pinned to a file, a **verbatim** test title, an entry point, a closed-vocabulary
    anchor class, who really built it, and **what it does not prove**. An attribution with no test is now a red
    build.
  - **THE PROBE RAN: run `31113087854`.** Three deliberately type-safe, lint-clean mutations; typecheck and lint
    clean, the gate reached the suites, **3747 passed / 5 failed of 3752**. The probe branch was then deleted **on
    purpose**, to demonstrate that the run id still resolves and the SHA does not — `gh run view 31113087854`
    answers today; `c17b2df` is on no ref.
  - **IT BOUGHT TWO ROWS, NOT THREE, AND I RECORDED THREE.** #15 (route egress + its `.reveal()` source guard)
    and #16 (logger `message`) are honestly measured. **#19 was not**: the row names the test *"a MATERIAL
    decision does NOT silently fall over"*, which asserts only outcome/fallbackUsed/callCount/validatedOutput —
    **the recorded mutation cannot touch any of them, and that test was green in the run.** What went red was a
    different test in the same file, through its *leak* assertion, making it evidence about egress rather than
    about silent fallback. Two independent reviews caught it; one pulled the run log. The checker could not,
    because **nothing cross-checks a row's `mutation` against its `testTitle`** — now stated in the tool's own
    header and printed in its success line (`run id recorded — shape-checked, not resolved`). #19 is back to
    `unmeasured`. **Ceiling 20 → 18: two rows are MEASURED, eighteen are not, and the index says so in that
    word.** The fifth red test was also collateral — appending the marker to `model` broke an unrelated
    success-path assertion — recorded rather than trimmed, because a non-surgical mutation makes a red run harder
    to read. A partial local run showed four; the fifth existed only in the full suite.
  - **ONE REAL PRODUCTION BUG, FOUND BY WRITING THE MISSING TEST.** `logger.ts` redacted `metadata` and `error`
    but emitted `message` **verbatim** — so any caller interpolating a secret into a log message published it.
    Red-then-green fix. The audit half of #16 is *not* closed: `boundedMetadata` rejects objects, arrays, Errors
    and null, then accepts **any string ≤1024 units with no secret detection**. That is now executable
    (`metadata-secrets.test.ts` pins today's behaviour and is written to fail when enforcement lands) plus a
    reusable real-PG sweep in `@acbp/test-support`. Enforcement is an owner decision — audit-or-nothing means a
    rejection fails the **product operation**.
  - **FIVE TIMES A TOOL THIS TICKET BUILT CAUGHT ITS OWN AUTHOR** (ledger §3): the index checker rejected my own
    citation one minute after it existed; the ratchet failed the build **for adding coverage**; a mutation that
    proved nothing was caught before being recorded (it never reached the assertion — *and that failure mode looks
    exactly like a finding*); the secret scanner was **invisible to itself** through a literal NUL byte, and
    seeing itself produced nine findings immediately; the index checker blocked a canon edit that rewrote a
    *statement* instead of its attribution.
  - **A SECOND ROUND OF REVIEW FOUND EIGHT MORE, AND EVERY ONE HAD PASSED.** Three adversarial lenses over the
    whole diff (guards, prose, security) returned: the #19 misattribution above; a `testTitle` check that was a
    bare substring match, so `test.skip`, an emptied body and a title surviving only in a **comment** all printed
    *"pinned to live tests"*; a "ratchet" that was an **editable integer naming no enforcer**; a route sweep that
    counted handlers *found* rather than handlers that *answered*, so an all-throw regression would go green
    having swept zero bodies; an audit sweep **vacuous against FORCE ROW LEVEL SECURITY** (zero rows, no error,
    reports clean) that also promised a `sweptTables` field which did not exist; two allowlist entries resting on
    a **demonstrably false** justification; a logger comment naming *"a connection string"* as an example the
    redactor did not handle; and **`check-secrets.mjs` still containing a literal NUL byte — inside the comment
    describing the NUL fix — so the scanner was still invisible to itself while three documents said it had been
    fixed.** Also two malformed CSV rows: an unquoted comma shifted every column after `Coverage status` in
    **both** traceability matrices, the exact defect class this repository has now hit twice. All fixed;
    `test:boundaries` 100 → **118**, and a new `check:csv-shape` gate makes the CSV class a red build.
  - **WHY IT IS NOT DONE**, deliberately: 18 rows are unproven (the remaining strengthening work is real-PG and
    local PostgreSQL is unreachable, so they are **left unmeasured rather than written unverified**); #8's
    disposition and `boundedMetadata` enforcement are owner decisions; staging does not exist in any form; the pen
    test is an external engagement; and **declaring launch gate 12 passed is the owner's, not this ticket's**.
  - **The three ASVS gaps — no CSRF, no HTTP rate limiting, no security headers/CSP anywhere in `apps/web` — were
    true as of `main` at `2c4f0f5`, and are now IN FLIGHT.** Three tickets spawned from this one are being worked
    on local branches `p7-013-csrf-origin-gate`, `p7-013-http-rate-limiting` and
    `p7-013-security-headers-and-csp`. **None is pushed**, so nothing about them is verified here and this ticket
    claims nothing about their state. The SHA is load-bearing: that line is a finding with a date, not a
    description of current state — which is the failure mode this whole ticket exists to catch.

- **MERGED — ACBP-P7-002 deactivation flows.** Squash `4125f0f`, PR **#74**, branch deleted. **Its backlog row is
  deliberately NOT `Done`**: it landed the company-pause half only, and the account half, the deactivate
  transitions and the durable-stop sweep remain owner decisions. The working block below is the detail.

- **ACBP-P7-002 deactivation flows — PARTIALLY LANDED, TICKET NOT DONE** (CDR-079; ACC-004, COMP-006 final;
  ADR-006; **launch Gate 14**; migration `0054`). Branch `p7-002-deactivation-flows`, PR **#74**. Ledger:
  `P7-002-REVIEW-COVERAGE.md`.
  - **THE FINDING THAT RESHAPED THE TICKET.** Gate 14 says "deactivation blocks new autonomous work", so the
    obvious work is two new states. **There was no gate to add them to.** Nothing in production read a company's
    lifecycle status before doing autonomous work: **pausing a company was a LABEL, NOT A CONTROL**, and had been
    since ACBP-P1-010. **FIVE** artefacts made the gap look closed — `canPickUpAutonomousWork`'s docstring (zero
    production callers), a green test that called that predicate on a returned value, `EVENT-CATALOG:40`'s
    claimed consumer (unchanged since the Phase-0 initial commit — it predates P1-010), `stop-service.ts:513`'s
    own admission about the machinery deactivation was to reuse, and — found last, during the docs pass —
    **`REQUIREMENT-TRACEABILITY.csv`'s COMP-006 row reading `Covered (MVP)`**, verified by two test suites that
    did not exist. That fifth one is the worst: a traceability matrix is what a reader consults to ask *"is this
    requirement covered"*, which is the exact question it answered wrongly.
  - **WHAT LANDED**, on the owner's ruling *"company-pause enforcement first, defer the account half"*: the
    widened lifecycle vocabulary and two-phase transition table; `mayStartAutonomousWork` — a pure, fail-closed
    ALLOWLIST over `unknown` rows, so an unrecognised status refuses by construction; **`readLifecycleDecision`,
    which is the function that actually READS** (both rows, `FOR SHARE`, inside the caller's transaction) and
    hands them to the predicate; **four enforcement points** (`startRun` before `claimAttempt`;
    `dispatchToolCall` beside the other facts so the refusal is still RECORDED; `enqueueJob` before the insert,
    with the refusal withheld until the idempotency read-back finds no existing job, so a replay still answers;
    `runJobStep` after the already-completed short-circuit); migration `0054`; and a real-PostgreSQL Gate-14
    suite. Credit the reads to `readLifecycleDecision`, not to the predicate — miscrediting a pure function with
    I/O it does not perform is exactly the `canPickUpAutonomousWork` defect above.
  - **THE SUITE IS MUTATION-PROVEN, NOT MERELY GREEN — with a caveat this ticket owns.** A disposable probe
    branch neutralised the gate without touching a test: **8 of the then-17 cases went red** through production
    paths. The first probe attempt went red at LINT and never reached the tests — a false confirmation, caught.
    It also exposed a negative-only assertion in the new suite that passed with the gate off. **But the probe was
    not preserved and no CI run is cited**, unlike ACBP-P6-006, which at least recorded its probe's CI run id (`30646208952`, CDR-071:184) beside the SHA `fe85082` — that SHA is on no ref either, so the run id is the durable half — so nobody can
    re-derive the figure; and the suite is 18 cases now. Preserve the next probe.
  - **THE REVIEW FOUND THIS TICKET DISABLING A MERGED CONTROL.** The lifecycle gate outranks the stop gate, and
    P6-007's held-work capture was keyed on *which refusal was reported* — so a company both non-active and under
    a live stop lost its ADMIN-002 confirm-or-discard review entirely. No fixture in the repository produces that
    combination, which is why nothing caught it. Fixed; **and the first fix was too broad, which CI refused** via
    a test whose own comment names that exact mutation. What shipped is a two-member set
    (`emergency_stopped || company_not_active`) AND `stopEvaluation.kind === 'stopped'` — not the kind-only key.
    General rule now in CDR-079 §9.14: *a new gate that outranks an existing one inherits **responsibility for**
    every side effect the old one carried.* (Those two words are the sentence: it is a duty on the author, not a
    description of what happens automatically — what happened automatically was the bug.) Nothing enforces it.
  - **BOTH HIGH REVIEW FINDINGS WERE IN THE TICKET'S OWN CLAIMS.** A comment asserted the gate closed the worker
    bodies "since every body takes a `runId`" — a `runId` is provenance metadata, not a check, and `runResearch`
    fetches and spends *before its first database statement*. And CDR-079 still said enforcement was "blocked"
    while the branch shipped it — **the record went stale before the code did, for the second time this week**.
  - **AND A THIRD PASS, OVER THE DOCUMENTATION ITSELF, FOUND MORE OF THE SAME.** Six adversarial lenses plus a
    completeness critic over every prose claim written for this ticket returned **36 confirmed defects, 7 HIGH**
    — including this file recording the ticket as **merged** when merging is an owner gate that has not been
    taken, the CDR still documenting the fix **CI rejected**, and a corrected catalog note certifying a
    *different* phantom consumer as real. **Every HIGH was in prose; none was in code.** The pattern is now
    established beyond doubt: on this branch the code was reviewed, tested, mutation-probed and CI-verified,
    while the sentences describing it were checked by nobody until they were checked on purpose.
  - **WHY IT IS NOT DONE**, and this is deliberate: the deactivate transitions are not built, so **nothing can
    reach `deactivating` in production**; the durable-stop sweep is not built, so a halt does not terminate runs;
    the account half is deferred; the worker bodies are still ungated. Each is an owner decision
    (§9.2 / §9.3 / §9.5 / §9.7 / §9.8 / §9.10, and §10 slice 5), not an engineering gap I may close alone.

- **DONE — ACBP-P7-001 export of documents and owned data.** Squash `cf67c7f`, PR **#73**, exact-head CI
  `31026433291` on `2c5a4c0` and exact-main CI `31027343426` on `cf67c7f` — both **256 files / 3631 tests, zero
  skips**, with the export real-PostgreSQL suite running **12/12**. Branch deleted after its tree hash was
  verified identical to `main`'s (`4d863ce`), because ancestry does not survive a squash merge. No migration. **Mechanism-complete, NOT
  production-complete**: there is no S3-compatible adapter (CDR-078 §1), so nothing here proves an archive lands
  durably and nothing claims it does. Two owner decisions stay open — the catalogue rows that still say Post-MVP
  (§2), archive retention (§7.2) — plus a third the review raised: the exclusion rulings for `memberships` and the
  billing ledgers are engineering defaults on a privacy question (§7.3).

- **ACBP-P7-001 export of documents and owned data — working block** (CDR-078; EXPORT-001, NFR-014; ADR-002,
  ADR-016; trust-critical #2; invariant 19; SECURITY-VERIFICATION-PLAN gate 12 support). Branch `p7-001-export`,
  PR **#73**, **no migration**.
  - **The ticket argues with itself, and canon settles it.** Acceptance asks for BOTH "archive matches in-product
    data" AND "zero secrets"; when a founder has typed their own key into their own document those conflict.
    `SECURITY-ARCHITECTURE:19` rules it — archives never contain secret values — so the value is redacted and the
    surrounding document STAYS, because dropping a document over one span loses the founder's actual work, which
    is the failure export exists to prevent. That forces a third manifest category: included WITH REDACTIONS.
    `manifestIsFaithful` answers the stronger question `complete` cannot.
  - **The classification is TOTAL and DECLARED** (§6). Every table carrying a `company_id` is in exactly one of
    two closed lists — 28 exported, 18 excluded with a ruling from a closed vocabulary — and a real-PostgreSQL
    guard compares them against `information_schema`, deliberately a DIFFERENT anchor from the `DatabaseSchema`
    interface the export reads through. A future migration adding a company-scoped table fails that guard until
    someone rules on it. Without it, the likeliest failure of "archive matches in-product data" — a collection
    nobody remembered — would be invisible to every test written against the code that forgot it.
  - **One generic reader over a closed allowlist**, not a mapper per entity (§6.1). A mapper that forgets a
    column under-delivers SILENTLY, which is ADR-002's failure; a generic whole-row read can only pick a new
    column UP, and that lands in the secret guard, which redacts, counts and reports.
  - **The value walk is recursive** (§6.2), because a row is not a text field: a secret at `payload.notes[2]` is
    exactly as gone as one in a top-level column. A leaf that cannot be represented excludes its WHOLE ROW; a
    secret in a KEY excludes too, because redacting keys would collide and one would silently overwrite another.
  - **Truncation is an omission, never a silent cap** (§6-G7): the read asks for `cap + 1`, so the extra row makes
    the collection ship what it can AND enumerate itself as `truncated`.
  - **The omission vocabulary SHRANK** (§6.5). `unsupported_format` shipped in the manifest slice and never
    acquired a producer — artifact BYTES are not copied by this ticket — and a reason nothing can produce is a
    case a reader will wrongly believe can occur. Removed; `truncated` added, which something does produce.
  - **Objects first, audit last** (§6.6), each object READ BACK before anything records it (TASK-005's quiet
    failure half, reused rather than re-derived). Audit-then-write would leave a permanent record asserting an
    export that does not exist; this ordering leaves objects with no record, which are inert.
  - **No `export_jobs` table** (§6.7), though the BACKLOG data-objects cell and EVENT-CATALOG `:279` both name
    one. A job row exists to be POLLED and §4 ruled out the surface that would poll it, so it would have one
    writer, no reader and no observable status. `artifact.exported` — catalogued since long before anything could
    emit it — is the durable record, registered in the same commit as its emitter.
  - **`export:create` is OWNER-ONLY** and deliberately narrower than the reads it composes: a viewer who may READ
    the understanding in-product is not thereby entitled to walk out with an archive of it.
  - **The independent review found a DISCLOSURE defect** (§6-G6a). The ownership check returned the failing rows'
    IDENTITIES and the export wrote them into the manifest — so a row that leaked past RLS would have had its id
    handed to the wrong founder, confirming another tenant's record exists and naming it, which is exactly what
    §3-G8 forbids. It would have shipped LOOKING LIKE DILIGENCE. Fixed at the source: the function now returns a
    COUNT, because a return value that must never be used is an invitation.
  - **Mutation testing: 17 guards, four findings** — see `P7-001-REVIEW-COVERAGE.md`. Two were tests that could
    not fail: `expected !== ''` was unmeasured because no case crossed the two blank values, and both
    case-insensitivity tests used a fixture uuid of ALL DIGITS, so `toUpperCase()` was a no-op and they compared a
    string to itself. A third was a fake control — two allowlist conditions that both derive from the same
    constant, so deleting either left everything green.
  - **Disclosed rather than designed around** (§6.8): the whole export runs inside ONE database transaction,
    which against a real provider means holding it open across ~56 network round trips. Belongs to the ticket
    that brings the adapter.
  - **Backlog row flipped to Done in this branch**, per this repository's convention that the Status flip lands
    with the ticket.

- **DONE — ACBP-P6-012 Slice F integration: safety and recovery.** Squash `b36a079`, PR **#72**, exact-main CI
  `30972753666` (zero skips). M6's exit criterion is satisfied by it. **Phase 6 is 12/12.**

- **DONE — ACBP-P6-008 Decision Room and activity completion.** Squash `1f4acaa`, PR **#71**, migration `0053`,
  exact-main CI `30929427397` (zero skips).

- **ACBP-P6-012 Slice F integration: safety and recovery — working block** (CDR-077; POL-005, APPR-004,
  ADMIN-001, TASK-009, TASK-006, USAGE-001; ADR-009/ADR-010; **M6's exit criterion**). Branch
  `p6-012-slice-f-integration`, **no migration, and no production code at all** — the ticket is composed
  evidence, not new behaviour (CDR-077 §3-G11).
  - **Branched from `main` before P6-008, and `main` was merged INTO it after P6-008 landed** (`1f4acaa`).
    Slice F depends on none of the Decision Room — it sits on policy, approvals, stops, idempotency and usage,
    all of which predate it — so the two verified each other only at this merge, not before it. A rebase was
    NOT used: the branch was already pushed, and rewriting pushed history is not authorized. The squash merge
    collapses the merge commit anyway.
  - **What it adds that the five mechanism suites do not** (CDR-077 §0). Every scenario already has a dedicated
    real-PostgreSQL suite; re-running those assertions would cost time and yield nothing. What nothing tested is
    that the controls hold TOGETHER in one company's continuous lifetime: a deny that still refuses with a live
    human approval standing against the same call; a stop that outranks that approval and leaves it UNSPENT; a
    re-delivery that spends NO second approval (two single-use guards, never run against each other before); a
    halted company that can actually be resumed from; and totals that still reconcile after all of it.
  - **All ten steps pass live** against real PostgreSQL under the restricted `acbp_app` role with FORCE RLS —
    one control step, the backlog's five scenarios, and M6's sixth criterion (usage reconciliation, which the
    backlog's scope column omits and the milestone sentence names). `pnpm demo:slice-f` prints each step with
    its evidence and exits non-zero on any failure; `packages/core/src/tools/slice-f.e2e.integration.test.ts`
    asserts the same shared journey, so the milestone demo cannot drift from the suite.
  - **The journey was checked for vacuity, not just for green.** Setting the "edited" payload equal to the
    approved one made step 4 fail as it must, truncated the run at 4 steps, tripped the sequence-length guard
    and exited 1 — so the binding assertion discriminates and a short run cannot read as a pass.
  - **Two honest limitations, stated in the demo's own output rather than only in the CDR.** No external action
    has ever executed (no tool implementation exists; "the approved action ran" means the chokepoint authorized
    it and spent the approval — CDR-069 §1-G7), and policy RULES are installed on the owner connection because
    no product surface authors them (CDR-077 §3-G4). One stop scope (`company`) is exercised; the per-scope
    matrix stays the stop suite's job.
  - **Exact-head hosted CI [`30924099670`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/30924099670)
    on `14e5a88` is GREEN with ZERO SKIPS** — 247 files / 3503 tests, no `N skipped` line anywhere in the job
    log, and the DB preflight step (which fails if the integration suites would silently skip) passed. Local
    gate matched it exactly: typecheck, lint, secret scan, boundaries, `test:boundaries`, `test`, `run check`,
    `audit --audit-level high` (1 moderate, nothing at or above high) and `diff --check` all exit 0.
  - **Backlog row flipped to Done in this branch**, following this repository's convention that the Status flip
    rides in the ticket's own commit before the squash (as `f540fec` did for P6-010). The owner authorized the
    finalization sequence for PR #71 and PR #72 on 2026-08-04.

- **BACKLOG.csv drift, still open and deliberately NOT fixed here.** `ACBP-P6-003`, `ACBP-P6-004` and
  `ACBP-P6-005` read `Planned` for work that is merged in `main` (`9e339a3`, `7a5a9ea`, `7b4cc32`). The owner's
  authorization named this ticket's row and P6-008's, so those three are reported rather than edited — setting
  a row to Done is an owner gate and they are outside the authorized scope. `ACBP-P6-002` is separately and
  correctly marked OPEN: its evaluation point 1 is owner-gated by CDR-067 §1.

- **ACBP-P6-008 Decision Room and activity completion — DONE** (CDR-076; DEC-001, ACT-001/003/004/005; ADR-015;
  invariant 20; trust-critical #18). Merged as squash **`1f4acaa`**, PR #71, migration **0053**. Exact-head CI
  [`30928545553`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/30928545553) on
  `868e68a` and exact-main
  [`30929427397`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/30929427397) on
  `1f4acaa` both green with **ZERO SKIPS** (250 files / 3562 tests, no `N skipped` line in either job log, DB
  preflight passed in both). Branch deleted local + remote **after** verifying the tip's tree is byte-identical
  in `main` (`112c582b…` on both `868e68a` and `1f4acaa`) — ancestry is the wrong check across a squash merge.
  **NOT closed by this line:** there is still **no rendered UI** — the room ships as a read model and an API,
  and hollow-success prevention is enforced at the DTO boundary rather than by a renderer; the room accepts no
  writes; and there is no dead-letter/job section.

- **ACBP-P6-008 Decision Room and activity completion — working block** (CDR-076; DEC-001, ACT-001/003/004/005;
  ADR-015; invariant 20; trust-critical #18). Branch `p6-008-decision-room`, **one migration: `0053`** (widens the
  `activity_events_type_valid` CHECK; no new table, so no reset-list change).

  - **THE TWO THINGS THIS TICKET IS ACTUALLY ABOUT.** (1) The Decision Room composes ten queues from existing
    entities and refuses two specific lies: a `completed` task with no succeeded run cannot be returned at all
    (invariant 20 is an `EXISTS` in the SQL, not a filter afterwards), and a section that failed or that the
    caller may not read carries `count: null` rather than `0` — *"nothing needs your decision"* and *"we could
    not tell you"* must not render identically. (2) Execution finally reaches the founder-facing activity feed.
  - **Per-section SAVEPOINTS are the load-bearing mechanism**, not a refinement. One transaction with a
    per-section `try/catch` would let the first failed statement abort the transaction, and the other nine
    sections would then report nothing — an empty room that looks calm. The suite forces a section to fail and
    asserts the other nine still answer with their real counts.
  - **The live channel is poll-backed and says so in every message.** There is no outbox and no LISTEN/NOTIFY in
    this system, so calling it push would claim a mechanism that does not exist. It re-authorizes on EVERY tick
    through the same request path a plain GET uses (a membership revoked mid-stream ends the stream at the next
    tick), never opens for an unauthorized caller (the first read happens before any 200 is written), carries
    counts and a digest but never item payloads, and always ends with a named `closed` reason.
  - **Activity completion (CDR-076 §7)** — the gap PROJECT-STATE recorded below at "P6-008 owns the fix". Seven
    new projected types with all four required changes made together for each (contract type, CHECK, summary
    allowlist, call site). ACT-003's marking stopped being decorative: `executionStateFor` was a constant, and
    `approval.requested` is the first genuine PROPOSAL in the feed. **No backfill** — 0053 widens forward only.
  - **CDR-076 §4's "no new activity taxonomy" bullet is struck through by §7 of the same document.** Deferring it
    would have been a silent reduction of the ticket's named scope ("Decision Room and *activity completion*").
  - **NOT closed by this ticket:** no rendered UI (the repository is API-first and a first UI would be
    unreviewable against the trust criteria in the same pass — hollow-success prevention is therefore enforced at
    the DTO boundary, where no renderer can display what the contract cannot represent); no writes from the room;
    no dead-letter/job section.
  - **Local gate green** at `25e8840`: `pnpm test` **250 files / 3562 tests, ZERO SKIPS** against real
    PostgreSQL; typecheck, lint, `check:secrets`, `check:boundaries`, `test:boundaries` (51) all clean.
    **Exact-head hosted CI [`30918231209`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/30918231209)
    on `4bab40f` is green with ZERO SKIPS** — the same 250 files / 3562 tests, no `N skipped` line in the job
    log, DB preflight passed. The finalization commit that flips this ticket's backlog row moves the head, so
    the run proving the MERGED SHA is named on the DONE line above rather than here.

- **ACBP-P6-010 Limits and alerts — DONE** (CDR-075; NFR-015, POL-001; ADR-010/ADR-013; CDR-008's interim
  values). Merged as squash `f540fec`, PR #70, **no migration** — the ledger it reads is ACBP-P6-009's.
  Exact-head CI `30772614367` on `486dadc` and exact-main `30772966226` on `f540fec` both green with **ZERO
  SKIPS** (246 files / 3502 tests, and no `N skipped` line in either job log); branch deleted local + remote
  after verifying the tip's tree is byte-identical in `main` (`e86da7f1…`) — ancestry does not hold across a
  squash merge. **NOT closed by this line:** no production caller passes `caps`, so the gateway still enforces no
  ceiling on any real path (§4.3); and **AOQ-14's final values remain open**.

- **ACBP-P6-010 Limits and alerts — working block** (CDR-075; NFR-015, POL-001; ADR-010/ADR-013). Branch
  `p6-010-limits-and-alerts`, PR #70, no migration.
  - **THE CEILING IS REACHABLE AND UNREACHED, and that is the first thing to know** (CDR-075 §4.3). No production
    caller passes `caps`, because `createModelGateway` has no production composition at all — only demos, journey
    helpers and tests. **The gateway still enforces no ceiling on any real path.** One already-typed argument
    makes it live. Disclosed rather than papered over, and NOT worked around by wiring demos, which would make it
    look enforced where it does not matter.
  - **What it defused:** CDR-067 left a landmine aimed by name at this ticket — a `spending_limit` rule was
    UNEVALUABLE, so by CDR-066 §3-G9 a company with a spend cap would have had **every tool call refused**. The
    dispatcher now supplies the spend observation from the ledger. `policy-enforcement.integration.test.ts` had
    predicted this exact day and was updated on its own instructions; its original assertions were MOVED to
    `working_hours`, not deleted.
  - **The values are the owner's**, from CDR-008 §8 and ruled active this session: $5/day and $50/month per
    company, account ceiling 3×, soft alert 75%. **Labelled interim at the definition**, revisit-bound at
    CDR-008 §21's first alpha telemetry review. **AOQ-14 is NOT closed by this** — the final values still need
    telemetry no deployment exists to produce.
  - **A property of those numbers worth knowing** (§4.2): the account ceiling can only bind at **four or more
    companies**, since three each just under their own cap still total under 3×. It will read as a broken account
    cap to whoever next tests it with two.
  - **The review found the ticket's own gate unimplemented.** §3-G8 required one alert per crossing; the code
    wrote one per CALL, into a trail retained for the billing lifetime. The obvious fix is a trap — a unique
    idempotency key raises `23505`, which ABORTS the transaction, turning a soft alert into a hard outage. The
    mechanism is a read-before-write, and its limit (not exactly-once under a race) is stated where it lives.
  - **Deliberately not actioned:** no alert threshold beyond CDR-008's 75% is invented; `readSpendTotals` catches
    unconditionally (fail-closed, platform-wide blast radius, now written down).

- **ACBP-P6-011 Idempotency and replay hardening — DONE** (CDR-074; TASK-009, NFR-006; ADR-008/ADR-013; launch
  gate 5; trust-critical **#11 and #12**). Merged as squash `a3eea48`, PR #69, migration **0052**; exact-head CI
  `30728026202` on `a259948` and exact-main `30728297200` on `a3eea48` both green with **ZERO SKIPS** (240 files
  / 3449 tests, and not one `N skipped` line in either job log); branch deleted local + remote after verifying
  the branch tip's tree is byte-identical in `main` (`dfdd228e…`) — ancestry does not hold across a squash merge.
  **Not closed by this line:** a zero suppression count is still ambiguous, and the live canary that would fix
  that is P7-006's (owner-gated).

- **ACBP-P6-011 Idempotency and replay hardening — working block** (CDR-074; TASK-009, NFR-006; ADR-008/ADR-013;
  launch gate 5; trust-critical **#11 and #12**). Branch `p6-011-idempotency-replay`, PR #69, migration **0052**
  (`usage_events.idempotency_key` + partial unique index).
  - **Closes the LEDGER HALF of trust-critical #12**, which ACBP-P6-009 explicitly declined. Together with
    P6-009's rollup half, #12 is now closed end to end. Also closes **#11** (replayed jobs do not duplicate
    authoritative effects).
  - **It does NOT fix a live double-count and CDR-074 §2 says so.** Today's usage write is inline and
    fail-closed, so a failed write leaves nothing behind and a genuine retry means the model really was called
    again. The key closes a structural hole ahead of message-driven delivery. Do not read "#12 done" as "a
    double-count was found and fixed" — none was.
  - **The usage key is REACHABLE but UNWIRED, deliberately** (CDR-074 §5.4). Request → event → column is complete
    and exercised end to end; no production caller supplies one, because a *wrong* key UNDER-counts and nothing
    downstream ever contradicts an under-count. Two rules bind whoever first supplies one, stated at both
    contract fields.
  - **The incident counter cannot tell a broken path from a quiet week** (CDR-074 §5.2), and the doc leads with
    that rather than burying it. A zero count is ambiguous; the counter is evidence suppression FIRED, not that
    it WOULD have. A live canary is the only thing that fixes that, and it is P7-006's — owner-gated.
  - **Independent review found the defect that green CI did not** (CDR-074 §5.2a): `createIdentityWebhookService`
    — the live production entry point, and the ONLY surface that suppresses anything in production today —
    never passed a logger to the processor, so the counter was structurally incapable of recording the one
    duplicate that actually happens. Suppression itself worked throughout; the visibility did not. The replay
    suite missed it by calling the internal `processVerifiedIdentityEvent` instead of the entry point.
  - **A second-occurrence defect, now guarded:** migration 0052 broke a user-mapping test whose migration-drain
    loop capped at 50. P6-009's 0051 had broken the same pattern elsewhere and that fix did not sweep.
    `tools/check-migration-drain-loops.mjs` now fails the build statically; the loop records WHY it ended.
  - **Deliberately out of scope, not overlooked:** the `Idempotency-Key` HTTP surface (no HTTP mutation surface
    exists for these paths yet), and the four §1 suppression surfaces this ticket does not instrument — naming a
    surface nothing reports would claim coverage the ticket does not have.

- **ACBP-P6-009 Account usage rollups and reconciliation — DONE** (CDR-073; USAGE-001 amended; ACT-004;
  ADR-013/ADR-003 §16; launch gate 7; trust-critical #13/#14). Merged as squash `c43acf8`, PR #68; exact-main CI
  `30723999693` green with **ZERO SKIPS** (237 files / 3426 tests); branch deleted after verifying the branch
  tip's tree is byte-identical in `main` — ancestry does not hold across a squash merge. **Still owner-gated and
  NOT closed by this line:** the **drift threshold value** (§3.1 — required, defaulted nowhere) and **who may
  trigger a rebuild** (§3.2). *(This DONE line was added by the P6-011 session: the merge happened but the line
  was never written, so by this file's own rule the merged ticket was reading as in flight.)*

- **ACBP-P6-009 Account usage rollups and reconciliation — working block**
  (CDR-073; USAGE-001 amended; ACT-004; ADR-013/ADR-003 §16; launch gate 7; trust-critical #13/#14). Branch
  `p6-009-usage-rollups`, draft PR #68, migration **0051** (`account_usage_rollups`, `usage_corrections`).
  Built by TWO SESSIONS on one branch: Slices 1–3 and 5 here, Slice 4 by a concurrent session, coordinated by the
  owner. **The backlog row is deliberately still `Ready | Planned`** — setting a ticket Done, marking the PR
  ready, and merging are owner gates, and none has been taken.
  - **Closes trust-critical #13 and #14 in full.** Closes only the ROLLUP HALF of #12: a `SUM` cannot double
    count unless the ledger holds duplicates, and suppressing duplicate delivery is P6-011's. Do not read a
    later "#12 done" line as covering this.
  - **THREE independent review passes** (CDR-073 §5/§6), the third after CI was already green. It found no
    Blockers, three HIGH, three MEDIUM, eight LOW — every HIGH being a real control that no test measured, each
    now pinned by a test verified to fail when the control is deleted.
  - **Still owner-gated and NOT closed by this line:** the **drift threshold value** (§3.1 — a required
    parameter, defaulted nowhere) and **who may trigger a rebuild** (§3.2 — no `usage:rebuild` action exists;
    the rebuild is gated owner-only on `usage:read` as the most restrictive available posture, which a ruling
    can narrow but need not widen).
  - **Deliberately not actioned, not overlooked:** the accumulator's safe-integer guard has no test (reaching it
    needs ~2^53 tokens in one period, and a fixture faking that would misrepresent its own reachability), and
    the backlog's "company-move attribution" is structurally unreachable rather than implemented.

- **ACBP-P6-007 Emergency stop and resume review — DONE** (CDR-072; ADMIN-001/002; COMP-006; invariant 14; launch
  gate 8; trust-critical #9/#10). Merged as squash `1f3096d`, PR #67; exact-head CI `30705908508` on `19f5013` and
  exact-main `30706308683` on `1f3096d` both green with **ZERO SKIPS** (229 files / 3294 tests); branch deleted
  local + remote after verifying the branch tip's tree is byte-identical in `main` — ancestry does not hold across
  a squash merge. **Still owner-gated and NOT closed by this line:** the `account_wide` held-work scoping
  (CDR-072 §1-G6).

- **ACBP-P6-007 Emergency stop and resume review — working block** (CDR-072; ADMIN-001/002; COMP-006; invariant 14;
  launch gate 8; trust-critical #9/#10).
  **⚠️ SEVEN SCOPES ARE NAMED, FIVE ARE ENFORCEABLE.** `capability` and `integration` are **storable and INERT** —
  the tool registry carries no identity for either, so no call can be matched against them. They are refused at
  activation, and a stored one makes the evaluation **unreadable → deny** rather than being silently ignored.
  **Do not read "seven stop scopes" anywhere as seven working scopes.** Enforceable: `task`, `worker`, `company`,
  `external_actions_only`, `account_wide`. Reversible in one line when the registry gains the identity (CDR-072
  §1-G10) — **flagged for the owner**, because it narrows a canon-named control.
  **THE WHOLE TICKET IS WRITTEN AGAINST ONE FAILURE:** a stop that silently fails to reach one scope is worse than
  no stop at all, because the operator believes it worked and stops watching. Hence: every scope proven TWICE
  (halts what it claims, does NOT halt what it should not — over-halting is a different defect and still a defect);
  the evidence names WHICH scopes halted rather than that a stop was requested; and there is no partial success.
  **THE CALLER-INJECTABLE `stop` PORT IS DELETED** (§1-G1). It defaulted to `clear`, true only while no engine
  existed; with a real engine a caller could assert `clear` and walk through a live stop — the defect P6-003c
  closed for approvals. `ToolGates` now has no members and `tools/check-stop-port.mjs` (in `check:static`) keeps it
  gone, including the four evasions measured against real fixture trees.
  **THE §0 FAILURE HAPPENED INSIDE THIS TICKET, AND THAT IS THE MOST IMPORTANT FACT HERE.** The dispatcher resolved
  `task`/`worker` identities with `select … from worker_runs where id = <runId>`, but `runId` is a `task_runs.id` —
  the join key matched nothing, ever, and `task_run_id` is not a task id either. **Both scopes were storable,
  activatable, visible in the read model and halted NOTHING**, while the pure `evaluateStops` suite stayed green
  throughout. Fixed in `b9d303e`. Two lessons, both recorded in CDR-072 §G2: the covering relation being correct is
  NOT the same claim as the scope being enforced, so the matrix must run end-to-end; and a fixture helper that
  THREW instead of returning null is what exposed it — nulls would have compared against nulls and certified two
  dead scopes as enforced.
  **LAUNCH GATE 8 IS MEASURED, AND MET FOR FIVE OF SEVEN.** Hosted CI on `b9d303e` (`30680683466`, 227/227 files,
  3237/3237 tests, **ZERO SKIPS**): `account_wide` 6.7 ms, `external_actions_only` 7.1 ms, `worker` 7.8 ms, `task`
  7.9 ms, `company` 8.6 ms — bound 5000 ms. The two inert scopes never produce `emergency_stopped`, so there is no
  halt to time; a table of seven green rows would be exactly the false assurance §0 warns about.
  Done: contracts (seven scopes + covering relation, 8 mutations 0 survivors), migration 0050 (`emergency_stops`
  dual-scope like `audit_events`, `held_work`; no DELETE anywhere), `StopRepository`, three audit events naming
  scope + target, the stop service, dispatcher wiring + port deletion, the per-scope enforcement matrix, the timed
  gate-8 evidence, and `stop_scopes` on the refusal record so the evidence names WHAT halted the call.
  **TWO INDEPENDENT REVIEW PASSES, BOTH REMEDIATED; ONLY OWNER GATES REMAIN.** The second pass — briefed at the
  chokepoint write path — found a further **Blocker** (a held row could name a stop that never covered the call,
  because attribution matched scope NAMES against a list ordered by `activated_at`; the task could end up
  permanently paused and uncompletable) plus five Highs. All fixed. Two **PM rulings** are recorded in CDR-072
  §1-G6: the chokepoint holds what it refuses (Option B + C's labelling, with the recorded objection that this
  gives the chokepoint a task-lifecycle responsibility, and C named as the coherent retreat), and the in-flight
  **safe-stop at activation** (`task_runs.stop_requested_at` → `decideStepAdmission` halts the worker at its next
  checkpoint) — the latter a CANON finding from `WORKFLOW-STATE-MACHINES.md` §4, which assigns the stop checks to
  different actors and gives in-flight work a safe-stop rather than another gate read.
  **A COMMENT AUDIT** over every P6-007 guarantee-claim found three asserting properties the codebase does not
  provide — all three in the labelling added FOR the condition about not overclaiming. The rule left in the code:
  *if a comment claims a guarantee is ENFORCED, the enforcement must be nameable — a test, a constraint, a checker
  — or the sentence goes.*

  **BOTH FIRST-PASS BLOCKERS AND ALL THREE HIGHS ARE ALSO CLOSED** (`2afc604`, `cf154f6`, `0972701`, `02962e7`, `4140986`,
  `4f82b6c`). Exact-head CI `30698900097` on `4f82b6c`: **229/229 files, 3285/3285 tests, ZERO SKIPS**, including
  33 stop-service cases and gate 8 measured at **4.5 ms through `activateStop` itself**. What remains is the
  owner-gated `account_wide` held-work scoping, plus ticket Done / PR ready / merge.
  The history below is kept rather than tidied away, because the shape of the errors is the useful artifact.

  **🔴 AN INDEPENDENT REVIEW FOUND TWO BLOCKERS, AND CORRECTED A FALSE ASSURANCE THIS FILE CARRIED.**
  This block previously said the sibling-company scoping meant *"nothing auto-fires on resume"* held "for one
  company only". **That was false and it was written by the author of the defect.** It held for NO company:
  `held_work.status` was written by `reviewHeldWork` and read by NOTHING, so clearing the stop authorized every held
  task's next call regardless of whether its review said `held`, `confirmed` or **`discarded`**. A narrower, more
  comfortable reading of a real defect was recorded as established fact here, in CDR-072 and in a direct report to
  the owner. **Wrong documentation is worse than missing documentation** — it closes the question.
  **BLOCKER 1 — ADMIN-002 review-to-resume enforced nothing.** CANON ALREADY SPECIFIES THE FIX (a canon finding, not
  a design choice): `WORKFLOW-STATE-MACHINES.md` §4 lists `paused` among the task holds and gives
  `running→paused / paused→running` with actor *"system (company pause / emergency stop)"*, precondition *"scope stop
  active"*, effect *"held visibly; resume requires review (ADMIN-002)"*; `queued→running` already requires
  *"stop-state clear"*; `diagrams/13` ends *"CONFIRMED items resume from checkpoints"*. `paused` and both transitions
  are ALREADY in the implemented `LEGAL_TRANSITIONS` (P4-002, verbatim from WORKFLOW §4) — a specified transition
  simply had no producer.
  **BLOCKER 2 — the stop controller had zero tests and zero callers.** `activateStop`/`clearStop`/`reviewHeldWork`/
  `readStopState` had never executed; the dispatcher suite used its own raw-insert helper. Every service-level guard
  was unproven, including `StopRepository.insert`'s `ON CONFLICT` inference against the partial index — the
  `credit_transactions_reservation_key_uq` shape that once left a write path dead.
  **CLOSED by `stop-service.integration.test.ts` (33 real-PG cases).** The single most valuable assertion is
  `already_active`: it proves the `ON CONFLICT` inference against the `NULLS NOT DISTINCT` partial index RESOLVES.
  Had it not, PostgreSQL would raise 42P10 and every activation would die — a safety control that cannot be switched
  on, in the one ticket about a control that must never fail silently. §1-G8 is likewise proven, not promised: a
  throwing audit writer leaves no stop row, no held work and no event.
  **BLOCKER 1 CLOSED THE WAY CANON SPECIFIED IT.** Activation transitions the RUNNING tasks it caught
  `running → paused` in the same transaction as the hold; a `paused` task returns to `running` ONLY when its held
  item is CONFIRMED; a DISCARD leaves it paused (not cancelled — "nothing lost"). Reviewing while the stop is still
  active is refused (`stop_still_active`), because ADMIN-002 says clearing OPENS the review. Only `running` tasks
  transition: `queued` is already gated by WORKFLOW §4's `queued→running` "stop-state clear" precondition, and
  `waiting_*` tasks are not executing — all are still HELD, since the review is about what the operator must decide
  on, not only what changed state. `paused_count` joins `held_count` on the activation event so "held 5, paused 2"
  distinguishes a halted fleet from a queue that never started.
  **THREE HIGHS, ALL FIXED:** the hold query ignored scope entirely (a `task` stop held ALL in-flight work and
  reported it) — now per-scope, with `external_actions_only` deliberately holding NOTHING because it halts calls
  rather than tasks; `task`/`worker` targets were unvalidated free text (active, visible, halting nothing — the same
  hole closed for `company` and not generalised) — now resolved against `tasks`/`worker_definitions` under RLS, so a
  foreign company's task reads as ABSENT rather than forbidden; and **gate 8's measurement timed a raw superuser
  INSERT rather than `activateStop`**, which does N+3 round trips — the 6.7–8.6 ms figure is WITHDRAWN as evidence
  and replaced by **4.5 ms measured through the real call**, with the test stating plainly what it does not cover
  (single company, small N, one host; not a distributed-fleet claim).
  **⚠️ STILL OPEN AND OWNER-GATED — an `account_wide` stop holds only the raising company's work.** A *second*,
  genuine defect: `held_work.company_id` is NOT NULL with a tenant-pinned FK and activation runs inside ONE
  company's scope, so `held_count`/`pending_review_count` count one company. Fixing it means establishing each
  company's scope inside one account-wide operation — a **tenant-isolation decision**. Three options in CDR-072 §1-G6.
  **Ticket Done / PR ready / merge are owner gates and have not been taken.**

- **ACBP-P6-006 Autonomy levels 1–2 — DONE** (CDR-071; APPR-008; PRD §12/§11.5). Merged as squash `fdc3065`,
  PR #66; exact-head CI `30649500593` on `a9a57f6` and exact-main `30650127201` on `fdc3065` both green with
  **ZERO SKIPS** (226 files / 3153 tests); branch deleted after the second.

- **ACBP-P6-006 Autonomy levels 1–2 — working block** (CDR-071; APPR-008; PRD §12/§11.5).
  **THE PLATFORM ALREADY HAD LEVEL 2 AND NOBODY HAD SAID SO.** `DEFAULT_NEW_COMPANY_POLICY` carries the owner's
  ruling of 2026-07-29 — informational and internal-reversible allowed, anything higher requires approval — which is
  §12's L2 row behaviour for behaviour. So this ticket NAMES an existing posture and adds the stricter one; the L2
  rule set is that existing constant, with a test asserting they agree, because two definitions of "what executes
  without asking" is one too many.
  **THE LEVEL COMPOSES, IT DOES NOT SELECT.** A policy row carries both a level and stored rules; if the level merely
  picked a rule set, a company at L1 with permissive stored rules would have two contradictory answers and the wrong
  one executes. `autonomyLevelRules` returns RULES, not a rule set — rules only restrict, so composition under the
  existing most-restrictive ordering can only tighten. A rule set carries a baseline, and a baseline REPLACES.
  **TWO DEFAULTS DECIDED OPPOSITELY:** a new company starts at **2** because the owner ruled that posture (tightening
  it unilaterally would override an accepted decision under cover of caution); an unreadable or out-of-range stored
  level collapses to **1** because corrupt data is not a configuration anyone chose. A test asserts they are not the
  same constant.
  **LEVELS 3–5 STORABLE, REFUSED BY NAME, NEVER CLAMPED** — each refusal is followed by a read asserting the level is
  unchanged, so "refused" cannot secretly mean "adjusted". Migration 0049 admits 1–5 so later levels need no
  migration; the service admits 1–2.
  **NO UI.** The read model (which levels exist, which are available, each one's plain-language consequence) is in
  scope; the surface is an owner gate and nothing was scaffolded.
  5 mutations, 0 survivors, sources byte-identical. Exact-head CI `30645193259` on `b063505`: **226 files / 3151
  tests, ZERO SKIPS**.

- **ACBP-P6-005 Approval invalidation on edit — DONE** (CDR-070; APPR-004/007; **launch gate 4**; trust-critical #6).
  Merged as squash `7b4cc32`, PR #65. Exact-head CI `30640559611` on `d6f09bb` and exact-main CI `30641275447` on
  `7b4cc32` both green with **ZERO SKIPS** (225 files / 3066 tests); branch deleted after the second.

- **ACBP-P6-005 Approval invalidation on edit — working block** (CDR-070; APPR-004/007; **launch gate 4**;
  trust-critical #6). A Testing ticket, and the evidence is the deliverable: canon's clause is *"Editing a material
  approved payload invalidates approval"*, and M6's user-visible criterion is *"modified approved payload requires
  reapproval"*.
  **THE PROOF IS A MATRIX OVER THE BOUND ELEMENTS**, one case each for payload, tool and tool version, plus the
  cost bound at the contract — because a single changed-payload test would pass while three of the four did
  nothing, which is exactly how P6-004 shipped its version component inert. Every case ends at the DISPATCHER, and
  the group carries a mandatory control, without which "correctly refuses a modified payload" and "refuses
  everything" are indistinguishable.
  **THIS BLOCK'S FIRST VERSION OVERSTATED ITS OWN EVIDENCE, and the correction is the point of the ticket.** It
  claimed the not-burned assertion was in *every* case "proven by running the legitimate call afterwards" — true
  of the payload cases, not all — and it counted a "changed TOOL" case that, measured, never computed a hash at
  all: it dispatched a different tool, so scoping refused it before the binding was consulted, and deleting the
  tool component from `bindingMaterial` left the whole file green. Rebuilt so only the binding can refuse, and
  re-measured: **7 mutations, 0 survivors**. The per-claim table, and what the block CANNOT measure (the two
  enforcement layers mutually mask), are in CDR-070 §2.
  **WRITING THE PROOF EXPOSED A REAL GAP.** APPR-007 states the mechanism as *"Edit rebinds hash"*, and
  `decideApproval` accepted `supersededByRequestId` while checking NOTHING about it — any pending request in the
  company satisfied it, including one bound to a different action. The successor must now be bound to exactly the
  edited payload, recomputed with the same function the gate uses, pending, same run, same tool. A decision saying
  "I edited it to X" cannot be recorded unless a live request is bound to X.
  **NO SCHEMA, NO EVENTS, NO NEW AUTHZ.** `edited_data` is still not applied anywhere — the successor carries the
  edit because a human raised it that way, and the platform now verifies that rather than assuming it.
  Locally verified, NOT CI-proven: `pnpm run check` exit 0; **3063 tests / 225 files, ZERO SKIPS**.

- **ACBP-P6-004 Payload binding, expiry, revocation, single-use consumption — MERGED** (CDR-069; APPR-004/005/006/009).
  ADR-009's title, built: *"payload-hash-bound, expiring, revocable, single-use approvals enforced at the tool
  dispatcher."* The gate no longer asks "did a human decide something about this tool on this run?" — it asks "is
  there a live, unrevoked, unspent approval bound to THESE bytes, and did a human say yes?", and then spends it.
  Migration 0048 (binding hash + normalization version, required expiry, revocation and consumption columns, a
  CHECK making `revoked` and `consumed` mutually exclusive), `verifyAndConsume` as ONE conditional UPDATE,
  `revokeApproval` with its own owner-only `approval:revoke`, and the `approval.revoked` / `approval.consumed`
  events.
  **THIS ALSO CLOSES P6-003's `scope` GAP.** One `approve` on a `one_action` request authorized unlimited calls for
  the run's lifetime; single-use consumption IS that enforcement, which is why the two were always one problem.
  **EXPIRY SHIPS AS A MECHANISM WITH NO VALUES.** ADR-009 §15 leaves per-risk-class defaults an OPEN OWNER
  QUESTION (AOQ-14-adjacent), so `expires_at` is NOT NULL, caller-supplied, and defaulted nowhere in the stack. A
  nullable "no expiry" column was rejected: it would make the ABSENCE of an owner decision read as permission to
  never expire.
  **TWO DESIGN ERRORS, BOTH CAUGHT BY THE SYSTEM RATHER THAN BY REVIEW.** Reading only the REQUEST made a rejected
  approval authorize (a reject is `decided` too) — seven existing tests went red. And consumption was specified to
  run BEFORE the call was recorded; `consumed_by_call_id` is a real FK, so the database refused it, and the
  reasoning was unnecessary anyway because both statements are in one transaction.
  **NAMED LIMITS, NOT OVERLOOKED ONES:** the dispatcher cannot detect COST drift (it has no cost input, so it
  recomputes with the request's own stored cost — execution-time enforcement is P5-005); consumption at
  authorization BURNS the approval even if the call never runs (fail-closed, revisit when P5-005 gives a true
  execution instant); `approval.expired` stays unregistered because nothing sweeps expiry.
  Locally verified: `pnpm run check` exit 0; **3042 tests / 225 files, ZERO SKIPS**.
  **CI-CONFIRMED 2026-07-31 as part of main's tip**, run `30632188407` on `4c12da3` — 3053 tests, zero skips. Its
  own merge commit `7a5a9ea` produced a red run (`30632014201`) that was VOID: `steps=0`, the GitHub billing
  startup failure, never a test result. See the resolved block at the top for what that run does and does not prove.

- **ACBP-P6-003 Human approval engine (a/b/c) — MERGED, NOT DONE; sub-scope (d) is owner-gated** (CDR-068).
  The approval store exists and the dispatcher reads it. Contracts for the five decision paths, migration 0047
  (`approval_requests` + append-only `approval_decisions`, dual-keyed FORCE RLS, per-path `iff` CHECKs, the
  `decider_is_human` CHECK carrying invariant 5 at the schema level), the repository, and the service
  (`requestApproval` / `decideApproval` / `listApprovalInbox`, `approval.*` audit events in-transaction).
  **Both carried obligations are met:** the caller-injectable `gates.approval` port is DELETED, and evaluation
  point 2 is wired — the policy version the human decides under is recorded onto the request.
  **WHY NOT DONE:** (d), the approval inbox UI, is frontend and sits behind the owner's standing gate. Nothing in
  a/b/c is blocked on it; the engine is complete and headless.
  **TWO INDEPENDENT REVIEW PASSES FOUND REAL DEFECTS, and the second measured rather than read.** 35 source
  mutations, **15 survived** the full 2953-test suite. What that exposed:
  - `edit_then_approve` **authorized the payload the human edited away** — nothing read `edited_data`, the
    dispatcher's read had no `r.status` filter, and a superseding decision without a successor was silently
    downgraded to a plain decision. Fixed at three layers.
  - A **deferral was only honoured when policy happened to demand an approval**. A not-yet-due `schedule` mapped to
    `unavailable`, which refuses only when an approval was required, so an informational call riding the no-gate
    waiver ran the deferred action immediately. `unavailable` now means exactly one thing: no decision exists.
  - The risk class shown to the human was **caller-supplied while labelled `registry`-provenanced**; it now comes
    from `tool_definitions`, so the claim is true by construction.
  - Invariant 5's three layers **all tested the same caller-supplied string**. The decider type is now derived
    server-side and is not expressible in the caller's type at all.
  - **The service had zero tests and zero consumers** — `packages/core/src/approvals/` was never re-exported from
    the core index, so nothing could call it and every guard in it survived mutation. Exported, and covered by 21
    real-PG tests; 10 of 11 service mutations now die (the survivor is documented at its guard site).
  - "Latest decision" was ordered by a **caller-supplied timestamp**; now server `created_at` then `id`.
  **KNOWN AND MARKED, NOT SILENT:** CDR-068 §2-G4 (preview-equals-execution, APPR-010) is **still not built** —
  `preview` is free text with no relationship to `data`, and its failing-by-design marker test remains. P6-004 bound
  the PAYLOAD; deriving the PREVIEW from it is the other half and the two must not be conflated.
  **CI-CONFIRMED 2026-07-31 as part of main's tip**, run `30632188407` on `4c12da3`. Its own merge commit
  `9e339a3` produced a red run (`30590300693`) that was VOID — `steps=0`, the billing startup failure.
  Locally verified: `pnpm run check` exit 0; **2988 tests / 223 files, ZERO SKIPS** (real PostgreSQL
  live for the whole sweep; an earlier red run was VOID — WSL had shut the database down mid-run).

- **ACBP-P6-002 Dispatcher enforcement integration — MERGED, BUT THE TICKET IS *NOT* DONE** (CDR-067; PR #64).
  The policy engine now gates tool calls: `ToolGates.policy` is **deleted** and the dispatcher consults the engine
  itself inside the scope already open, so the evaluation, the `tool_calls` row and every audit event commit or roll
  back together. Migration 0046 adds `tool_calls.policy_eval_id` (nullable, tenant-pinned). INV-2 (single-read) and
  INV-4 (gate totality) are now directly tested, correcting CDR-066 §0.2's claim that INV-2 was untestable.
  **WHY NOT DONE:** the acceptance row says *"three evaluation points wired"* and **two of three are wired** —
  point 3, the one canon marks *"Never — mandatory (invariant 6)"*, and point 2, wired by P6-003c below. Point 1 needs an
  **OWNER RULING** (CDR-067 §1): the engine's observations are tool-shaped so a plan-accept evaluation would answer
  about nothing, and deciding what a point-1 refusal *does* changes P4-002's state machine — under the owner-ruled
  baseline, planning is internal work allowed by default, so a point-1 gate that refused planning would deny work
  the company's own policy permits. Safe to proceed past: points 1 and 2 sit strictly *earlier* than point 3 on
  every path, so their absence cannot let an action through.
  **A PM RULING, recorded as such (§2-G7):** an approval answer is demanded only when policy returned
  `require_approval`. This is a LOOSENING of a security check and was proven three ways before landing, including
  three compile-time `@ts-expect-error` assertions — if a `policy` gate or an `approvalRequired` fact ever becomes
  expressible, the typecheck fails.
  **The loosening opened a hole, and a test caught it, not review (§2-G9).** With the demand conditional on policy,
  an answer of `allow` left `untrustedContext` with no effect at all — the NFR-021 injection boundary went dead and
  laundered content would have reached tools on a plain `allow`. The boundary had been resting on the very
  behaviour the loosening removed. Found by the injection corpus (7 failures). Untrusted provenance now requires an
  approval in its own right; it still cannot grant one.
  **An adversarial review was commissioned before merge** against one question — *find any path where a call
  proceeds without an approval that policy demanded*. `decideDispatch` held on all ten attack lines. Two gaps came
  out anyway, both in code this ticket touched but did not change: `toPolicyGateAnswer` forwarded the decision
  unvalidated (and an unreadable decision landed on `unavailable`, the one value the waiver spares), and the
  idempotency short circuit reported a prior *denied* call as `duplicate` and did not bind the key to the
  arguments. Both fixed and mutation-proven.
  **CLOSED BY ACBP-P6-003c** (below): `gates.approval` was caller-injectable and is now deleted — the dispatcher
  reads a real stored decision. `tools/check-approval-port.mjs` fails the build if it comes back, in any of the four
  field shapes a review pass proved could evade the original pattern. `gates.stop` survived here for the same
  reason this one survived P6-002 — its engine did not exist — and **is now deleted too, by ACBP-P6-007**, which
  is what makes `ToolGates` empty. Four more residual risks stay logged in CDR-067 §2-G10.
  **CI-CONFIRMED 2026-07-31 as part of main's tip**, run `30632188407` on `4c12da3` — P6-001 and P6-002 entered
  main together as `338ae08`, which that run contains.
  Locally verified: `pnpm run check` exit 0, **2869 tests / 217 files, ZERO SKIPS** (real PostgreSQL
  live for the whole sweep).

- **ACBP-P6-001 Deterministic policy engine (a/b/c) — DONE** (CDR-066), merged on local verification with P6-002 on
  the same branch. Started by finding a **live approval bypass**, not by building a feature: `GateAnswer` could not
  express `require_approval`, so an engine demanding approval had to answer the policy gate `allow`, and the Phase 5
  waiver then treated that call as needing none. Owner ruled **option A**; §0.1 records the independently verified
  unreachability proof for the deleted branch and §0.2 its five invariants. When P6-002's semantics superseded the
  test carrying that ruling, **§0.3 traces the ruling to the four live assertions that carry it now.**
  a: pure evaluator — closed ordered vocabulary, most-restrictive-wins, total over `unknown` (junk ranks *most*
  restrictive so a malformed rule cannot vanish), clock and counters as inputs, model classifications typed
  untrusted, and a **required** `baseline` that mutation testing forced into existence. The owner-ruled
  new-company baseline is §3-G10; **AOQ-14's limit values remain unruled and unshipped.**
  b: migration 0045 — versioned `policies` (partial unique on active, column-scoped UPDATE) and append-only
  `policy_evaluations` with a composite FK pinning the version to the policy that produced it.
  c: the service — fail-closed; "no active policy" is an **answer** (deny), not an unavailability.

- **ACBP-P5-015 Slice E integration: safe internal execution — DONE** (CDR-065; M5 milestone exit), merged on
  local verification. **This closes Phase 5.** `runSliceEJourney` in `@acbp/test-support` + `pnpm demo:slice-e` +
  a real-PostgreSQL CI suite, all driving one implementation: preflight → queue → run → research document →
  provenance → completion → settlement → ledger → audit → revision → **re-execution** → 4 negatives. 17 steps,
  both the suite and the demo assert the count so a truncated run cannot read as a pass. **No production code
  changed; no migration; no new contract.**
  **Three limitations are recorded in the CDR and printed by the demo, because seventeen green steps invite
  over-reading:** (1) the credit is reserved *by the journey* — nothing wires reservation to the queue
  transition, and `task-management.ts:10` says the execution transitions' effects belong to later tickets;
  (2) `planned→queued` and `queued→running` are set on the owner connection because no use case implements
  them — `startRun` advances the *run*, not the *task*; (3) `RunResearchParams` has no guidance field, so a
  revision re-runs the same question and step 13 proves retention, **not** that revisions are steered.
  **A finding worth carrying forward:** `ACTIVITY_TYPES` is only the four `company.*` events, so **no execution
  event reaches the founder-facing activity feed at all**. The first draft of step 10 claimed the feed recorded
  the run and passed — on the `company.created` event left by seeding. The step now asserts the *absence*, so
  widening the taxonomy turns it red instead of quietly restoring the overstatement. **CLOSED by ACBP-P6-008
  (CDR-076 §7): the taxonomy was widened, the step went red exactly as designed, and it now asserts the opposite —
  that `task.created`, `task.started` and `task.completed` ARE in the founder's feed, still with no content.**
  Guard demonstrated, not assumed: feeding the fabricated-citation step a valid document turns it red
  (`expected uncertified, got ok`).
  Locally verified. **CI-CONFIRMED 2026-07-31 as part of main's tip**, run `30632188407` on `4c12da3`, which
  contains this merge.

- **ACBP-P5-012 revision workflow — DONE** (CDR-064; J-13; TASK-005 lineage), merged on local verification.
  Migration 0044 `artifact_revisions` + `requestRevision` + `readArtifactLineage`. **A revision creates a NEW LINKED
  TASK, not a run on the finished one** — `MASTER-PRD-v1.md` J-13 says so outright, `running→completed` is terminal,
  and at request time no run exists yet. `AI-AND-WORKER-ARCHITECTURE.md:13` summarises this as "new runs", which is
  what led slice 2's first schema astray; the conflict is now flagged inline at that line, and the PRD wins on
  canonical source priority (#4 above #5).
  **It charges no credit.** `WORKFLOW-STATE-MACHINES` §4 already meters `planned→queued`, so charging here would have
  doubled it — the D9 shape in a new place, caught before shipping and pinned by a test.
  Lineage is DERIVED (artifact → run → task → request), never a column on `artifacts`, so it cannot drift. Review
  pass 2 caught a key-reuse defect: one idempotency key reused for a different artifact used to report success for a
  document that was never revised; now a typed refusal.
  Locally verified. **CI-CONFIRMED 2026-07-31 as part of main's tip**, run `30632188407` on `4c12da3`, which
  contains this merge.

- **ACBP-P5-013 failure detail and visible retries — IN PROGRESS (window 13).**
  Branch `p5-013-failure-detail` (from main `bf381e7`), CDR-059. No migration — everything derives from
  `task_runs` columns that already exist, because a stored copy of a run's own facts could disagree with it.
  `describeRunFailure` is total: a failed run with no recorded category reports `unknown` with a real sentence
  (TASK-006's *"no blank failures"*). Retry visibility separates attempts used / allowed / whether another will
  happen, and a non-eligible category says so rather than showing a count nobody will spend. Retry safety
  defaults to UNSAFE, including for `unknown`.
  **Two deliberate widenings**: the activity taxonomy gains `task.failed` for ACT-005 (closed at four company
  events since CDR-016), and `task.failed` goes to schema version 2 with `retry_state` — the field P5-002's own
  docstring assigned to this ticket. Both review passes running; slices 1–4 done, 1412 local tests pass.

- **ACBP-P5-014 run preflight + credit ledger — CORE DONE / BLOCKED ON CI (window 13).**
  Branch `p5-014-credit-ledger`, draft PR **#62**, CDR-058, migrations **0041 + 0042**.
  **Both review passes FAILED and every finding is fixed.** They found two ways to create credits from nothing
  (a release exceeding its reservation — ~2.1bn credits, closed by a trigger; and a single-column company FK)
  and one unlimited-free-execution path (`settleRun` trusted a caller-supplied outcome). Also a HIGH
  disclosure: `billing:read` checked the COMPANY role, so a company owner who was only an account viewer would
  have received the whole account's ledger. Ledger `docs/implementation/P5-014-REVIEW.md`.
  **CI caught what both passes missed**: `{} as never` for the seed ops made all 14 ledger tests throw, and the
  suite stayed green locally because it is skip-gated. The AT-025 race has executed in **zero** environments.

- **ACBP-P5-005 worker runtime — DONE** (squash `bf381e7`, PR #61, exact-main CI green zero-skip 2390/2390;
  branch deleted). Migrations end **0040** on main.
  Branch `p5-005-worker-runtime` (from main `2f83f3c`), draft PR **#61**, CDR-057, migration **0040**.
  **This closes the clause CDR-056 §6 recorded as UNMET.** WORK-006's *"disable during execution triggers safe-stop"*
  was unmet for a structural reason: nothing linked a task run to the worker executing it, so "this worker's running
  work" could not be asked for. `worker_runs` is that link, in canon's own shape (a Task run HAS a Worker run;
  EVENT-CATALOG gives the events a `worker_run_id`). Company-owned, dual-keyed FORCE RLS, tenant-pinned composite FK
  to `task_runs`, `UNIQUE(task_run_id)`, and a column-scoped UPDATE grant leaving the STAMP and the SNAPSHOT bounds
  immutable — a run can never be re-attributed to another worker nor re-judged against a budget it was not given.
  `decideStepAdmission` is pure and total, the clock is a parameter, and the check runs BEFORE the step, which is what
  makes NFR-015's one-billing-increment overshoot bound actually hold. An unreadable bound HALTS rather than reading
  as "no limit". The runtime has NO tool-invocation path at all; routing worker tool calls through `dispatchToolCall`
  is a forward obligation on P5-006/007/008 (CDR-057 §1-G5 — an earlier wording here claimed the stronger thing).
  `setCompanyWorkerState` now sweeps the worker's running runs and requests a durable safe-stop on each **in the same
  transaction** as the state change, auditing each as `task.cancelled`/`running_safe_stop` and reporting how many;
  requested, never forced.
  A safe-stop is a fourth outcome `stopped`, filed under `worker.completed` with `run_outcome: 'stopped'` — not a
  failure (the run did what it was told) and not mistakable for finished work either.
  **BOTH REVIEW PASSES FAILED.** Pass 1 HIGH: `runWorkerStep` read the task run but consulted only `stop_requested_at`,
  ignoring its STATE — a run reclaimed as `worker_lost` can never be `requestStop`-ed again, so the worker became
  permanently UNSTOPPABLE while the sweep reported reaching nothing. Every test passed because the fixtures only made
  live task runs: the P5-002 defect shape exactly. Also fixed from pass 1: double admission under concurrency (now
  `FOR UPDATE`), a throwing step rolling its own spend back to zero, `finishWorkerRun` accepting any non-empty
  category string, and `HALT_REASONS` having no runtime form for its CHECK to be guarded against. Pass 2: the sweep
  set durable stops with NO audit record; the tool-chokepoint claim was asserted in five documents and enforced in
  none; a reclaimed attempt left a zombie `running` worker run for ever; no test asserted a single audit ROW; and
  `worker_runs` was missing from the central grant catalog. Ledger `docs/implementation/P5-005-REVIEW.md`.

- **ACBP-P5-004 worker definitions registry — CORE DONE / IN REVIEW (window 12).**
  Branch `p5-004-worker-definitions` (from main `83477a5`), draft PR **#58**, CDR-056, migration **0038**.
  **This closes the allowlist gap** CDR-054 and CDR-055 both deferred: the dispatcher's tool allowlist now comes from a
  VERSIONED DEFINITION rather than from whoever called it, which is what trust-critical #4 says. Two tables — global
  `worker_definitions` (SELECT-only, canon's eleven fields) and tenant `company_worker_states` (WORK-006's
  per-company pause, keyed WITHOUT a version so registering v2 cannot silently un-pause).
  **Both review passes FAILED.** Pass 1: CDR-056 claimed the MVP zero-external-actions boundary was enforced
  STRUCTURALLY and nothing called the check — a definition allowlisting an external tool would have resolved cleanly.
  It is now enforced at RESOLUTION (a violating definition may exist and can never be USED). Pass 2: WORK-006's
  "disable during execution triggers safe-stop" is unmet and was SILENT — it needs P5-005 to stamp a worker onto a
  run first, now recorded in CDR-056 §6; and WORK-001's listing acceptance was unproven.
  **IOQ-12 budgets are INTERIM and not owner-ratified** (CDR-056 §3) — no telemetry exists to derive them from.

- **ACBP-P5-003c injection boundary — DONE** (squash `83477a5`, PR #57, exact-main CI green zero-skip 2294/2294).
  **ACBP-P5-003 is complete** (a `5381389` + b `c9c4a5e` + c `83477a5`). Migrations end **0037** on main.

- **ACBP-P5-003c injection boundary — CORE DONE / IN REVIEW (window 12).**
  Branch `p5-003c-injection-boundary` (from main `c9c4a5e`), draft PR **#57**, CDR-055, migration **0037** (ALTER-only).
  **The boundary is PROVENANCE, not detection.** While any untrusted item is in the working context the dispatcher's
  informational waiver is withdrawn, so every tool call is refused with `untrusted_context`. That makes NFR-021's
  *"zero unauthorized tool executions"* structural: three of the nine corpus entries match no detector signal and are
  refused anyway. The corpus runs against a real database and asserts on the `tool_calls` TABLE, with a control test
  proving the same call on the trusted path IS authorized.
  **Both review passes FAILED.** Pass 1: `context` was optional, so a forgotten context defaulted to the trusted
  path; and the detector shipped uncalled. Pass 2 found a COMPLETE BYPASS — `tool_output` was classified as trusted,
  so a web-fetching tool's output re-entering the context would have laundered injected instructions straight back
  inside. Canon says *"per-tool class"*, never trusted. Ledger `docs/implementation/P5-003c-REVIEW.md`.
  **ACBP-P5-003 is complete** (a + b + c).

- **ACBP-P5-003b tool dispatcher chokepoint — DONE** (squash `c9c4a5e`, PR #56, exact-main CI green zero-skip
  2265/2265). Migrations end **0036** on main.

- **ACBP-P5-003b tool dispatcher chokepoint — CORE DONE / IN REVIEW (window 12).**
  Branch `p5-003b-dispatcher-chokepoint` (from main `f3452fc`), draft PR **#56**, CDR-054. Migration **0036**
  `tool_calls`. THE enforcement chokepoint: one exported `dispatchToolCall`, and nothing else executes a tool.
  **The Phase 5 envelope is canon, not a choice.** `IMPLEMENTATION-ROADMAP §M5` says verbatim *"P5 execution is gated
  by user-initiated runs on informational-class tools only"*, so `CLASSES_THAT_PROCEED_WITHOUT_A_GATE` is exactly
  `['informational']`. It waives only `unavailable`, never `deny`, and waives nothing else — registration, allowlist
  and stop state are checked regardless. Deliberately not a config value: a knob there is a knob that turns the
  chokepoint off.
  REFUSED CALLS ARE RECORDED, which is why `tool_id` has no FK (the commonest refusal is an unregistered tool) and why
  the class, version and external flag are snapshots of the gate actually applied.
  **Both review passes FAILED**, ledger `docs/implementation/P5-003b-REVIEW.md`. Pass 1: a blank idempotency key made
  two unrelated calls suppress each other, and a whitespace receipt satisfied the very constraint TOOL-002 exists to
  enforce. Pass 2: the record named the tool but not its VERSION, so a re-registration made every earlier record
  ambiguous about which definition applied; and two of three CHECKs still had one-directional drift guards.
  Hosted CI ran the 20-test dispatcher suite green on its first attempt (2260/2260, zero skips) — the reviews found
  what a green suite did not.
  **Also on this branch, and flagged rather than fixed:** `CDR-051 §0.1` — canon DOES enumerate the risk classes
  (APPR-001), my earlier "canon is silent" was wrong, and canon's fourth class is `sensitive-irreversible` rather than
  `external_irreversible`. See the FLAG in `AUTONOMOUS-RUN-LOG.md`; it is the owner's decision and nothing is blocked.

- **ACBP-P5-002 workflow coordinator — DONE** (squash `f3452fc`, PR #55, exact-main CI green zero-skip 2201/2201).
  Migrations end **0035** on main. Merged under delegated merge authority.

- **ACBP-P5-002 workflow coordinator — CORE DONE / IN REVIEW (window 12).**
  Branch `p5-002-workflow-coordinator` (from main `9b38d25`), draft PR **#55**, CDR-053. Migration **0035** `task_runs`.
  A RUN IS ONE EXECUTION ATTEMPT of a task — the small state set (`queued · running · succeeded · failed · cancelled`)
  is deliberate: WORKFLOW-STATE-MACHINES §4's `waiting_for_*` / `paused` / `blocked_by_policy` are TASK states owned by
  P4-002, and collapsing the two would make "which attempt failed, and why?" unanswerable.
  All three acceptance clauses proven against real PostgreSQL: cancel-queued-instant, running-safe-stop-bounded (a
  durable `stop_requested_at` the worker learns about at its next heartbeat), and timeout (a liveness SWEEP, not a
  timer — the process that would hold the timer is the one most likely to have died).
  Two authz actions, `run:execute` (the worker's) and `run:cancel` (the owner's), because a worker able to cancel its
  own run could hide work it had been told to stop. Three audit events registered; `task.completed` deliberately NOT,
  since canon requires `artifact_refs[]` on it and a run succeeding is not a task completing.
  **Both review passes FAILED**, ledger `docs/implementation/P5-002-REVIEW.md`. Pass 1: `cancelRun` could tell an owner
  "already terminal" about a *running* run. Pass 2: `startRun` would begin executing a task the owner had DELETED, and
  would start an attempt for a task in any state at all. The pass-2 pair hid because every test in the suite started
  runs against `draft` tasks — the fixtures agreed with the bug.
  Also on this branch, deliberately out of scope: `fix(repo)` stripping stray control characters that a PowerShell
  backtick-escape had eaten into three committed files (`audit.ts`, `retry.ts`, `EXECUTION-LOG.md`). The BEL in
  `audit.ts` had made git classify the blob as binary, silently disabling line-ending normalization for it.

- **ACBP-P5-001a durable job store + tenant stamping — DONE** (squash `ff845fd`, PR #50, exact-main CI green zero-skip
  2053/2053). **ACBP-P5-001b step checkpointing + resume — DONE** (squash `b36f5a8`, PR #53, 2084/2084).
  **ACBP-P5-003a tool registry + risk classes — DONE** (squash `5381389`, PR #52, 2117/2117). **ACBP-P5-001c retry cap
  + dead-letter — DONE** (squash `9b38d25`, PR #54, 2145/2145). **ACBP-P5-001 is complete** (all three sub-scopes).
  Merged in that order under delegated merge authority (owner decision, window 9), each with exact-main CI checked
  before the next. Migrations end **0034** on main. P5-003a's risk-class set stays **owner-approved-by-default and
  provisional** (CDR-051 §0) — a decision to revisit, not a settled one.

- **ACBP-P5-001a durable job store + tenant stamping — CORE DONE / IN REVIEW (window 9).**
  Branch `p5-001a-job-store-tenant-stamping` (from main `223f8e5`), draft PR **#50**, CDR-049. The FIRST of the twelve
  ratified safety-critical sub-scopes (owner decision 2026-07-27 approving my own 3-way splits for P5-001/003 and
  P6-001/007).
  **The load-bearing call was that WE own the job table.** The Objective's "library per ADR-008" reads naively as
  "adopt pg-boss and use its job table" — a serious mistake, since those libraries own their DDL and a table we do not
  own cannot carry a `NOT NULL` tenant stamp or dual-keyed RLS. The owner's ADR-008 amendment already settled it
  ("job tables remain standard SQL (exit path)"), so this needed no owner gate and P5-001a takes **no library
  dependency at all**. Migration **0031** adds `jobs`; migrations now end 0031.
  Three deliberately redundant refusal layers (CDR-049 §3-G3), each proven the only way it can be reached: `NOT NULL`
  via a direct insert that bypasses the use case; the dual-keyed `WITH CHECK` via a FOREIGN pair written from a valid
  session for another company; and the typed `validateJobTenancy` refusal through `enqueueJob`.
  **Review pass 1 found a HIGH worth remembering: the acceptance clause's refusal was UNREACHABLE.**
  `runInCompanyScope` denies a blank company id itself, so a context-stripped enqueue returned `forbidden` —
  indistinguishable from an authorization failure. The one failure this sub-scope exists to make visible was the one
  it hid. Fixed by moving ONLY the tenancy check ahead of authorization (it leaks nothing — it reports on the shape of
  ids the caller supplied), with a regression test driving five context-stripped shapes through a legitimate owner.
  Pass 1 also caught the row being stamped from caller params rather than `scope.tenant`, and a conflict branch
  returning a refusal reason that was a lie. Pass 2 added `JOB_STATES` mirroring the CHECK.
  **Hosted CI found two more, both mine:** PostgreSQL will not infer a PARTIAL unique index from a bare `ON CONFLICT`
  column list (42P10), and a COLUMN-level UPDATE grant never appears in `role_table_grants` — so the catalog suite's
  table-level expectation is `INSERT`/`SELECT` with the column grant asserted separately.
  `job:enqueue` is OWNER-ONLY: canon does not settle the role, so this took the safer reversible reading.

- **ACBP-P5-009 gateway v2: fallback model — CORE DONE / FINALIZING (window 8).**
  Branch `p5-009-gateway-v2-fallback` (from main `8239cc3`, after P5-010 merged), draft PR **#47**, CDR-047.
  **Checked before building, as with P5-010: most of it already existed.** The fallback slot, the fallover on
  retryable exhaustion, `isFallbackEligible`, generation's ineligibility, accumulated usage and `fallback_used` all
  came from P2-003/CDR-026. Two clauses did not: the fallback **reason**, and the **silent-fallback negatives**.
  Migration **0030** adds `usage_events.fallback_reason` (ALTER-only, nullable, no grant change). The value is the
  NORMALIZED `ModelErrorCategory`, never provider text, captured from the PRIMARY at the moment the fallover decision
  is taken — so when both providers fail, `fallback_reason` (why we left) and `error_category` (how it died) hold
  different values.
  **A migration-safety decision worth remembering:** the natural symmetric CHECK (a reason exactly when
  `fallback_used`) would have passed in CI, where the schema is rebuilt each run, and **failed on the first real
  deployment carrying history** — pre-0030 rows have `fallback_used = true` and no reason. Shipped one-directional,
  with the asymmetry pinned by its own real-PG test so a later "tightening" fails loudly.
  **Both review passes returned FAIL**, each finding a missing case in a trust-critical negative suite — the failure
  mode this ticket is most exposed to, since the deliverable is "prove the thing does not happen". Pass 1: nothing
  covered BOTH providers failing. Pass 2: nothing covered an ELIGIBLE class failing NON-RETRYABLY, so half the
  fallover predicate was unpinned. See `docs/implementation/P5-009-REVIEW-COVERAGE.md`.
  **The named "Claude Sonnet 4 fallback adapter" is DEFERRED** and recorded as such — exercising a live provider
  needs ACBP-P2-011 (owner gate). The gateway is provider-neutral, so the BEHAVIOUR is fully proven; what is not
  proven is that a specific vendor SDK conforms, which is what the gate is for.
  Exact-head CI green zero-skip **1963/1963** at `d7a7b8a`.
  Next: squash-merge → exact-main CI zero-skip → delete branch.
- **ACBP-P5-010 structured-output validation hardening — DONE** (squash `8239cc3`, PR #46; exact-main CI green zero-skip 1954/1954; branch deleted).
- **ACBP-P5-010 structured-output validation hardening — CORE DONE / FINALIZING (6th autonomous window).**
  Branch `p5-010-structured-output-hardening` (from main `ebbd8f1`, after P3-007 merged), draft PR **#46**, CDR-046.
  **The load-bearing finding came before any code: the MECHANISM ALREADY EXISTS.** Every mechanical clause of the
  Objective — schema-first validation, the terminal `invalid_output` category, the clamped re-ask bound, usage
  accumulated across attempts, no partial-accept path — is already implemented by P2-003/CDR-026, verified clause by
  clause. So the ticket delivers the CONFORMANCE SUITE the backlog actually names ("Invalid-output tests",
  "Validation suite") and nothing else: a second validation path would be two behaviours that can disagree.
  Seven properties pinned as BEHAVIOUR, in a **unit** suite that runs locally in ~1s (`callModel` takes provider,
  usage sink, cost estimator and validator by injection) — which is why both drafting errors were caught before the
  first push, including one where the test expected 4 calls for `maxReask: 3` and got 2 **because the platform clamps
  re-ask to one**; asserting `N+1` for arbitrary N would have been asserting the ABSENCE of the cap.
  **The acceptance criterion is honestly HALF met and says so.** "Invalid output cannot complete a task" names task
  completion, driven by execution (P5-002/P5-005, not built). Delivered: the gateway never hands a caller an
  unvalidated value (necessary). Not delivered: that a task cannot reach `completed` on one (sufficient) — the
  backlog itself files this as "trust-critical #18 **groundwork**", and the record says groundwork, not covered.
  **Both review passes returned FAIL** (Medium only, consistent with a ticket that adds no behaviour): the platform
  cap was hardcoded in a second place rather than derived from `MAX_REASK_ATTEMPTS`; the CDR listed six properties
  while the suite pinned seven; and the two request fixtures were written side by side so they could drift, when the
  opt-in test's whole meaning is that they differ in exactly one way. See
  `docs/implementation/P5-010-REVIEW-COVERAGE.md`.
  Exact-head CI green zero-skip **1954/1954** at `08e1018`.
  Next: squash-merge → exact-main CI zero-skip → delete branch.
- **ACBP-P3-007 Slice C integration: strategy selection — DONE** (squash `ebbd8f1`, PR #45; exact-main CI green zero-skip 1947/1947; branch deleted). **Phase 3 complete.**
- **ACBP-P3-007 Slice C integration: strategy selection — CORE DONE / FINALIZING (6th autonomous window).**
  Branch `p3-007-slice-c-strategy-selection` (from main `a214c4d`, after P4-007 merged), draft PR **#45**, CDR-045.
  The **M3 milestone exit**: confirmed understanding → three distinct options → advisory comparison → owner selection
  → immutable decision, ten steps, plus BOTH negatives the backlog names by hand. No new product behaviour.
  **The load-bearing step is #4:** the journey asserts the advisory recommendation has NOT auto-selected anything,
  after the comparison and before the owner acts. STRAT-003 is that the OWNER selects; without it the whole slice
  would pass on a system that quietly selected for them. It pairs with step 6 (the same field non-null after the
  owner acts), which is what stops step 4 passing vacuously.
  **Negatives:** near-duplicate options must COLLAPSE and say so on four channels (count, `insufficient_distinct`,
  non-empty `fewerReason`, `status = fewer_than_three`) — counting alone passes on a generation that returned two
  while calling itself complete. And a failing in-tx audit writer must leave NO decision row, with a CONTROL run
  proving the audit writer was the only difference.
  Commits: CDR `c8e934b` → journey + suite `4ec4df1` → usage outcome `d11ded2` → demo + doc `bc3cfa4` → review
  passes + finalization.
  **Both review passes returned FAIL.** Pass 1 HIGH: "usage verified" was asserted as `>= 5`, a floor — the exact
  failure this ticket's own CDR §5-G10 forbids two sections earlier; now exactly 5, the known call count. Pass 2:
  the 16 option fields were hand-listed instead of imported from the contract — the same defect class CDR-045 §2-G5
  exists to prevent, **and the identical duplication in the Slice D journey was fixed too** rather than shipping a
  flaw the ledger documents. See `docs/implementation/P3-007-REVIEW-COVERAGE.md`.
  **Only ONE CI round-trip lost, against P4-007's three** — the static field-name audit ran before the first push,
  which was that ticket's recorded lesson.
  Exact-head CI green zero-skip **1947/1947** at `d11ded2`.
  Next: squash-merge → exact-main CI zero-skip → delete branch. **Phase 3 complete.**
- **ACBP-P4-007 Slice D integration: planned work — DONE** (squash `a214c4d`, PR #44; exact-main CI green zero-skip 1946/1946; branch deleted). **Phase 4 complete (7/7).**
- **ACBP-P4-007 Slice D integration: planned work — CORE DONE / FINALIZING (6th autonomous window).**
  Branch `p4-007-slice-d-planned-work` (from main `d517203`, after P4-005 merged), draft PR **#44**, CDR-044.
  The **M4 milestone exit**: confirmed understanding → strategy → selection → decision → roadmap → tasks → board →
  detail → controls, fourteen steps each naming the requirement it evidences. Builds NO new product behaviour —
  no migration, no authz action, no audit event, no route, no UI.
  **The shape (CDR-044 §2, the CDR-031 precedent):** `runSliceDJourney` is implemented ONCE in `@acbp/test-support`
  and driven by both the CI suite and `pnpm demo:slice-d`, so the demo can never drift from the guarantee. The use
  cases are INJECTED (test-support importing core would be a workspace-graph cycle) and the structural `SliceDOps`
  is satisfied by the real functions with **no cast**.
  Everything runs on the restricted `acbp_app` connection under FORCE RLS; the owner connection may only inspect
  evidence or set up a precondition the product cannot yet reach (G3, refined in review).
  Commits: CDR `4e5a727` → journey + suite `0d4137c` → request typing `5869dda` → real DTOs `e1f047b` →
  payload column `da5efbc` → step count `722799a` → demo + doc `48aaded` → review passes `ae04902`.
  **Both review passes returned FAIL.** Pass 1: the journey mutated product state on the OWNER connection under a
  rule that said inspection-only — resolved by stating the real rule rather than letting the code diverge; plus a
  dead `listTasks` injection. Pass 2: "status inspectable" was asserted as "placed somewhere", which passes on a
  board that buckets every task WRONGLY — now asserts `planned` tasks appear in `to_do` specifically.
  **Process finding worth more than the bugs:** three CI failures were each one field name, two sharing a root cause
  — a hand-rolled structural subset allowed to be wrong. An OPTIONAL `blockedByDependency?: boolean` left the real
  `TaskBoardDTO` assignable, so the compiler was satisfied while the filter read `undefined`. The shapes are now
  aliases of the real contract DTOs. See `docs/implementation/P4-007-REVIEW-COVERAGE.md`.
  Exact-head CI green zero-skip **1946/1946** at `ae04902`.
  Next: squash-merge → exact-main CI zero-skip → delete branch. **Phase 4 complete (7/7).**
- **ACBP-P4-005 task detail and controls — DONE** (squash `d517203`, PR #43; exact-main CI green zero-skip 1945/1945; branch deleted). Phase 4 6/7.
- **ACBP-P4-005 task detail and controls — CORE DONE / FINALIZING (6th autonomous window).**
  Branch `p4-005-task-detail-and-controls` (from main `0a9aa08`, after P4-004 merged), draft PR **#43**, CDR-043.
  TASK-002's detail view + TASK-008's repeat/delete controls. Migration **0029** adds `task_deletions` (company-owned,
  dual-keyed FORCE RLS, SELECT+INSERT only, `UNIQUE(task_id)`) and `tasks.repeated_from_task_id` (nullable,
  tenant-pinned composite FK, INSERT-ONLY).
  **Load-bearing reading #1 (CDR-043 §2): there is NO task "reject" control, and this ticket does not invent one.**
  The backlog Objective says "repeat/delete/reject", but no requirement defines task rejection anywhere — the `reject`
  verb belongs to UNDER-003, STRAT-003 and APPR-007, all different objects; the same row's Acceptance criteria say
  only "Controls behave per state; repeat links lineage"; and the audit lists task rejection under "Controls not
  exercised". This **corrects CDR-042 §3-G3**: the board's `rejected` bucket is not "pending P4-005", it is
  unreachable because nothing defines it.
  **Load-bearing reading #2 (CDR-043 §3): delete cannot be a `DELETE`.** `tasks` has no DELETE grant and its column
  UPDATE is pinned to `(state, updated_at)`, which the adversarial catalog pins. TASK-008 requires the delete be
  AUDITED, so granting DELETE would destroy the evidence the requirement demands. Deletion is therefore an append-only
  FACT in a separate table, the `task_review_flags` precedent — and the catalog suite now asserts the UNCHANGED `tasks`
  grants in the same commit that adds the feature.
  Deleted tasks vanish from get/detail/list/board and the off-board draft COUNT via one shared `NOT_DELETED`
  predicate; `findStatesByIds` deliberately does not filter them, because a prerequisite deleted while `completed`
  really did unblock its dependent.
  One new authz action, `task:delete` (`owner|viewer` — canon says company-scoped, not owner-only); repeat adds none
  (it mints a task, which `task:create` already authorizes).
  Commits: CDR `d987dcf` → contracts `c402da4` → migration + repo `4c5f3d9` → core `8e4ecda` → docs + review fixes.
  **Both review passes returned FAIL.** Pass 1's HIGH: `planTask`/`addTaskDependency` still read through `findById`,
  so a DELETED draft could be planned onto the board and emit a `task.created` audit for a task no board read would
  ever show. Pass 2's HIGH was a **race pass 1 had read and approved**: `deleteTask` was a check-then-insert, so a
  task read as `queued` that started running in the window was still deleted — precisely TASK-008's failure clause.
  Fixed structurally, with the state guard inside the `INSERT ... SELECT`. See
  `docs/implementation/P4-005-REVIEW-COVERAGE.md`.
  Exact-head CI green zero-skip **1942/1942** at `8e4ecda` (slices 1–3); re-run pending on the review-fix head.
  Next: exact-head CI on the final head → squash-merge → exact-main CI zero-skip → delete branch.
- **ACBP-P4-004 task dependencies and board — DONE** (squash `0a9aa08`, PR #42; branch deleted). Phase 4 5/7.
- **ACBP-P4-004 task dependencies and board — CORE DONE / IN REVIEW.**
  Branch `p4-004-task-dependencies-and-board` (from main `b8dc466`, after P4-006 merged), draft PR **#42**, CDR-042.
  TASK-001's **views**: the six-bucket board plus visible dependencies. A pure READ — no state, no transition, no
  audit event, no storage, **no migration**.
  **The load-bearing reading (CDR-042 §2):** TASK-001 names six states while P4-002 implemented eleven. The evidence
  settles it — `raw-audit/evidence/task-states.csv` records four of the six as **empty tabs** ("existence observed;
  instances unknown"). What was directly observed is a set of board TABS, not six persisted states, and the backlog
  scopes this ticket to `TASK-001 (views)`. Inventing a `recurring` or `rejected` state would fabricate a mechanism
  the evidence never observed and silently widen P4-002's ratified machine.
  `placeOnBoard` is TOTAL: every state resolves to a bucket or an explicit `off_board`, and the board's own counts
  prove it (placed + drafts + unplaceable = rows). A task in the wrong bucket is a bug; a task in no bucket is
  invisible. `draft` stays off the board (CDR-033 §4) but is COUNTED. HELD is its own bucket — a task waiting on the
  owner is stalled, not progressing. `recurring`/`rejected` declare `not_in_this_version` rather than looking empty.
  Dependencies are indexed BOTH ways (a stuck task's cost is what waits behind it) from ONE company-wide query, and a
  prerequisite outside the page BLOCKS — fail closed.
  Commits: CDR `0d3ecf0` → window-reset note `39a779b` → contracts `504c439` → core `a278d54` → docs `fd541fb` →
  review-pass-1 fixes `1faaefc` → review-pass-2 fixes `aecad4d`.
  **Both review passes returned FAIL**, and four of the ten most serious findings were defects in my own review fixes.
  Pass 1's HIGH-2 was product-breaking: the page limit was applied to an unfiltered newest-first query, so a planning
  run's drafts would have rendered every bucket EMPTY while planned work existed. Pass 2's HIGH was a regression
  introduced by pass 1's own fix: filtering draft/unresolvable prerequisites before the blocked derivation turned
  fail-CLOSED into fail-OPEN, reporting work as ready while its input did not exist. See
  `docs/implementation/P4-004-REVIEW-COVERAGE.md`.
  **TASK-001 is NOT fully satisfied by this ticket** — `recurring` and `rejected` remain unreachable pending
  PLAN-003/TASK-003 (Post-MVP) and P4-005. The ticket delivers the VIEWS it was scoped to.
  Exact-head CI green zero-skip **1894/1894** at `aecad4d`.
  Next: squash-merge → exact-main CI zero-skip → delete branch.
- **ACBP-P4-006 planning transparency — DONE** (squash `b8dc466`, PR #41; exact-main CI green zero-skip 1846/1846; branch deleted). Phase 4 4/7.
- **ACBP-P4-006 planning transparency — CORE DONE / IN REVIEW (5th autonomous window).**
  Branch `p4-006-planning-transparency` (from main `6274cd3`, after P4-003 merged), draft PR **#41**, CDR-041.
  PLAN-004: every planning run links its input snapshot and a per-task rationale. Migration **0028** adds
  `planning_runs` + `planning_run_inputs` (company-owned, dual-keyed FORCE RLS, SELECT+INSERT only — a run is a
  historical record) and `tasks.rationale` (nullable, INSERT-ONLY, the `(state, updated_at)` grant untouched).
  **The load-bearing reading (CDR-041 §2):** P4-003's `generateTasks` built its prompt from roadmap milestones alone
  and never called `assembleContext`, so planning considered NO memory. Snapshotting that would satisfy PLAN-004's
  letter while its honest answer stayed "the roadmap, and nothing the founder ever told us". PLAN-004 depends on
  MEM-003 and AI-AND-WORKER §1 puts context assembly first in every generation path, so this ticket WIRES ASSEMBLY IN
  rather than recording a knowingly incomplete input set. It changes what planning READS only — every P4-003 guarantee
  (STRAT-005 boundary, PLAN-001 minimum, partial honesty, no phantom tasks, drafts unaudited) holds unchanged.
  The run + its links + ONE new audit event (`planning.run_recorded`, scalars only) are written in the SAME
  transaction as the drafts (ADR-015). The run is recorded even when generation FAILED (§3-G3) — a run row is not a
  task, so "no phantom tasks" is untouched. Steering's clarification/refusal stay DISTINCT outcomes from failed.
  `assembleContext` gained an ADDITIVE `itemIds`/`withheldItemIds` return (§3-G8); P2-007 behaviour is unchanged.
  Commits: CDR `b85fcdb` → contracts `9a59443` → migration 0028 `2c23458` → assembly `47fe3b5` → wiring `f120550`
  → docs `7d6dc03` → CI fix `98784c5` → review-pass-1 fixes.
  Hosted CI green zero-skip twice already: **1828/1828** at `2c23458` (migration in isolation) and **1839/1839** at
  `98784c5` (the whole wiring).
  Review pass 1: **FAIL** — 2 High, 6 Medium, 3 Low, all applied. Both Highs were consequences of wiring assembly in:
  an UNBOUNDED memory prompt (the roadmap half was capped, the memory half was not — and a truncating provider would
  have left the run linking items the model never read), and untrusted-origin memory arriving as `system` messages
  AHEAD of the instruction saying it is not instructions. See `docs/implementation/P4-006-REVIEW-COVERAGE.md`.
  **The `BACKLOG.csv` row already reads `Done`** — written in this ticket's finalization commit as in every prior
  ticket, and NOT the completion claim: done means exact-head CI zero-skip → squash-merge → exact-main CI zero-skip →
  branch deleted. Until then this line, not the CSV, is the true state.
  Next: review pass 2 against the fixed tree → exact-head CI zero-skip → squash-merge → exact-main CI zero-skip → delete.
  Migrations end **0028**.
- **ACBP-P4-003 task generation + chat steering — DONE** (squash `6274cd3`, PR #40; exact-main CI green zero-skip 1802/1802; branch deleted). Phase 4 3/7.
- **ACBP-P4-003 task generation + chat steering — CORE DONE / IN REVIEW (4th autonomous window).**
  Branch `p4-003-task-generation` (from main `00a580d`, after P4-001 merged), draft PR **#40**, CDR-040.
  `generateTasks` (PLAN-001: 3+ prioritized, typed, milestone-traced tasks or an honest partial) and
  `steerTaskPlanning` (PLAN-002: THREE distinct successful answers — tasks + interpreted intent, a clarifying
  question, or an honest refusal; none reported as a failure). **The preview is the `draft` state**, canon-native per
  diagrams/06 + WORKFLOW §4 + CDR-033 §4 (not on the board, no audit); confirming is the existing `planTask`
  transition, so NO new audit event. **STRAT-005 is enforced here** — the boundary CDR-037 §5 recorded as a flag and
  deferred to this ticket: only the approved phase's milestones are shown to the model, and every ordinal is
  re-resolved server-side at persist so an out-of-scope task is refused, never re-pointed. Gate reuses
  `classifyPlanningGate` + requires a current roadmap; both re-verified in the persist tx (`stale_decision` /
  `stale_roadmap`). Migration **0027** is ALTER-only: `tasks.task_type` (closed CHECK, nullable) + `tasks.priority`
  (integer RANK, no invented scale) — both INSERT-ONLY, the `(state, updated_at)` grant untouched.
  Commits: contracts `7fe3c4b` → migration 0027 `65e83be` → both core use cases `8ebbb64` → review fixes.
  Independent review: **PASS** — 0 Blocker/Critical/High, 4 Medium, 10 Low; every Medium and every actionable Low
  applied (see `docs/implementation/P4-003-REVIEW-COVERAGE.md`).
  Local: full unit suite passing; planning real-PG discovered but **skipped, not green** (local PG down) — hosted CI is
  the evidence; recursive typecheck/lint/secrets/boundaries clean; 0 mojibake.
  **The `BACKLOG.csv` row already reads `Done`** — that flip is written in this ticket's finalization commit, matching
  every prior ticket, and is NOT the completion claim: the ticket is done only after exact-head CI green zero-skip →
  squash-merge → exact-main CI green zero-skip → branch deleted. Until then this line, not the CSV, is the true state.
  Next: exact-head CI zero-skip → squash-merge → exact-main CI zero-skip → delete branch.
  Migrations end **0027**.
- **ACBP-P4-001 goals, roadmap and milestones — DONE** (squash `00a580d`, PR #39; exact-main CI green zero-skip 1755/1755; branch deleted). Phase 4 2/7.
- **ACBP-P4-001 goals, roadmap and milestones — CORE DONE / IN REVIEW (3rd 8-hour autonomous window).**
  Branch `p4-001-goals-roadmap-milestones` (from main `766b674`, after P3-005 merged), draft PR **#39**, CDR-039.
  Turns the DECIDED strategy into a plan (ROAD-001) that is versioned and editable (ROAD-002). The planning GATE is the
  company's LATEST decision being NON-reject (`decisions.mode <> 'reject'`; CDR-039 §7-G1) — STRAT-006 records
  rejections too, so "a decision exists" would have unlocked planning off a rejection; re-verified inside the persist
  tx → `stale_decision`. Migration **0026**: `roadmaps` (versioned append-only, UNIQUE(company_id, version), supersedes
  chain, edit_reason shape CHECK), `goals` + `milestones` (immutable, ordinal-sequenced, composite same-version goal
  FK), `task_review_flags`; plus the additive `tasks.milestone_id → milestones` FK that closes the P4-002 review NOTE
  and makes ROAD-001's "tasks trace to milestones" enforceable. `generateRoadmap` (metered by the gateway; partial
  honesty — failure/malformed/empty persists NOTHING, only a model-flagged output is `partial`) and `editRoadmap`
  (OWNER-ONLY, version-guarded, new version + affected-OPEN-task flags + `roadmap.edited` in ONE tx, so a failure
  cannot lose history). NO task generation (P4-003 owns PLAN-001), no dates (ADR-019). Ratified: CDR-039 §7 G1–G8.
  Commits: contracts `0cf8a15` → migration 0026 `b517dee` → ROAD-001 core `593051a` → ROAD-002 core `7c2cbad`.
  Local: full unit 1036 passed / 0 failed; planning real-PG 11 + roadmap-generation 12 + roadmap-edit 7 discovered
  (local PG down → skipped; hosted CI is the evidence); recursive typecheck/lint/secrets/boundaries clean; 0 mojibake.
  Independent review next, then exact-head CI zero-skip → squash-merge → exact-main CI zero-skip → delete branch.
  Migrations end **0026**.
- **ACBP-P3-005 immutable decision records — DONE** (squash `766b674`, PR #38; exact-main CI green zero-skip 1695/1695; branch deleted). Phase 3 5/7.
- **ACBP-P3-005 immutable decision records — CORE DONE / IN REVIEW (3rd 8-hour autonomous window).**
  Branch `p3-005-decision-records` (from main `50bbaa8`, after P3-004 merged), draft PR **#38**, CDR-038.
  The STRAT-006 audit-grade record: links the CONFIRMED understanding version, the options CONSIDERED (via the
  generation), the SELECTION it hardens (P3-004), and an OPTIONAL bounded owner-supplied rationale. `recordDecision` is
  OWNER-ONLY (`decision:record`) and writes ONE immutable `decisions` row + `decision.recorded` in ONE transaction —
  that audit-or-nothing pair IS the STRAT-006 failure mode ("failed record writes block the transition; a decision is
  not silently unrecorded"). Migration **0025** `decisions` (immutable/append-only, dual-keyed FORCE RLS, SELECT+INSERT,
  composite FK (selection_id, generation_id) so a cross-generation decision is impossible, optional bounded rationale
  CHECK) + an additive `UNIQUE(id, generation_id)` on `strategy_selections`. `getLatestStrategyGeneration` surfaces the
  latest decision. Records only — NO planning unlock (P4-001 gates on the decision separately). Ratified (CDR-038 §6):
  G1 a REJECT selection also gets a record (STRAT-006 says "selection/edit/rejection" explicitly; planning-unlock keys
  off a non-reject decision); G2 rationale optional; G3 references (not re-captures) the selection; G4 options-considered
  = the generation link + a scalar audit count; G5 append-only latest-wins. Commits: CDR+contracts `4896de0` →
  migration 0025 `bb65087` → core `e1c4a6d`. Local: full unit 1018 passed / 0 failed; decisions real-PG 9 + decision-record
  real-PG 9 discovered (local PG down → skipped; hosted CI is the evidence); recursive typecheck/lint/secrets/boundaries
  clean. Independent review next, then exact-head CI zero-skip → squash-merge → exact-main CI → delete branch.
  Migrations end **0025**.
- **ACBP-P3-004 selection / edit / combine / phase-limited approval — DONE** (squash `50bbaa8`, PR #36; exact-main CI green zero-skip 1665/1665; branch deleted). Phase 3 4/7.
- **ACBP-P3-004 selection / edit / combine / phase-limited approval — CORE DONE / FINALIZING (3rd 8-hour autonomous window).**
  Branch `p3-004-selection-and-approval` (from main `c645e8e`, after the `.gitattributes` chore), draft PR **#36**, CDR-037.
  Records the OWNER's decision over a generation in a closed `mode` {select, edit, combine, reject} + FLAGGING-only
  `phase_scope` {first_phase, whole_plan} (STRAT-003/005). `validateStrategyDecision` is deny-by-default per-mode (select →
  in-range ordinal; edit/combine → an owner-supplied 16-field object reusing `isCompleteOptionFields`, NO model call;
  reject → non-blank bounded reasons). `recordStrategyDecision` (OWNER-ONLY `strategy:select`) persists ONE immutable
  selection + the `strategy.selected` audit (metadata {mode} + phase_scope when set — never content) in ONE tx
  (audit-or-nothing); `getLatestStrategyGeneration` surfaces the latest selection. Records a SELECTION only — NO decision
  record (P3-005), NO planning unlock (the P4 boundary; phase-limited approval is an owner-accepted Phase-3 deferral).
  Migration **0024** `strategy_selections` (immutable/append-only, dual-keyed FORCE RLS, SELECT+INSERT; composite FK
  same-generation; mode/phase_scope/shape CHECKs) + every reset list/catalog surface. Ratified (CDR-037 §6): G1
  selection-only; G2 phase_scope value set; G3 edit/combine owner-supplied; G4 reject single reasons field. Commits:
  contracts `c4d57c7` → migration+repo `806606b` → core `5ec73b5`. Local: contracts strategy unit + core strategy/audit
  33 unit; strategy-selection real-PG 11 + strategy_selections migration 10 discovered (local PG down → skipped, hosted CI
  is the evidence); full recursive typecheck/lint/secrets/boundaries clean. Independent review next.
  Finalization → backlog Done → exact-head CI zero-skip → squash-merge "ACBP-P3-004: Selection, edit, combine,
  phase-limited approval" → exact-main CI zero-skip → delete branch. Migrations end **0024**.
- **ACBP-P3-003 comparison + AI recommendation — DONE** (squash `55438de`, PR #35; exact-main CI green zero-skip; branch deleted). Phase 3 3/7.
- **ACBP-P3-003 comparison + AI recommendation — CORE DONE / FINALIZING (2nd 8-hour autonomous window).**
  Branch `p3-003-comparison-recommendation` (from main `a8ace01`, after P3-002 merged), draft PR **#35**, CDR-036.
  Adds the OPTIONAL ADVISORY recommendation over a generation's distinct options (STRAT-004). Canon-derived design (via
  discovery subagent): a MODEL call (FakeModelProvider; live deferred CDR-026 §0) recommends ONE option with rationale +
  sensitivities, or honestly abstains. Two guards: NEVER auto-selects (structural — no selection/decision/state change;
  selection is P3-004) + no defensible rationale → no recommendation (deny-by-default: one option-in-range + non-blank
  rationale + sensitivities, else abstain → nothing persisted, `recommendation: null`). `recommendStrategy` +
  `getLatestStrategyGeneration` surfaces the latest recommendation. Migration **0023** `strategy_recommendations`
  (immutable/append-only, dual-keyed FORCE RLS, SELECT+INSERT, FK generation+option). `strategy:recommend` authz
  (owner|viewer). NO new audit event (changes no state; only the gateway usage event). Ratified gaps: G-1 structural
  "defensible" bar; G-2 model-metered; G-3 owner|viewer. Commits: CDR+contracts `35b7663` → migration 0023 `eb4274f` →
  core `2875eb2`. Local: contracts strategy 25 unit; recommendation real-PG 7/7 + migration 6/6; strategy-generation
  real-PG 12/12; full recursive typecheck/lint/secrets/boundaries clean; unit 1004. Independent review in progress.
  Finalization → backlog Done → exact-head CI → squash-merge "ACBP-P3-003: Comparison and AI recommendation" →
  exact-main CI → delete branch. Migrations end **0023**.
- **ACBP-P3-002 distinctness check — DONE** (squash `a8ace01`, PR #34; exact-main CI green zero-skip; branch deleted).
  Phase 3 2/7.
- **ACBP-P3-002 distinctness check — CORE DONE / FINALIZING (2nd 8-hour autonomous window).**
  Branch `p3-002-distinctness-check` (from main `450c768`, after P3-001 merged), draft PR **#34**, CDR-035. Adds the
  STRAT-001 similarity check P3-001 deferred (it wrote `similarity_check_result = 'pending'`). Canon is explicit
  (searched thoroughly — no product-semantics gap): two options are genuinely distinct IFF they differ on ≥1 of
  {customer, offer, business_model} (PRD J-07 + REQUIREMENTS STRAT-001); the check rejects near-duplicates ("same plan,
  different title"); fewer than 3 distinct → stated honestly with reasons. Deterministic, model-free (AI-AND-WORKER §1);
  no metering, no owner gate. Contract `dedupeByDistinctness` (normalized 3-axis key, NUL-separated to avoid boundary
  collisions; keeps the first representative per group; `distinct`/`insufficient_distinct`). Wired into
  `generateStrategyOptions`: persists ONLY the distinct set (near-duplicates rejected, not stored), records the real
  verdict (never `pending` again), derives status from the distinct count, and writes an honest fewer-reason on
  collapse. NO schema/migration change (the existing `similarity_check_result` column + P3-001 status↔option_count CHECK
  hold since option_count = distinct count); no new audit/authz. Commits: CDR+contracts `f563d14` → core `cba98cc` →
  NUL-escape source cleanup `faf4c91`. Local: contracts distinctness 8/8 + strategy 19 unit; core strategy real-PG
  11/11 (incl. near-duplicate rejection adversarial); full recursive typecheck/lint/secrets/boundaries clean; unit 995.
  Independent review in progress. Finalization → backlog Done → exact-head CI → squash-merge "ACBP-P3-002: Distinctness
  check" → exact-main CI → delete branch. Migrations stay **0022**.
- **ACBP-P3-001 strategy option generation — DONE** (squash `450c768`, PR #33; exact-main CI green zero-skip; branch
  deleted). Phase 3 1/7.
- **ACBP-P3-001 strategy option generation — CORE DONE / FINALIZING (8-hour autonomous window).**
  Branch `p3-001-strategy-option-generation` (from main `08e7d6a`, after P4-002 merged), draft PR **#33**, CDR-034.
  Generates strategy options from the CONFIRMED understanding version (STRAT-001/002). Corrects an earlier mistaken
  deferral: the 16-field option standard IS canon (PRD §11.3 line 302, locked by the backlog's "All 16 fields"
  acceptance) — verified directly, so P3-001 is unblocked (no owner gate; deterministic FakeModelProvider, live provider
  deferred CDR-026 §0). Implements only the `gen` node: `generateStrategyOptions` (gated on owner-confirmed understanding
  — blocked pre-confirm; gateway → validate 16-field/ADR-019 no-fake-precision `"unknown"` labeling → honest
  fewer-than-three → persist ONE immutable generation + options + `strategy.generated` audit in one tx, audit-or-nothing;
  metered) + `getLatestStrategyGeneration` read. The rigorous cosmetic-variant distinctness engine is P3-002
  (`similarity_check_result` = `pending`); comparison/selection/decision are P3-003/004/005. Migration **0022**
  (`strategy_generations` + `strategy_options` — immutable `I`, dual-keyed FORCE RLS, SELECT+INSERT). Authz
  `strategy:generate`/`:read` (owner|viewer). No new SECURITY DEFINER / role / BYPASSRLS. Commits: CDR+contracts
  `f85263d` → migration 0022 `932c399` → core `2c9c22d`. Local real-PG green (zero skips): strategy migration 6, core
  use cases 8, catalog + database existence re-verified; full recursive typecheck+lint+secrets+boundaries clean; full
  unit 988. Independent security/scope review in progress. Finalization → backlog Done → exact-head CI → squash-merge
  "ACBP-P3-001: Strategy option generation" → exact-main CI → delete branch. Migrations end **0022**.
- **ACBP-P4-002 task model + state machine — DONE** (squash `08e7d6a`, PR #32; exact-main CI green zero-skip; branch
  deleted). Established the server-enforced task state machine + tasks/task_dependencies (migration 0021). Phase 4 1/7.
- **ACBP-P4-002 task model + state machine — CORE DONE / FINALIZING (8-hour autonomous window).**
  Branch `p4-002-task-state-machine` (from main `68f99e4`), draft PR **#32**, CDR-033. Establishes the Task entity + the
  SERVER-ENFORCED state machine (TASK-001; ADR-008; WORKFLOW §4): the full closed 11-state set + legal-transition map are
  defined day-one (every illegal transition rejected + 100% table conformance test), but only the effect-free
  pre-execution transitions are EXECUTED — `createTask` (mints `draft`, no audit), `planTask` (server-enforced
  `draft→planned`, `task.created` audited in-tx, audit-or-nothing; illegal transitions rejected with no audit),
  `addTaskDependency` (immutable same-company edge; self/duplicate/unknown refused), `getTask`/`listTasks` (redacted
  reads). Execution transitions (credit reservation on planned→queued, worker runs, holds, terminals) are DEFINED-legal
  but their EFFECTS DEFERRED to P5/P6 — the `interview.ts` precedent. Migration **0021** (`tasks` mutable-with-audit
  `M`: SELECT+INSERT + column-scoped UPDATE(state,updated_at); `task_dependencies` append-only `I`, UNIQUE + no-self-dep;
  both dual-keyed FORCE RLS). Authz `task:create`/`task:read` (owner|viewer). No new SECURITY DEFINER / role / BYPASSRLS.
  Commits: CDR+contracts+authz+audit `780ce94` → migration 0021 `9916ffd` → core `eeddf65`. Local real-PG green (zero
  skips): tasks migration 7, core use cases 10, catalog + database existence re-verified; full recursive typecheck +
  lint + secrets + boundaries clean. Independent security/scope review in progress. Finalization → backlog Done →
  exact-head CI → squash-merge "ACBP-P4-002: Task model and state machine" → exact-main CI → delete branch. Migrations
  end **0021**.
- **ACBP-P2-007 context assembly — CORE DONE / FINALIZING (autonomous window; trust-critical).**
  Branch `p2-007-context-assembly` (from main `a6dff28`), draft PR **#31**, CDR-032. Owner ratified the MEM-004 conflict
  semantics (genuine contradiction → open question, never silent rank-resolve; reuse P2-005). Core `assembleContext`
  (commit `381c2bd`): read current memory (`memory:read`) → provenance-rank → detect MEM-004 conflicts (confirmed-user +
  ai_assumption on same `source_ref`, deterministic/model-free) → WITHHOLD both + audit `context.conflict_flagged`
  in-tx → redact secrets → return `contextParts` + conflicts. NO model call; no migration; no new authz. Real-PG
  integration 6/6; full unit 958; all gates clean. P2-005 gap documented (model-based/answer-time; semantic detection
  deferred). Backlog **Done**. Independent core review **PASS** (no Blocker/Crit/High; last-gate-before-model bar met;
  L1 fail-closed enum guard fixed; L2 informational) — P2-007-REVIEW-COVERAGE.md. Finalization records next → exact-head
  CI → squash-merge "ACBP-P2-007: Context assembly" → exact-main CI → delete branch → Phase 2 11/12. The last non-gated Phase-2 ticket
  (P2-011 is OWNER-GATED on the live-model eval). **Deliberately sliced (trust-critical):** this window shipped only
  the PURE, security-critical logic — `rankMemoryForContext`/`provenanceTier` (confirmed user > accepted assumptions >
  research; invalidated excluded; MEM-004 ordering) + the `SECRET_PATTERNS`/`redactSecrets`/`containsSecret` blocklist
  (fail-closed, defense-in-depth; a seeded secret never reaches the prompt — invariant 12/NFR-018). Commit `8b01212`;
  20 unit tests (11 synthetic secret shapes redacted + benign-text no-false-positives + ranking order); synthetic
  fixtures allowlisted for the secret scanner (reviewed FPs, no real creds); recursive typecheck/lint/secrets/encoding/
  boundaries all clean. **NOT finalized** — the follow-up **core slice** (next window) owns: `assembleContext` (scoped
  memory read + MEM-004 conflict DETECTION→question emission — under-specified, designed with care in core), real-PG
  integration (seeded-secret-blocked E2E, seeded-conflict-surfaces-question, cross-company isolation), an independent
  **security review** (trust-critical), and finalization. No migration, no new authz (reuses `memory:read`), no live
  provider. CDR-032 §4 has the slice plan. PR #10 untouched.
- **ACBP-P2-012 Slice B integration: confirmed understanding — DONE (merged squash `a6dff28`, PR #30; exact-main CI green 136/136 zero-skip).**
  Independent 8-dimension adversarial review **CLEAN** (no Blocker/Critical/High; 6 Low — 4 fixed:
  step-3 falsifiability, step-12 seed-audit decoupling, demo truncation guard, CDR wording; 2 accepted with rationale —
  P2-012-REVIEW-COVERAGE.md). Finalization records committed; sequence = exact-head CI (zero-skip) → PR #30 ready →
  verify MERGEABLE + recheck main/PR#10 → squash-merge "ACBP-P2-012: Slice B integration: confirmed understanding"
  (no Co-Authored-By) → exact-main CI → FF main → delete branch. Branch `p2-012-slice-b` (from main `875a00c`), PR **#30**, CDR-031. (P2-009 merged `40548cf`; brace-expansion CI
  hotfix merged `875a00c`; Phase 2 was 9/12.) Selected via canon discovery over P2-007/P2-011 — P2-012 is the M2/M3
  milestone-exit E2E on the critical spine, deps P2-009 + P2-010 both Done, fully buildable on the deterministic
  FakeModelProvider, NO owner gate. The founder-discovery vertical slice (interview → adaptive follow-ups →
  classification → understanding → edit → confirm → correction → fallback-flag negative), composing the merged
  P2-001/002/005/006/008/009 use cases. `runSliceBJourney` (@acbp/test-support) implemented ONCE, shared by the CI
  suite + `pnpm demo:slice-b` (no drift; the Slice A/CDR-021 precedent); the core use cases + gateway factory are
  INJECTED (test-support must not import @acbp/core — workspace cycle). No migration, no new authz/audit, no live
  provider. Commit `51cb256` pushed; CI `30134235216` in flight. Local: E2E 1/1, demo 13/13, unit 927, boundaries (no
  cycle)+typecheck+lint+secrets+encoding+boundary-tests clean. Remaining: docs + review + finalization. PR #10 untouched.
- **ACBP-P2-009 understanding review + confirmation — DONE (merged squash `40548cf`, PR #28).**
  Backlog **Done**. Independent 10-dimension adversarial review **CLEAN** (no Blocker/Critical/High; 4 Low/Medium fixed
  — D1 confirmed metadata `{version}` docs; D2 repo chronological ordering; P1 CDR confirm-precondition wording; P2
  correction_ref wording; P2-009-REVIEW-COVERAGE.md). Finalization head `1fcc8fc` pushed; finalization-records commit
  next; sequence = exact-head CI (zero-skip) → PR #28 ready → verify MERGEABLE + recheck main/PR#10 → squash-merge
  "ACBP-P2-009: Understanding review and confirmation" (no Co-Authored-By) → exact-main CI → FF main → delete branch.
  Branch `p2-009-understanding-review` (from main `9e11466`), PR **#28**, CDR-030. (P2-008 merged `9e11466`;
  Phase 2 was 8/12.) Selected via canon discovery over P2-007/P2-011 (P2-009 is the M2/M3 critical spine → P2-012 +
  P3-001; no owner gate — Usage "—" so no live model, additive migration in the existing pattern). Implements the
  owner review + confirmation gate over an understanding VERSION (not the session — P2-008 decoupled it; session-state
  sync deferred to P2-012): the five per-item controls (`understanding:review`), the owner-only confirm that unlocks
  strategy (`understanding:confirm`), and the DISC-008 correction that supersedes a confirmation + flags dependents.
  Migration 0020 (`understanding_item_reviews` + `understanding_confirmation_events`, additive dual-keyed FORCE-RLS
  append-only; UNIQUE(document_id,kind) idempotency; both in every reset list + the P1-014 catalog — no new SECURITY
  DEFINER/role). Three audit events (`understanding.item_reviewed`/`.confirmed`/`.corrected`, in-tx). Core
  `recordUnderstandingReview`/`confirmUnderstanding`/`correctUnderstanding`/`isCurrentUnderstandingConfirmed` gate.
  Commits: CDR-030 → contracts `7455e66` → migration 0020 `594b044` → core `3c349f1`. Local real-PG all green (zero
  skips): 0020+0019 migration 14, catalog 48, database 10, core review 8, audit 12; full unit 927; gate clean. HEAD
  `3c349f1` pushed; CI `30128716043` in flight. Remaining: docs + reviews + finalization. Evidence/research requests
  are recorded (not executed — Research worker P5); HTTP routes + live provider deferred (CDR-026 §0). PR #10 untouched.
- **ACBP-P2-008 understanding generation — FINALIZING (autonomous window; finalization pre-authorized).** Branch
  `p2-008-understanding-generation` (from main `c916d81`), PR **#27**, CDR-029. (P2-005 merged `c916d81`; Phase 2
  was 7/12.) Selected via canon discovery over P2-007/P2-011 (P2-008 is the M2/M3 critical spine → P2-009 → P2-012
  → P3-001; P2-011 hits the live-model eval gate; P2-007 lower-leverage). Generates a classified, versioned
  business-understanding document from confirmed memory (diagram 04 `gen`; UNDER-001/005): closed 6-class taxonomy
  (fact/preference/constraint/assumption/research_finding/open_question), `parseUnderstanding` deny-by-default,
  per-section confidence + present/assumed/unknown status (0.5 threshold), overall = weakest covered section;
  migration 0019 (`understanding_documents` + `understanding_items`, additive dual-keyed FORCE-RLS append-only
  versioned; both in every reset list + the P1-014 catalog); `understanding.generated` audit; `understanding.generate`
  template; `understanding:generate`/`understanding:read` authz. Core `generateUnderstanding` composes the scoped
  primitives + the P2-003 gateway (model call BETWEEN scopes) → persist version+items+audit in one tx
  (audit-or-nothing); **failure/malformed persists NOTHING**; model-flagged partial → status partial; race-safe
  versioning (ON CONFLICT + bounded retry). Uses the FAKE provider; **live generation + HTTP routes are the deferred
  owner gate CDR-026 §0** (engine proven by the scripted integration suite, CDR-029 §8). Built TDD; unit 906/0;
  real-PG integration 15/15 (0 skips): 0019 catalog/lifecycle 6 + generation 9 (complete/partial/6-classes/
  malformed→nothing/gateway-failure→nothing/audit-rollback/non-member-forbidden/version-sequencing+immutability/
  concurrency). Independent 10-dimension review **CLEAN** (no Crit/High/Med); 3 LOW fixed (race-safe versioning +
  concurrency test; CDR §1/§3 wording) — P2-008-REVIEW-COVERAGE.md. Web build not required (no route). CI green on
  `448b83d` (run 30125418699); review-fix head `85808e7`. **Finalization:** records commit → exact-head CI → PR #27
  ready → squash-merge "ACBP-P2-008: Understanding generation" (no Co-Authored-By) → exact-main CI → delete branch →
  next Ready ticket. Phase 2 after merge: **8/12 Done**; P2-009 (understanding review, deps P2-008) + P2-007 become
  candidates (P2-011/P3-006/P7-012 gated on the live-model eval; P2-012 needs P2-009+P2-010).
- **ACBP-P2-005 adaptive question orchestration — FINALIZING (autonomous window; finalization pre-authorized).**
  Branch `p2-005-adaptive-orchestration` (from main `68a022b`), PR **#26**, CDR-028. Selected via canon discovery
  over P2-005 vs P2-007 (both Ready/unblocked; P2-005 is on the M2/M3 critical path, P2-007 only feeds a Phase-5
  worker). Delivers the adaptive interview ENGINE (diagram 04: batch→ask→answer/IDK/pause→vague/contradiction
  check→store→loop): contracts (parseFollowUps/parseAnswerQuality/parseAssumption deny-by-default + QuestionSource);
  migration 0018 (`interview_questions.rationale` + `.source`, additive immutable); two registry templates
  (interview.answer_quality/assumption); pure DISC rules (≤3 cap, static-fallback flag, fail-open detection,
  assumption→ai_assumption); use cases (generateAdaptiveBatch/evaluateAnswer/suggestAssumptionForSkip) composing
  the scoped primitives + the P2-003 gateway (model call BETWEEN scopes); composition validator. Built TDD; unit +
  **real-PG integration 8/8** (adaptive persist+metering, static fallback, ≤3 rule, clear→user_fact, vague/contra
  no-memory, IDK→ai_assumption, non-member forbidden). Uses the deterministic FAKE provider; **live generation +
  the HTTP orchestration routes are the deferred owner gate CDR-026 §0** — the engine is proven by the scripted
  integration suite (CDR-028 §8). Independent security/scope review **CLEAN** (no Crit/High/Med; 3 LOW retained;
  API-deferral accepted as documented/precedent-consistent — P2-005-REVIEW-COVERAGE.md). Web build + audit green;
  unit 888/0. **Finalization sequence:** records commit → push → exact-head hosted CI (zero-skip) → PR #26 ready →
  squash-merge "ACBP-P2-005: Adaptive question orchestration" (no Co-Authored-By) → exact-main CI → delete branch →
  next Ready ticket. Phase 2 after merge: **7/12 Done**; P2-007 (context assembly) + P2-008 (understanding, deps
  P2-005+P2-006) become the next Ready candidates.
- **ACBP-P2-004 prompt/template registry — DONE (autonomous window).** Branch `p2-004-prompt-template-registry`
  (from main `d95fafb`), PR **#25**. Provider-neutral versioned template registry in `@acbp/contracts`
  (`model/template.ts`): `TemplateDefinition {family, version, taskClass, segments, slots}`, `resolveTemplateRef`
  (deny-unknown), `latestTemplateRef` pinning, `templateProvenance {template_ref, template_version}` (TASK-005),
  `renderTemplateSegments` (own-slot; assembly stays P2-007). CONFIG not tenant data — **no migration, no new
  SECURITY DEFINER (still 3), no tenant surface**. CDR-027. Three read-only reviews (canon/scope · security ·
  tests/docs) CLEAN; all Low/Info findings fixed (neutrality-token list widened + family/slot scan; per-family
  task-class assertions; `isPlatformError` on render-deny; CDR truth-ups). Acceptance "recorded on every derived
  artifact" satisfied at the MECHANISM level — end-to-end stamping tracked to the first artifact-producing ticket.
  Unblocks nothing new by itself; P2-005 still needs the D-10 (existing-business) owner decision reviewed.
- **ACBP-P2-003 model gateway — DONE; squash-merged `d95fafb` (PR #24), exact-main CI 30112328579 green
  zero-skip.** Branch `p2-003-model-gateway` (from main `10b4e2e`) deleted post-merge. Feature head **`52653f2`**; exact-head hosted CI **30109799579
  green, ZERO-SKIP** (CI preflight "fails if integration tests would silently skip" → OK; 121/121 test files;
  real-PG append-only/RLS/CHECK/FK negative assertions all executed). A **second independent review round** ran
  five parallel read-only reviewers (canon/scope · contract · tests · security · docs): security CLEAN, scope
  CLEAN; all actionable findings FIXED (timeout bound to `taskClass`; fail-closed on `outputSchemaRef` with no
  wired validator; retry/re-ask CLAMPED to owner-ratified ceilings; generation-deadline + unwired-validator +
  row-level-canary tests; `@acbp/core` gateway README; doc precision truth-ups) — ledger in
  `docs/implementation/P2-003-REVIEW-COVERAGE.md`. Also fixed a real hosted-CI drop-list collision
  (`usage_events` added to all schema-reset lists + the P1-014 catalog; commit `52653f2`). **IOQ-13 owner-RATIFIED** ("Adopt proposed defaults": interactive
  30s / generation 120s / retries ≤2) → recorded in **CDR-026** + IOQ marked Resolved. Built the provider-neutral
  gateway ABSTRACTION + a deterministic FAKE provider (the only wired adapter): `callModel` (ADR-011 contract,
  per-class timeout, bounded retry ≤2 + re-ask ≤1, fallback eligibility [generation ineligible — no silent
  fallback], seven-value normalized taxonomy, redacted logging, company-policy pre-check) + APPEND-ONLY
  `usage_events` (migration 0017, dual-keyed FORCE RLS, SELECT+INSERT only, integer micro-units) with FAIL-CLOSED
  metering. **The LIVE provider path (real key + `gpt-5.1` snapshot pin [CDR-001 §8] + ADR-019 §13 eval gate) is a
  DEFERRED owner gate — CDR-026 §0 — NOT built.** 5 committed slices' worth (contracts → 0017 → gateway+fake →
  composition → docs). Evidence: full static gate green; unit 850/850; real-PG usage_events 8/8 + composition 5/5
  (0 skips on disposable DB). **NEXT (owner gate): authorize the finalization sequence** — backlog Planned→Done →
  records commit → push + draft PR → exact-head hosted CI green (zero skips) → mark PR ready → squash-merge
  **"ACBP-P2-003: Model gateway v1 with usage recording"** (no Co-Authored-By) → exact-main CI → delete branch →
  next Ready Phase 2 ticket (P2-004/P2-005/P2-007 unblock once P2-003 Done).
- **ACBP-P2-010 finalization.** Status **Done**; feature head `b9441f1` (review fixes), exact-head CI
  **30102561583 green** (local full suite 116 files / 1319 / 0 skipped). The memory browser: list/filter/get +
  owner edit (versioned supersede) + owner **soft delete** — the CDR-025 §0 deletion semantics were an owner
  gate, **owner-RATIFIED** (`deleted_at` + `deleted_by_user_id`; `memory.item_deleted` in-tx; propagation
  deferred to M3/M4). Both independent reviews CLEAN with explicit CORRECT verdicts on delete-concurrency
  determinism, audit atomicity, and grant narrowness; all findings fixed (edit-concurrency FOR-UPDATE lock;
  CDR §7; P2-010-REVIEW-COVERAGE.md). Sequence: finalization records commit → exact-commit CI → PR #23 ready →
  recheck main/PR#10 → squash-merge **"ACBP-P2-010: Memory browser"** (no Co-Authored-By) → exact-main CI →
  delete branch → next Phase 2 ticket.
- Migrations 0001–0016; exactly 3 SECURITY DEFINER (all 0006); `acbp_app` NOBYPASSRLS/non-owner; no owner
  runtime. `memory_items` column-level UPDATE confined to `superseded_by` (0015) + `deleted_at`/`deleted_by_user_id`
  (0016); content/type/source/identity immutable; no hard-delete grant. Lifecycle active/superseded/deleted
  (mutually exclusive, DB-enforced). Deleted items omitted from list/get; the row survives for history/audit.
- **P2-001/P2-002/P2-006/P2-010 — Done.** Phase 2: **4 Done / 8 Planned.** P2-003/P2-005 gated by open question
  IOQ-13.
- **P2-001/P2-002/P2-006 — Done.** Phase 2: 3 Done / 9 Planned. P2-003/P2-005 gated by IOQ-13.

## ACBP-P2-006 detail (Done) — branch `p2-006-typed-memory-items`, PR #22, CDR-024
- Status **Done**; feature head `a5fe97c` (review fixes), exact-head CI
  **30090738122 green** (real-PG memory suites + HTTP adversarial + reverse-fully migration cycle; local full
  suite 115 files / 1286 / 0 skipped). Both independent reviews CLEAN with explicit CORRECT verdicts on the
  migration root-cause fix and the audit atomicity/decision (not an owner gate); all findings fixed
  (P2-006-REVIEW-COVERAGE.md). Sequence: finalization records commit → exact-commit CI → PR #22 ready → recheck
  main/PR#10 → squash-merge **"ACBP-P2-006: Typed memory items with provenance"** (no Co-Authored-By) →
  exact-main CI → delete branch → next Phase 2 ticket.
- Migrations 0001–0014; exactly 3 SECURITY DEFINER (all 0006); `acbp_app` NOBYPASSRLS/non-owner; no owner
  runtime; `memory_items` dual-keyed FORCE RLS (SELECT+INSERT only). `memory.item_created` audited in-tx.
- **Migration-cycle blocker (prior window) — ROOT-CAUSED + FIXED (Class T):** a window-1 bulk drop-list edit had
  inserted `memory_items` into migration `0013`'s down loop → 42P01 on multi-step migrate-down. Fixed
  (`cb43315`): 0013.down reverted to its own tables; the two speculative changes reverted (0014 self-FK restored,
  0014.down standard pattern). Diagnosed on a disposable PostgreSQL (Windows-native 5433, isolated DB,
  command-local env; `.env.local` untouched).
- **P2-001/P2-002/P2-006 — Done.** Phase 2: **3 Done / 9 Planned.** P2-003/P2-005 gated by open question IOQ-13.
- **Design (CDR-024):** `memory_items` (migration 0014) with the **closed 8-type enum** (user_fact,
  user_preference, constraint, ai_assumption, research_finding, approved_decision, measured_outcome,
  correction; type set by source path, untyped rejected), 6-value `source_type` + resolvable `source_ref`
  (encodes the pinned interview-answer `(question_id, revision)`), nullable confidence/superseded_by (populated
  by P2-008/P2-010), confirmation_state default 'proposed'. Dual-keyed FORCE RLS, SELECT+INSERT only
  (append-only for P2-006; supersede is P2-010). Operations create + list; authz `memory:write`/`memory:read`
  (owner|viewer). **Audit REQUIRED** (contrast P2-002): `memory.item_created` written in-transaction (ADR-015),
  metadata `{item_type, source_type}` only — flagged in CDR-024 §4 for owner visibility (new event name;
  implements the canonical "All changes audited"; additive/reversible). Out of scope: context assembly (P2-007),
  understanding/confidence-scoring (P2-008), the browser + edit/delete/supersede (P2-010).
- **Migration-cycle blocker — ROOT-CAUSED + FIXED (window 2).** The 42P01 `relation "public.memory_items" does
  not exist` in the multi-step `migrateDown`/`migrateTo(earlier)` suites was **Class T**: a window-1 bulk
  drop-list edit (adding `memory_items` to test cleanup lists) also matched and edited **migration `0013`'s down
  loop**, so `0013.down` ran `drop policy/revoke … on public.memory_items`. During a down PAST 0013, `0014.down`
  had already dropped `memory_items` (step 0, success), so `0013.down` raised 42P01 at step 1. The single-step
  memory-items test passed because it never reached `0013.down`. Fix: `0013.down` reverted to its own tables
  (`['interview_answers','interview_questions']` — matches main). Also reverted the two window-1 speculative
  changes made for the wrong hypothesis: `0014` self-FK on `superseded_by` **restored** (integrity), and
  `0014.down` restored to the standard policy-drop+revoke+drop-table pattern (matches 0012/0013). Verified on a
  disposable PostgreSQL (Docker daemon unresponsive → used the Windows-native 5433 cluster, isolated
  `acbp_p2006_test` DB, command-local env — `.env.local` untouched): full suite **114 files / 1277 tests / 0
  failed / 0 skipped**, including reverse-fully-and-reapply + the 8 previously-failing suites.
- **Next:** push the fix (exact-head hosted CI green, zero skips), then P2-006 slices 3–5 (core create/list +
  audited-in-tx `memory.item_created`, API, adversarial+docs), reviews, finalize. Branch
  `p2-006-typed-memory-items`, draft PR #22, CDR-024; **main untouched/green** at `1c49c55`.
- **ACBP-P2-002 — Done** (squash `1c49c55`, PR #21). Phase 2: 2 Done / 10 Planned. P2-003/P2-005 gated by open
  question IOQ-13; P2-006 is the sole unblocked ticket.

## ACBP-P2-002 detail (Done) — branch `p2-002-question-answer-persistence`, PR #21, CDR-023
- Status **Done**; feature head `71657ae` (review fixes), exact-head CI
  **30075033944 green** — real-PG Q&A suites (append-only revisions, idempotent no-op, concurrent
  distinct-both-persist + identical-collapse, NOT-NULL author, cross-tenant isolation) + HTTP adversarial all
  passed. Both independent reviews CLEAN with an explicit verdict that the CDR-023 §4 audit-deferral is
  acceptable and NOT an owner gate; all observations fixed (P2-002-REVIEW-COVERAGE.md). Sequence: finalization
  records commit → exact-commit CI → PR #21 ready → recheck main/PR#10 → squash-merge **"ACBP-P2-002: Question
  and answer persistence"** (no Co-Authored-By) → exact-main CI → delete branch → next Phase 2 ticket.
- Migrations 0001–0013; exactly 3 SECURITY DEFINER (all 0006); `acbp_app` NOBYPASSRLS/non-owner; no owner
  runtime; `interview_questions` (immutable) + `interview_answers` (append-only, NOT-NULL author) dual-keyed
  FORCE RLS. **Persistence-only** — no audit/domain event (deferred; CDR-023 §4).
- **ACBP-P2-001 — Done** (squash `6cf537e`, PR #20). Phase 2: 2 Done / 10 Planned. Next candidates: P2-005
  (adaptive orchestration; deps P2-003+P2-002 — P2-003 gated by IOQ-13, so P2-005 is blocked); **P2-006** typed
  memory (deps P1-005 Done — UNBLOCKED); P2-003 gateway gated by IOQ-13.
- **PR #10** still OPEN/draft/external — inspect GitHub state only; never touch.

## ACBP-P2-001 detail (Done) — branch `p2-001-interview-session-state-machine`, PR #20, CDR-022
- **Design (CDR-022):** the durable, company-scoped interview **session envelope** + server-enforced state
  machine (§2 six states) + exact resume + `interview.started` (audit-only; activity projection DEFERRED so
  P1-009's closed taxonomy isn't expanded in a persistence slice) + illegal-transition rejection. P2-001
  implements start/suspend/resume + read; the ready_for_review/confirmed/superseded transitions are defined in
  the contract but their effects belong to later M2/M3 tickets. Migration 0012 `interview_sessions`
  (dual-keyed FORCE RLS, column-immutable identity, one-open-session-per-company partial unique index). Authz
  `interview:read`/`interview:participate` (owner|viewer). Four slices (contracts → migration → core → API).
- **Selected over** P2-006 (unblocked but downstream/parallelizable) and P2-003 (gated by open question
  IOQ-13). P2-001 is the root of the M2 dependency tree.
- **P0-005 remains Blocked** — a known blocked dependency; stop only if a Phase 2 ticket becomes blocked on it.
- **PR #10** (`p1-004-last-owner-race-fix`) still OPEN/draft/external — inspect GitHub state only; never touch.

## Phase 1 completion evidence (2026-07-24)
- **Tickets:** ACBP-P1-001…P1-015 all Done. Squash SHAs for the tickets closed in this session's arc:
  P1-010 `093ec3f` (PR #11), P1-011 (PR #13), P1-012 `c1990ad`… see below, P1-013 `c1990ad`… (PR #15),
  P1-014 **`b559d37`** (PR #16), P1-015 **`85fcb8f`** (PR #17). Final `origin/main` = `85fcb8f`.
- **Migrations:** 0001–0011, ordered and intact. No 0012.
- **SECURITY DEFINER:** exactly three, all in `0006_bootstrap_functions.ts`
  (`acbp_provision_account`, `acbp_resolve_own_membership`, `acbp_accept_invite`).
- **Runtime role:** `acbp_app` created NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOINHERIT;
  BYPASSRLS granted to no one; no `DATABASE_URL` in `apps/web` runtime source (owner connection is
  migration/test-only).
- **Evidence discipline:** hosted CI on the exact SHA is the trust-critical DB evidence; zero-skip PostgreSQL
  preflight enforced; production `next build` is recorded separately and never conflated with hosted CI.
- **Post-completion audit:** backlog P0 20 Done + P0-005 Blocked; P1 15 Done; no abandoned P1 branches (only
  `main` + external PR #10); secret/encoding/boundary checks 0; no temp/scratch/secret artifacts tracked
  (only `.env.example`). One records-only staleness (this file's Active section) fixed on branch
  `records-phase1-complete`.

## ACBP-P1-015 detail (Done, squash `85fcb8f`, PR #17)
- Branch `p1-015-slice-a-secure-company-creation` from `main` @ `b559d37`, **PR #17**. Governed by **CDR-021**.
  - **Design (CDR-021):** the M1 exit criterion made executable — sign in → internal mapping → account →
    company → switch → cross-company access DENIED, with the audit/activity trail verified. The journey is
    implemented ONCE in `@acbp/test-support` (`runSliceAJourney`) and consumed by BOTH the runnable demo
    (`pnpm demo:slice-a`, wired into the CI gate) and the CI suite, so the demo cannot drift from the
    guarantee. Everything below the provider-SDK edge is production code over the restricted `acbp_app`
    connection under FORCE RLS; `DATABASE_URL` is deleted from the runtime's environment and the restricted
    role is then PROVEN positively via `runtimeConnectionRoles`.
  - **Browser-level E2E deferred to staging** (CDR-021 §1): the slice-A flows are API-only by owner decision,
    so there are no screens to drive, and driving Clerk's hosted sign-in would need live provider credentials.
    `TEST-AND-VERIFICATION-STRATEGY.md` amended accordingly. No live authenticated acceptance performed.
  - **Progress:** Slice 1 `2f03a70` (journey + CI suite + demo + CDR-021 + demo doc; exact-head CI 30063164730
    green, 104 files / 1157 / 0-skip, 3m18s). Then the two independent reviews (security; architecture/scope)
    found the DEMO SCRIPT — the backlog row's own acceptance criterion — could not run at all: a Windows
    `pathToFileURL(url.pathname)` drive-letter doubling, and no `@/…` alias resolution outside
    `apps/web/tsconfig.json` + `vitest.config.ts`. Both repaired and the script then EXECUTED end to end
    against real PostgreSQL (10/10 steps, exit 0), and wired into `ci.yml` so the criterion has hosted
    evidence. Also repaired from the reviews: ACC-001 proven NEGATIVELY (mutable verification status +
    unverified-email refusal), PORT-003 given a real A→B→A switch, two unfalsifiable journey steps replaced
    with falsifiable ones (route-stamped `actor_id`; "did this caller leave a trail INSIDE the other
    tenant?"), the runtime-role claim upgraded from precondition to positive proof, the three hand-copied
    runtime-env blocks consolidated into `configureRouteRuntimeEnv`, and the fixture's company names exported
    so leak assertions cannot go vacuous on a rename.

## Closed in this session
- Ticket: **ACBP-P1-014** — Tenant-isolation adversarial suite (status: **Done**). Squash-merged **`b559d37`**
  (PR #16). Implemented under CDR-020. Class M owner gate on `activity_events.event_id` global uniqueness
  RESOLVED as **Option C** (accepted residual: server-generated opaque global identities may remain globally
  unique when no production or plausible application-bug path can supply a foreign value to the constraint;
  caller-influenceable idempotency keys stay tenant-scoped, as already implemented for `audit_events`).
- Ticket: **ACBP-P1-013** — Administrative-access foundation (status: **Done**, owner-authorized 2026-07-24).
  Implemented 2026-07-23 under 21 explicit owner decisions → **CDR-019**.
- Branch: `p1-013-administrative-access-foundation` (from `main` @ `795227b`).
- Base main: `795227bb5265eb71d09e0a220fb3f8917eaa3384` (P1-012 squash PR #14; exact-main CI 30014863811 green,
  87 files / 951 / 0-skip).
- **P1-013 design (CDR-019):** owner-managed `platform_admins` allowlist (users.id-keyed; runtime = self-check
  SELECT only, fresh per request; NO runtime management API; no default/env admin); mandatory bounded VERBATIM
  reason (≥1 non-ws char, ≤512 code points, no NUL, validated before any DB read); single operation
  `admin.tenant_read` (audit-only; target-tenant-scoped; actor_type admin; metadata {reason, scope='company_overview'};
  audit failure blocks response); cross-tenant read via transaction-local target GUCs on `acbp_app` ONLY after
  identity + reason + fresh-admin checks (accountId+companyId both selectors, relationship DB-verified; JIT =
  per-transaction; primitive PRIVATE — no generic runAsTenant export); API-only
  POST /api/admin/accounts/[accountId]/companies/[companyId]/read body {reason} → {companyId,status,creationMode,
  createdAt}; coarse single 403 (no existence oracle); NO impersonation structurally; break-glass + JIT workflow
  DOCUMENTED not built; activity taxonomy unchanged; no 4th SECURITY DEFINER/BYPASSRLS/owner-runtime/third role.
- PR: **#15 draft** "ACBP-P1-013: Administrative-access foundation", base `main`.
- **P1-013 progress:** planning `c48734d` (CDR-019); Slice 1 `15d5adb` (contracts/authz/audit registry; CI
  30017194994 green); Slice 2 `d49e33b` (migration 0011 platform_admins + real-PG suite + runbook; its CI
  30017530296 FAILED on a latent head-pinned migrateDown in the P1-012 backfill suite → repaired `b014e4e`:
  rollback targets pinned BY NAME, also restoring the 0009 reapply proof that had gone vacuous); Slice 3
  `1b28db6`+`a86cf92` (executeAdminCompanyRead one-tx primitive + adminReadCompanyOverview + real-PG trust
  suite + always-run no-impersonation boundary guard; CI 30018642111 green 91f/980/0-skip); Slice 4 `0db555c`
  (admin API route + strict parsing/privacy tests + prod build, route emitted dynamic; CI 30019840829 green
  1018/1018/0-skip). Slice 5 `ae53442`+`966e44d`: malformed-selector UUID-shape guard, full doc set
  (ADMINISTRATIVE-ACCESS.md + BREAK-GLASS-DESIGN.md new; SECURITY-ARCHITECTURE/AUTHORIZATION/TENANCY/
  API-CONTRACTS/EVENT-CATALOG/AUDIT/DATA-ARCHITECTURE updated), three independent reviews over the eight owner
  lenses (no Critical/High; 1 Medium + 6 Lows + 1 info — ALL fixed; ledger in
  `docs/implementation/P1-013-REVIEW-COVERAGE.md`), postcss ≥8.5.12 override (GHSA-6g55-p6wh-862q).
  **Final feature HEAD `966e44d`; exact-head CI 30021770562 green — 93 files / 1038 / 0 failed / 0 skipped.**
  NOTE (documented deviations): no reified AdminCapability value exists — the capability is the verified
  position inside the one transaction (strictly stronger: nothing to cache/serialize/forge); META_MAX_VALUE_LEN
  raised 512→1024 UTF-16 units for astral verbatim reasons (the PUBLIC reason limit stays exactly 512 code
  points); all admin parse failures collapse to one generic 400.
- **P1-012 design (CDR-018, owner-accepted 2026-07-23):** internal-Postgres-only workspace provisioning; six
  canonical ordered steps (profile, mission_draft, research, roadmap, documents, activity); auto-start after the
  creation tx COMMITS; request-driven SEQUENTIAL execution, fresh CompanyScope tx per step; NO worker/queue/
  detached-task/polling/lease/daemon/outbox/owner-connection; durable statuses pending|completed|failed (NO
  committed running); max 3 total attempts/step (exhausted → safe conflict); one MUTABLE row per (company, step)
  in `provisioning_steps` + `company_workspace_areas` registry (mission_draft/research/roadmap/documents INSERTs;
  profile + activity are VERIFICATION steps — no duplicates, no synthetic events); activation = all six completed
  (failed-acknowledged DEFERRED); six audit-only registered events (started/step_started/step_completed/
  step_failed/retry_requested/completed; system actor for execution, user actor for retry_requested); P1-009
  activity taxonomy UNCHANGED; migration 0010 additive (FORCE RLS dual-key; backfill seeds pending checkpoints
  for draft/onboarding companies, runs nothing, transitions nothing); authz `provisioning:read` (owner|viewer) +
  `provisioning:resume` (owner); API-only GET …/provisioning + POST …/provisioning/resume (single resume route,
  no start/retry/acknowledge/cancel, no body/params, no UI/SSE); NO 4th SECURITY DEFINER.
- **P1-011 design (CDR-017, owner-accepted 2026-07-23):** membership-filtered portfolio (active company_memberships
  only; NO account-owner registry visibility); enumeration under AccountScope (company GUC unset) starting from the
  memberships self-branch, joined to companies (account RLS = isolation, not authorization); name enrichment via
  bounded SEQUENTIAL fresh CompanyScope reads (NO account-scoped profile policy); selection URL-only/stateless/
  non-authoritative (nothing persisted anywhere); switching = navigate + fresh runInCompanyScope (no switch action/
  endpoint/durable event); API-only `GET /api/companies` (cursor+limit only; invalid limits REJECTED not clamped;
  keyset created_at DESC, id DESC; default 25/max 100; cursor base64url bound to account+ACTOR); DTO
  {companyId,name,status,role,createdAt}; no filters/metrics; no RLS/persistence migration (index-only allowed ONLY
  on EXPLAIN-proven need); no 4th SECURITY DEFINER.
- **P1-009 design (CDR-016, owner-accepted 2026-07-22):** separate append-only company-scoped `activity_events`
  table (PK = source audit `event_id`; redacted; rebuildable); **synchronous in-transaction projection** of the 4
  company events (`company.created/updated/paused/resumed`) written atomically with the lifecycle mutation + audit
  under the same restricted `acbp_app` CompanyScope; `audit_events` authoritative; **no outbox/async/worker/
  checkpoint/lease/owner-connection/4th SECURITY DEFINER**; `activity:read` = owner|viewer company member; keyset
  pagination (occurred_at DESC, event_id DESC; opaque versioned cursor; default 25/max 100); honest `as_of`;
  **API-only** `GET /api/companies/[companyId]/activity`; no rendered page, no SSE (SSE deferred to P6-008, which
  shipped it as a POLL-BACKED channel on the Decision Room — there is still no outbox).

## Concurrent work — DO NOT TOUCH
- **PR #10** `p1-004-last-owner-race-fix` (separate session, now deleted) is **OPEN/unmerged**, base main. Its
  worktree `.claude/worktrees/p1-004-last-owner-race-fix` is still registered/locked. Leave it and the branch
  untouched. It touches the memberships REVOKE path; the separate `company_memberships` decision means **no
  overlap** with P1-010. If PR #10 merges during P1-010: fetch, fast-forward, rebase, re-run membership/authz/
  audit/RLS tests, record the new base.

## Prior tickets (closed)
- **ACBP-P1-001..P1-008 — DONE & MERGED.** P1-008 squash `8afb8f0` (PR #9). Main CI green on each squash.
- **ACBP-P1-010 — DONE & MERGED** (squash `093ec3f`, PR #11; exact-main CI `29935591570` green, 803/0-skip).
- Residual: delete the inert P1-002 Clerk Development webhook endpoint. Do NOT touch it.

## P1-010 scope (canonical) — CDR-015 (owner-accepted 2026-07-22)
- **Companies** (C-root: `company_id` PK immutable, `account_id`, name, status, creation_mode) + **company_profiles**
  (immutable versioned; new version per edit; COMP-004) + **company_memberships** (SEPARATE table: company_id,
  account_id, member_user_id, role owner|viewer, status; uniqueness `(company_id, member_user_id) WHERE active`).
- **Many companies per account**; company belongs to exactly one account. Company membership is INDEPENDENT of
  account membership (requires an active account membership; account ownership does NOT auto-grant company access;
  creator gets an explicit active company `owner` row).
- **Company context**: `CompanyContext {accountId, companyId, actorId}`; branded `CompanyScope` (type-distinct from
  AccountScope; the reserved P1-005 `TenantContext`/`TenantScope`/`withTenantTransaction` primitive); resolver =
  server-verified userId + requested companyId → active company_membership → mint CompanyScope; companyId is a
  selector never authority.
- **Create under existing AccountScope; NO 4th SECURITY DEFINER function** (account-keyed `companies` INSERT policy;
  one atomic tx: insert company → mint CompanyScope from the authoritative row → set app.current_company → insert
  owner membership → insert profile v1 → write company.created audit → commit-all-or-rollback-all).
- **Company RLS** keyed to app.current_account + app.current_company (both must match; fail-closed); `acbp_app` stays
  NOBYPASSRLS/non-owner. **audit_events gains nullable `company_id`** (additive expand; account events NULL, company
  events set; append-only preserved). Dual-scope audit policy (account: company_id NULL; company: both match).
- **Lifecycle (WORKFLOW §1 subset):** create (3 modes; idea-mode full) / rename+profile-update / status (truthful;
  unknown→"unknown") / pause / resume. Owner-only lifecycle mutations. Pause = "no new job pickup" (invariant-16
  groundwork via a minimal test rig; no real scheduler). Atomic transitions.
- **Durable company events (4, registered + in-tx):** company.created {company_id, creation_mode}, company.updated
  {changed_fields}, company.paused {reason?}, company.resumed {reason?, held_work_count?}.
- **Out of scope:** deactivate/delete (COMP-007 Post-MVP), portfolio/list/switching (P1-011), provisioning execution
  (P1-012), activity feed + outbox (P1-009+), company invitation flow, any scheduler/queue/worker beyond the test rig.

## Slices
1. Planning + contracts + CDR: **this commit** = CDR-015 + P1-009 dep correction + agent records. Then Slice 1 code:
   company contracts (@acbp/contracts): lifecycle/status/creation-mode types, company authz actions, typed audit
   event factories (company.created/updated/paused/resumed) + registry entries; exhaustive unit tests.
2. Schema + RLS: additive migrations (companies, company_profiles versioned, company_memberships, audit_events
   company_id) + grants/policies/indexes + real-PG migration/RLS/catalog tests (0001-0007 unchanged; no 4th fn).
3. Context + creation: company resolver + CompanyScope mint + same-tx company bootstrap (owner membership + profile
   v1 + company.created audit); 3 creation modes; failure/rollback tests.
4. Lifecycle: read/status, rename/profile-version, pause/resume, owner-only authz, audit atomicity, concurrency/
   idempotency, pause-pickup test rig.
5. API boundary (when canonical): authenticated routes, strict parsing, safe errors, forged-scope negatives; next build.
6. Adversarial hardening + docs + independent reviews.

## Guards (every slice)
- `check:static` (typecheck, lint, secrets 0, encoding 0 BOM, boundaries 0, boundary tests) + full `vitest` incl.
  real-PostgreSQL integration on hosted CI (zero-skip preflight) + `pnpm audit --audit-level high`. `next build`
  only if web runtime changes. Cross-tenant isolation + own-membership-only resolution are trust-critical.

## Blockers / owner decisions
- **RESOLVED:** company data-model/tenancy/bootstrap → CDR-015 (owner-accepted 2026-07-22).
- Future owner gates (do NOT self-authorize): P1-010 backlog→Done, PR ready, merge, branch delete. Begin/resume
  P1-009 only on separate authorization. Stop if profile-versioning storage semantics turn out canonically unsettled
  (owner-approved immutable-revision model per CDR-015).

## Authority limits (this ticket — P1-015)
- Standing Phase 1 authorization covers implementation, slices, pushes, CI, reviews, defect fixes, marking
  P1-015 Done, marking PR #17 ready, squash-merging it, and deleting its branch. Still forbidden: production
  systems/credentials/deploys, live Clerk, any Clerk dashboard change, public tunnels, force-push or history
  rewrite, direct commits to main, non-squash merges, touching PR #10 / its worktree / the stale
  `claude/affectionate-northcutt-f33c98` branch or the inert P1-002 endpoint, weakening tests to make them
  pass, and implementing later-phase scope. Stop only for a NEWLY discovered true mandatory owner gate.

## Authority limits (historical — P1-013)
- No production systems/credentials; no public tunnel; no Clerk dashboard; do not touch the inert P1-002 endpoint
  or PR #10 / its worktree. Do NOT: mark P1-013 Done / PR ready / merge / delete branch / begin P1-014; build
  break-glass or a JIT approval workflow; implement impersonation of any kind; add tenant-data mutations, admin
  list/search, audit export, UI, or SSE; add a runtime admin-management endpoint; add a worker/queue/outbox; add
  a 4th SECURITY DEFINER; weaken FORCE RLS; grant BYPASSRLS; expose the owner runtime connection or a third
  runtime role; export a generic arbitrary-tenant scope primitive; expand the activity taxonomy.

## Test baselines
- Inherited from merged `main` (`8afb8f0`): hosted CI green (zero-skip PG preflight + aggregate + audit). Integration
  files run serially (`vitest fileParallelism:false`) on one shared DB — new suites' cleanup drop-lists must include
  `company_memberships`, `company_profiles`, `companies` (and any new tables), ordered so FKs drop cleanly.
- Local Windows→WSL PG forwarding unstable; hosted CI is the authoritative zero-skip integration gate.
- The `_lc` shell hook intermittently emits false exit-127; verify state via git/gh/CI/filesystem re-reads (PowerShell).

## P1-011 slice plan (CDR-017)
- Slice 1 — **DONE** (`3e0834a`; exact-commit CI `29972673530` green). Shared base64url codec extracted; portfolio
  contracts (PortfolioItem/PortfolioPage; account+actor-bound base64url keyset cursor; strict limit REJECT-not-clamp);
  `portfolio:read` authz action + drift entry; codec/portfolio unit tests (54 contracts tests green).
- Slice 2 — **IN PROGRESS**. Account-scoped membership-filtered `PortfolioRepository`
  (`listActiveMembershipCompanies`: memberships-self-branch → companies PK join; keyset created_at DESC/id DESC;
  exact-microsecond `created_at_us`; NO name, NO list-all method) + real-PG visibility/isolation/keyset test.
  **Query-plan decision (CDR-017 §10): NO index migration** — PROVEN by hosted real-PG EXPLAIN evidence
  (`portfolio-plan.integration.test.ts`, realistic ANALYZEd population, postgres:16): natural plan = Limit → Sort →
  Nested Loop(Bitmap via `company_memberships_member_idx` → `companies_pkey` probe), no seq scans, identical for
  first + keyset pages. Migrations remain 0001–0009. See `docs/implementation/P1-011-PORTFOLIO-QUERY-PLAN.md`.
  Local integration UNRUNNABLE (Windows→WSL 5432 forwarding refuses connections); hosted CI is the zero-skip gate.
- Slice 3 — **DONE**. `getCompanyPortfolio` use case: Phase 1 enumeration under AccountScope
  (`portfolio:read` account-role check via own-membership bootstrap, then `PortfolioRepository`); Phase 2
  SEQUENTIAL per-candidate name enrichment via FRESH `runInCompanyScope` (Option B — no scope reuse, no parallel).
  A membership going stale between phases → runInCompanyScope denies → candidate DROPPED (never a stale/substituted
  row; keyset advances past it). `enrichCandidatesSequentially` exported for deterministic stale-drop testing.
  Real-PG core test proves membership-only visibility, account-member-only-no-rows, forbidden non-member, keyset
  pagination + account+actor cursor, strict limit/cursor rejection, cross-company enrichment isolation, stale-drop.
  Pure-guard unit test (limit/cursor reject before any DB) runs everywhere.
- Slice 4 — **DONE**. `GET /api/companies` (portfolio) added to the existing collection route (POST create
  untouched): allowed params {cursor, limit} only (any other → 400); server-resolved account+actor; maps
  ok→200 {items,nextCursor} / forbidden→403 / invalid_cursor→400 / invalid_limit→400. Wired `getCompanyPortfolio`
  through the ClerkIdentityRuntime composition + CompanyRuntime; `getPortfolioForRequest` request use case.
  Web unit tests (request + http mapping) green; local production `next build` green (route ƒ dynamic).
- Slice 5 — **DONE**. Real-PG switch-isolation test: A→B→A sequential re-entry (no name/status bleed);
  same company yields DIFFERENT roles to different callers (role isolation via portfolio); concurrent entries +
  concurrent portfolios never cross (pooled-connection GUC isolation); transaction-local GUCs clear after COMMIT
  AND ROLLBACK; forged route companyId (non-member + cross-account) denies coarsely.
- Slice 6 — **DONE (pending owner gate)**. Architecture docs (`docs/architecture/PORTFOLIO.md`; TENANCY.md P1-011
  entry); two independent reviews CLEAN; final verification green. PR body updated. Awaiting owner authorization
  to mark Done / ready / merge / delete branch.

## P1-012 slice plan (CDR-018)
- Slice 1 — **DONE** (`69d15fa` + completeness-registry fix `d0dbe2f`): contracts (closed step/status/failure-code
  enums, DTOs, flag derivations), `provisioning:read`/`provisioning:resume`, six audit registrations + factories +
  operation partition. Draft **PR #14**.
- Slice 2 — **DONE** (`bcd12a2`; CI 30010682316): migration 0010 (CHECK-pinned tables; FORCE RLS dual-key;
  column-limited UPDATE; idempotent draft/onboarding backfill with BYPASSRLS guard) + real-PG
  RLS/privilege/backfill/down-up suite; all 22 existing suites' drop-lists extended.
- Slice 3 — **DONE** (`7e0a5d4`; CI 30011303006): creation tx atomically adds 6 pending checkpoints +
  draft→onboarding + provisioning.started (selective-writer rollback proven); creation returns onboarding.
- Slice 4 — **DONE** (`ae4fd5c`; CI 30012231249): fresh-scope step executor (FOR UPDATE + status/attempt guards;
  no committed running; cap 3), material effects (verify profile/activity; idempotent area inserts), resume
  orchestration (Phase A company-row-locked gates; USER retry_requested + causation; backfilled-draft bring-up;
  paused/inconsistent fail closed), completion transition (locks + gate + idempotent activation),
  createCompany post-commit INLINE auto-run (provisioningRunner seam); 12-test real-PG suite (kill-and-resume at
  every checkpoint, exhaustion, concurrency single-effect/single-activation, authz matrix, DTO privacy, GUC
  cleanup, provisioning audit completeness).
- Slice 5 — **DONE** (`5933fe3`; CI 30012614309): GET …/provisioning + POST …/provisioning/resume (param-free,
  body never parsed) + runtime wiring + web tests + prod build (both routes ƒ dynamic).
- Slice 6 — **DONE (pending owner gate)**: three independent reviews (security/RLS/audit; correctness/
  concurrency/state-machine; scope/migration/taxonomy) — NO Critical/High; R2's 2 Medium (concurrent-retry
  authorization/audit gaps) FIXED STRUCTURALLY (retry_requested written in the executing step tx under an exact
  (step, attempt) Phase-A authorization; unauthorized failed rows halt); 6 further Lows fixed, 5 accepted with
  documented rationale (`docs/implementation/P1-012-REVIEW-COVERAGE.md` register). Architecture docs complete
  (PROVISIONING.md new; TENANCY/AUTHORIZATION/EVENT-CATALOG/AUDIT/DATA-ARCHITECTURE/API-CONTRACTS updated).
  Local gate green on the Slice 6 candidate (674 passed / 277 PG-dependent skips; build; audit; diff-check).

## P1-013 slice plan (CDR-019)
- Slice 1 — CDR-019 + planning + draft PR; contracts (AdminReason validation, AdminReadTarget,
  AdminCompanyOverview), `admin:tenant_read` authz (granted to NO membership role), `admin.tenant_read` audit
  registration + completeness partition; unit tests.
- Slice 2 — migration 0011 `platform_admins` (self-check SELECT only; zero mutation grants) + real-PG
  RLS/catalog/lifecycle tests + operational setup/revocation runbook stub.
- Slice 3 — private admin gate + transaction-local target-scope primitive + audited company-overview read
  (audit-before-response atomicity) + real-PG trust tests.
- Slice 4 — POST /api/admin/accounts/[accountId]/companies/[companyId]/read (strict body/query parsing) + web
  tests + production build.
- Slice 5 — concurrent/GUC/no-impersonation adversarial tests + docs (break-glass design; runbook; architecture
  updates) + independent reviews + final verification (owner gate).

## Next executable action

**CORRECTED 2026-08-04.** This section still read "Phase 1 is complete… begin Phase 2" while every P6 ticket was
being worked, which made the one pointer the file's own header sends a resuming reader to the most stale line in
it. The generic procedure it described is now in CLAUDE.md; what belongs here is the actual next move.

**CORRECTED AGAIN 2026-08-05.** This section claimed Phase 6 was "code-complete pending two owner merges" after
both of them had already merged — `1f4acaa` (P6-008) and `b36a079` (P6-012), each with a green exact-main run.
That is the same failure mode the 2026-08-04 correction was written about: the file's own forward pointer went
stale first. Trust `git log origin/main` and an `Import-Csv` of BACKLOG.csv over any prose in this file, including
this paragraph.

**Phase 6 is 12/12 and closed.** Only **ACBP-P6-002** remains owner-gated, and a Done ticket does not close it.

**Phase 7 is open. ACBP-P7-001 is MERGED** (`cf67c7f`, PR #73, branch deleted) — see its DONE line and working
block above.

**ACBP-P7-007 is MERGED (squash `1bb4751`, PR #76) and its backlog row is NOT `Done`** — same reason, stated in
its own block at the top:
its acceptance criterion *"all suites green"* **cannot be met on its literal wording**, because #8 asserts a
control over an entity that does not exist and #15's canonical wording names a credential the runtime does not
have. What it leaves behind is a **machine-checked trust-critical index**: 20 rows, each pinned to a real test
title and an anchor class, where **an attribution with no test fails the build**, and where a row is only green
with a **hosted CI mutation run id** (`31113087854` bought **two** of them — a third was recorded and withdrawn
when review showed the run reddened a different test). **18 of 20 are unproven, and the gate prints exactly
that**, in the vocabulary the index defines: `2 MEASURED …, 16 unmeasured, 2 with no test; 18 unproven (ceiling
18)`. `unmeasured` and `unproven` are distinct states — quoting the wrong one is how this paragraph was wrong
before. **(THOSE FIGURES ARE P7-007's AND ARE SUPERSEDED BY `5b7ad92`: it is now 12 measured, 7 unmeasured, 1
unprovable — 8 unproven, ceiling 8. The paragraph is kept because the distinction it draws between `unmeasured`
and `unproven` is still the point, and because "18 of 20 are unproven" is what P7-007 actually shipped.)** Do not read the twenty green checkmarks in `TEST-AND-VERIFICATION-STRATEGY.md` as coverage without
reading the index beside them.

**ACBP-P7-002 is MERGED (squash `4125f0f`, PR #74, branch deleted) but its backlog row is NOT `Done`, and that
is deliberate.** (This paragraph
originally opened *"ACBP-P7-002 is merged"*. A verification pass caught it. Recording a gate as taken when it
was not is the most consequential error in that docs pass, and it is corrected in place rather than quietly.)

What the branch launched is **Gate 14 for company pause** — which had never existed; **nothing in production read
`companies.status` before doing autonomous work**, so pausing a company was a label rather than a control from
P1-010 until now. (The qualifier is load-bearing: `startInterviewSession` did read and refuse on it, but that is
a human-initiated discovery start, not autonomous work. Dropping the qualifier makes the sentence false.) Four of
five enforcement points ship and are mutation-proven. **Two acceptance clauses are unmet**, each an owner
decision, not an engineering gap:

- **The deactivate transitions (§10 slice 5, gated behind §9.5).** Nothing performs `active/paused →
  deactivating`, so in production the two new states are reachable only by a direct database write and
  `company.deactivated` is never emitted (its own open item is **§9.10**). Building them changes merged
  `pauseCompany` behaviour and needs the durable-stop sweep, which is what **§9.5** actually asks: *"Does pause
  now raise a real halt?"*
- **§9.7 — reactivation semantics**: what reactivating a *deactivated* company means. Separately **§9.8**:
  whether `paused → active` enforces ADMIN-002's held-work review. `paused → active` is tested; neither policy
  is written.
- Also open: **§9.2** the account status vocabulary (the account half was deferred by the owner's ruling), and
  **§9.3** worker-body enforcement — `startRun` closes run *creation*, but a body invoked with a stale `runId`
  still reaches the network and the metered gateway before its first database statement.

**CORRECTED AGAIN 2026-08-07 — four more tickets have merged and the list below is history from here down.** On the
owner's explicit authorisation, **#78 → #82 → #79 → #83** were merged one at a time, each with a fresh exact-head run
and a confirmed exact-main run between merges: **P7-014 CSRF** (`0bad8ba`), **P7-015 headers/CSP** (`53a35a6`),
**P7-013 rate limiting** (`c9c3aa1`), **P7-009 MVP suite** (`e1bbc1c`). `main` finished green at **`e1bbc1c`** —
[`31191559654`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31191559654), **276 files /
4038 tests, zero skips**. Each branch tip's tree was verified **byte-identical** to `main` after its squash, which is
the right check for a squash — ancestry is not. See the DONE lines at the top of Active for each.

**NFR-010's three ASVS baseline items are now all built** — rate limiting, CSRF, security headers/CSP, one ticket
each. **The requirement is still not fully covered**, and the remainder is not an engineering gap a session may
close: the **pen review** has not happened (external vendor, General MVP gate); **unauthenticated pre-session
traffic** is bounded by nothing, because bounding it needs a deployment edge this repository has no configuration for;
and P7-015 shipped neither HSTS nor COOP, while its report-only CSP collects nothing for want of an endpoint.

**PRs #62 (P5-012) and #63 (P5-014) were closed** on the owner's ruling, as superseded rather than as work lost:
**zero** of the paths either branch touches is absent from `main`, checked path by path, and both features are
exercised there. **#10** (P1-004's last-owner revoke race) is still open and still untouched since Phase 1.

**No backlog row was set to `Done` in that sequence, and no branch was deleted** — both remain owner gates.

**Remaining Phase 7 work that is backend-only** (the UI direction is still unset, so every user-facing row stays
blocked):

- **ACBP-P7-007** security test pass — **MERGED as `1bb4751`, NOT `Done`** (PR #76; see its block at the top). It leaves
  behind the thing the next security ticket should use: a machine-checked trust-critical index where **an
  attribution with no test is a red build**, and a ruling that a negative is green only with a **recorded mutation
  run id**. **18 of 20 rows are unproven and the gate prints that number**; closing them is the standing work.
  It also leaves `check:csv-shape`, because a shifted CSV row has now silently answered a coverage question
  wrongly twice in this repository.
- **ACBP-P7-008** failure-injection pass — listed `ACBP-P6-012` as its dependency, which is why it was unstartable
  until that merged. **P7-002 hands it concrete material**: Gate 14's four points to attack, and the §9.14 class
  (a new gate outranking an existing one and silently inheriting its side effects) which this repository does not
  enforce anywhere. **P7-007 hands it the index**: adding a row is now the cheapest part of proving a negative.
- **ACBP-P7-009** end-to-end MVP suite — unblocked by P7-001.
- **ACBP-P7-006 stays owner-gated**: it needs real live infrastructure, and it is the only thing that can turn
  P6-011's suppression counter from "it fired" into "it would have".

**Three stale draft PRs are still open and unaddressed**, none of them Phase 7: **#63** (P5-012), **#62**
(P5-014), and **#10** (P1-004's last-owner revoke race, open since Phase 1). **ACBP-P3-006** is `Planned`,
unblocked, and has never been picked up.

## Local integration environment (learned 2026-07-24)
Local real-PostgreSQL runs ARE possible on this machine, contrary to the older "unrunnable" note below — two
things were in the way: (1) the dedicated WSL distro terminates when no process holds it open, so hold it with
a background `wsl -d acbp-local-dev … sleep N` for the duration of a run; (2) the local owner role lacked
CREATEROLE, so migration 0005 failed with "permission denied to create role" — CI's owner is a superuser, so
`alter role acbp_dev superuser createrole` on the disposable local distro matches CI. Hosted CI remains the
authoritative zero-skip gate; local runs are for fast feedback and for executing `pnpm demo:slice-a`.
