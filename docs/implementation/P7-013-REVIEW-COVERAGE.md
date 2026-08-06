# ACBP-P7-013 — review and coverage ledger

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
(`tools/probes/p7-013-csrf-origin-gate.probe.mjs`). Committed rather than described, because
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

## §3 Defects found in this ticket's own work

| # | Where | What | Found by |
|---|---|---|---|
| 1 | `tools/check-csrf-origin-gate.mjs` | The matcher-array parser used `\[([\s\S]*?)\]` and stopped at the `]` inside `[^?]` in the real matcher's first entry — so every entry was invisible and a correct matcher was reported as not covering `/api`. **No fixture could have caught it**; every fixture had a simpler matcher than the real file. | first run against the real tree |
| 2 | probe harness | §2.1 — seven kills reported without running a test. | tightening the kill test |
| 3 | `apps/web/src/proxy.ts` | `allowedOriginsFromEnv(process.env)` read the variable by **computed key**. Next substitutes statically-analysable `process.env.X` when it bundles the boundary, so this could read `undefined` at runtime — silently, and in the safe direction, which is why it would never have been noticed. Now a static read. | self-review of the wiring |
| 4 | `CDR-081` §1.1 | The decision table listed a reason code `exempt_path` that **does not exist in the code** — the webhook exemption is the proxy's early return, and `decideSameOrigin` knows nothing about paths. A table describing a function that does not exist is this repository's dominant defect class. | self-review of the prose |
| 5 | `apps/web/src/proxy.test.ts` | An unnecessary type assertion masked what the proxy's return type actually is. | `pnpm lint` |

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

## §5 Coordination hazard, recorded rather than resolved

The two NFR-010 traceability cells this ticket edits are **also rewritten by the unmerged
`p7-007-security-test-pass` branch**, whose wording names CSRF as ABSENT — true when written, stale the
moment this merges. Whichever lands second must **merge, not overwrite**. Recorded because a conflict
resolved by taking one side wholesale is how a corrected record silently reverts, which ACBP-P7-002 hit
three times.
