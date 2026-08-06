# ACBP-P7-014 — review and coverage ledger

Companion to `config-decisions/CDR-081-csrf-origin-gate.md`. Records what this ticket's evidence proves,
what it does not, and every defect found in it — including the ones in its own author's work, because on
this repository those have been the majority.

---

## §1 What the ticket claims, and what each claim rests on

| Claim | Rests on | Class |
|---|---|---|
| A cross-site unsafe-method request to any state-changing route is refused | `proxy.test.ts` driving the real `proxy` module; `same-origin.test.ts` over the full decision table | HTTP response (`return_value_only`) |
| The refusal happens **before** any session is established | `proxy.test.ts` asserts the mocked session middleware recorded **zero** calls; `check-csrf-origin-gate.mjs` fails the build if the gate moves after it | statement order, asserted + pinned |
| A route module added later is covered without being edited | enforcement is in the boundary, not the route; the guard fails if a state-changing route appears outside `src/app/api` or the matcher stops covering `/api` | structural |
| The gate cannot be silently switched off | 7 mutations, 0 survivors (§2); two of them also fire the static guard | mutation-measured |
| No provider control already covered this | CDR-081 §0.2, each point cited to a file:line in the installed SDK | source inspection |

**Nothing here is anchored in database state, and §4 says why that is a property of the control rather
than a gap in the testing.**

## §2 Mutation results — 7 killed, 0 survivors

Re-derivable at any time: `pnpm run probe:csrf-origin-gate`
(`tools/probes/p7-014-csrf-origin-gate.probe.mjs`). Committed rather than described, because
ACBP-P6-006's probe branch is unreachable today and ACBP-P7-002's was never preserved — and
`P7-002-REVIEW-COVERAGE.md` §2.1 asks the next ticket to fix exactly that. This is that ticket.

| | Control removed | Tests that went red |
|---|---|---|
| M1 | row 10 — absence of provenance stops denying | 10 failed / 44 passed |
| M2 | row 4 — `same-site` becomes same-origin | 3 failed / 51 passed |
| M3 | row 7 — the closed vocabulary opens | 1 failed / 41 passed |
| M4 | §1.2 — an empty allowed set allows everything | 1 failed / 41 passed |
| M5 | the origin comparison becomes `startsWith` | 2 failed / 40 passed |
| M6 | §2 — the proxy ignores the deny verdict | 6 failed / 6 passed **+ guard exit 1** |
| M7 | §2 step 1 — the webhook bypass is removed | 1 failed / 11 passed **+ guard exit 1** |

The probe prints the NAMES of the red tests, so a reader can confirm they are the ones the mutation should
have broken rather than trusting a count.

### §2.1 The probe's own first run was a false confirmation
It reported **7/7 killed having executed no tests at all**: `execFileSync` cannot spawn `npx` without a
shell on Windows, so every mutation exited 1 with no output and the probe read the exit code as a kill.
A kill now requires the `Tests N failed | M passed` tally to show real failures.

**A red exit code is not evidence.** Three tickets have now hit this from three directions — ACBP-P7-002's
probe went red at *lint* before reaching the tests, CDR-080 §8.3's mutation ran the tests but never touched
their path, and this one never started them. The rule is in the probe's header so the next author inherits
it.

## §2.2 The independent review, and the HIGH it found

An adversarial review pass ran over the whole change — bypass hunting, the webhook exemption, breakage,
claims-vs-code, test vacuity, guard evasion, scope. **No Blocker. Two HIGH, five MEDIUM, six LOW.** It also
reported explicitly clean on the categories that matter most: it could construct **no** path from a
cross-site attacker to a state-changing handler, found **no** URL that satisfies `isClerkWebhookPath` while
routing elsewhere, found **no** vacuous assertion, and confirmed no scope creep (every CSV row width and
column position parsed, the BACKLOG `Status` cell prose rather than `Done`, every owner gate named untaken).

**HIGH-1 — the guard was defeated four ways.** See §3 row 6; the rule changed, not the wording.

**HIGH-2 — CDR-081 §0.3 misstated the pre-existing content-type surface**, in the section a reader uses to
size the exposure: it said *three* bodied routes went through a 415 media-type check when **nine** do, and
put `POST /api/admin/.../read` among the bodyless ones when it requires an exact `{ reason }` body
(`admin-http.ts:30`). The ruling is unaffected — a content-type check is not a CSRF control, and eight
methods genuinely are simple-request reachable — but the count was off threefold and one named route was on
the wrong side of the line. Corrected and verified by enumeration.

The MEDIUMs and LOWs were all prose-vs-code drift in this ticket's own documents, and all are fixed: a
matcher rule that accepted a *narrowed* `/api` entry; the `denies` detector missing from a self-test whose
comment claimed every detector was covered; §6.1's mutation tallies going stale inside the same working
tree; a `proxy.ts:21` citation that the ticket's own edit invalidated; "no rendered UI" contradicted by
`layout.tsx` — including §3 leaning on it to defer CSP; `:7063` labelled a handshake path when it is the
refresh path; "three export shapes" where the code implements four; PROJECT-STATE's "ten rows" against the
CDR's corrected nine; and an unexplained lowercase-method widening.

**Every HIGH and MEDIUM except one was in PROSE, not code** — and the exception (the guard's four evasions)
was in a *checker*, not in the control. The gate itself came through the review unchanged. That is the
pattern ACBP-P7-002 recorded and ACBP-P7-007 recorded again, holding for a third consecutive ticket.

## §3 Defects found in this ticket's own work

| # | Where | What | Found by |
|---|---|---|---|
| 1 | `tools/check-csrf-origin-gate.mjs` | The matcher-array parser used `\[([\s\S]*?)\]` and stopped at the `]` inside `[^?]` in the real matcher's first entry — so every entry was invisible and a correct matcher was reported as not covering `/api`. **No fixture could have caught it**; every fixture had a simpler matcher than the real file. | first run against the real tree |
| 2 | probe harness | §2.1 — seven kills reported without running a test. | tightening the kill test |
| 3 | `apps/web/src/proxy.ts` | `allowedOriginsFromEnv(process.env)` read the variable by **computed key**. Next substitutes statically-analysable `process.env.X` when it bundles the boundary, so this could read `undefined` at runtime — silently, and in the safe direction, which is why it would never have been noticed. Now a static read. | self-review of the wiring |
| 4 | `CDR-081` §1.1 | The decision table listed a reason code `exempt_path` that **does not exist in the code** — the webhook exemption is the proxy's early return, and `decideSameOrigin` knows nothing about paths. A table describing a function that does not exist is this repository's dominant defect class. | self-review of the prose |
| 5 | `apps/web/src/proxy.test.ts` | An unnecessary type assertion masked what the proxy's return type actually is. | `pnpm lint` |
| 6 | `tools/check-csrf-origin-gate.mjs` | **The guard could be defeated four ways.** Its exemption rule matched `return undefined`, so `return;`, `return NextResponse.next();`, `return new Response(...)` and a URL literal whose `//` blinded the comment stripper each added a working second CSRF exemption with the checker exiting **0**. The stripper bug was in a *shared* helper and could have blinded any detector. Rule changed to **no early return before the gate**, which cannot be evaded by changing what is returned. | independent review |
| 7 | `tools/check-csrf-origin-gate.mjs` | `matcherCoversApi` accepted any entry starting `/api`, so a **narrowed** `'/api/companies/:path*'` passed while leaving `/api/account/*` and `/api/admin/*` unproxied. Also mined the `source` string out of an **object-form** entry (`{ source, missing }`) whose header condition can make requests skip the proxy entirely — now exit 2, because answering wrongly is worse than refusing to answer. | independent review |
| 8 | `tools/check-csrf-origin-gate.mjs` | The `denies` detector was **not** in the negative self-test, while the block's comment claimed every detector was. Had that regex broken, the checker would have reported CLEAN instead of exiting 2 — the exact CDR-080 §8.4 failure the block exists to prevent. | independent review |

Row 6 deserves a sentence of its own: `check-approval-port.mjs`'s header — *"four ways to reintroduce the
exact thing it exists to prevent, all silent"* — was **read and cited in this checker's own header** while
the same mistake was being made underneath it. Knowing the lesson did not prevent it. Adversarial review
did.

Two fail-closed properties were **unasserted** until self-review found them and they became tests:
duplicate `Origin` headers (joined by `Headers.get()`, then unparseable → row 10) and duplicate
`Sec-Fetch-Site` headers (joined → row 7). Both would have been **allowed** by the obvious wrong
implementations — a substring origin match, or `includes('same-origin')` instead of equality.

## §4 What this ticket does NOT prove

- **No real-PostgreSQL evidence exists and none is claimed.** The gate refuses before any handler runs, so
  there is no database state to anchor on. The composition test originally planned was **withdrawn as
  vacuous** (CDR-081 §6.3): it would have asserted only that the test harness declined to call the route,
  and would still pass with the entire gate deleted. Local PostgreSQL is unreachable as always, but that is
  **not** why the test is absent.
- **"A forged request reaches no route handler" rests on two things, one of them unverified here**: the
  order of statements in `proxy.ts` (asserted through the real module, pinned statically) *and* Next.js
  running the proxy before the handler, which is framework behaviour this repository does not test.
- **The gate has never run against a live browser or a deployed environment.** No deployment exists.
- **`pnpm test` locally leaves 114 files / 1603 tests SKIPPED** — every `skipIf(!hasTestDatabase)` suite.
  None of them is this ticket's, and all 76 of this ticket's tests execute locally; but the repository-wide
  "suite green" claim needs hosted zero-skip CI on the exact SHA, as it always has.
- **Two of NFR-010's three absent ASVS items are untouched.** HTTP rate limiting and security headers/CSP
  remain absent and are still owed their own tickets (CDR-080 §4). The pen review is untouched.

## §5 Two concurrency hazards, one resolved and one recorded

### §5.1 A ticket-id collision — resolved by yielding
A concurrent session independently took **ACBP-P7-013** for **HTTP rate limiting**
(`p7-013-http-rate-limiting`, commit `b20b036`), branched from the same `2c4f0f5` within minutes of this
one. Both add a `BACKLOG.csv` row, so a **duplicate ticket id would have merged**. This ticket renumbered
itself to **ACBP-P7-014**: yielding is the only move that removes the failure mode without requiring the
other session to act, and one session cannot edit another's branch. Not a concession that the other number
is right — CDR-080 §4 lists CSRF first and this branch was pushed eight minutes earlier — just that a
duplicate id is worse than a number nobody argued about. **The branch name and PR #78 title still read
`p7-013`**; renaming a pushed branch means closing and reopening the PR, which is the owner's call.

### §5.2 A three-way collision on the NFR-010 cells — recorded, not resolvable here
`p7-007-security-test-pass` downgrades them and names all three ASVS items ABSENT; this ticket closes the
CSRF one; `p7-013-http-rate-limiting` closes the rate-limiting one. Whichever lands second, third or fourth
must **merge**, keeping the union of what is closed and the intersection of what is unmet. Taking one side
wholesale is how a corrected record silently reverts — the failure ACBP-P7-002 hit three times.

## §6 Hosted CI

Run [`31117906801`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31117906801) on
commit `1357508` reports **cancelled** — and it is **VOID, not a regression**, diagnosed before anything was
touched: `steps = 0` with **no runner ever assigned**, after ~11 minutes queued. That is the
job-never-started signature PROJECT-STATE already documents for `30590300693` and `30632014201`; there is
nothing in it to respond to, and no code was changed because of it. Three concurrent sessions were pushing
branches at the time, so runner starvation is the likely cause rather than anything in this change.

A run on the final SHA is what this ticket's completion standard needs, and it is not yet in hand.
