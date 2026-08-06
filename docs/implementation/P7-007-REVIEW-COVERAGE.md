# ACBP-P7-007 — security test pass: review coverage and evidence

Ticket: **ACBP-P7-007** security test pass (NFR-010, NFR-018, NFR-021; ADR-007/009/014;
`SECURITY-VERIFICATION-PLAN.md`; the twenty in `TEST-AND-VERIFICATION-STRATEGY.md`). Branch
`p7-007-security-test-pass`, PR **#76**, decision record **CDR-080**. Launch gate 12 feeds from here; **declaring
the gate passed is the owner's**, not this ticket's.

> **THE TICKET IS NOT DONE AND IS NOT MERGED**, and neither is an oversight. Its acceptance criterion —
> *"all suites green"* — cannot be met on its literal wording: **#8 can never go green** (nothing to revoke) and
> **#15's canonical claim is unbuildable** (no provider key exists in the runtime). What it delivers instead is
> stated in §2 and bounded in §5.

---

## §0 The finding: the list this ticket is judged against was itself unreliable

The row reads like a rubber stamp, and **all twenty trust-critical negatives already had something green beside
their names.** An eight-agent investigation read the test **bodies** behind all twenty.

**As of `main` at `2c4f0f5`**, before this ticket changed anything:

| Class | Count | Items |
|---|---|---|
| Database state / recorded row, through the production entry point | **11** | 1, 2, 4, 5, 6, 9, 11, 12, 13, 17, 20 |
| **Return-value-only or weaker** | **4** | 7, 10, 14, 19 |
| **Partial** — the claim as worded is never executed | **3** | 3, 16, 18 |
| **Not covered at all** | **2** | 8, 15 |

11 + 4 + 3 + 2 = **20**. (This table read `12` and listed eleven items until the second review pass, so it added
to twenty-one — in five documents at once. A classification of exactly twenty things that does not total twenty
is the cheapest possible self-check, and nobody ran it.)

**The "partial" row is orthogonal to the anchor column in the shipped index, and conflating them is a trap.**
Items 3, 16 and 18 all carry a *strong* anchor — they genuinely read database state — while the claim **as the
canon words it** is never executed. A reader comparing this table to the index's anchor column will otherwise
find 15 where this says 11 and conclude one of them is lying. Both are true of different questions: *what does
the test assert against?* versus *does it assert the sentence?*

**Seven of the twenty attribution lines were wrong or incomplete** — and building the index surfaced **two more**, #15 and #17, because every row had to name what really built it. Plus a misgrouping in a second canon file, and **four coverage cells across the two traceability matrices** naming tests, rigs and reviews which do not exist. (Three of those four read `Covered`; INTEG-003's in the ticket matrix read `Deferred by approved scope`. Calling all four "Covered cells" was loose in a document whose subject is loose claims.)

### §0.1 The five that mattered

1. **#8 can never go green, and its canon line asserted a rig nobody built.** No integrations entity exists
   anywhere — no table, no migration, no service, no contract, no integration value in `TOOL_DENIAL_REASONS`.
   CDR-067, the decision record of the ticket credited with the rig, never mentions integrations.
2. **#19 contained two assertions that could not fail.** `not.toContain('SECRET')` — and the literal `SECRET`
   appears nowhere in that harness; the planted value is `FAKE_INTERNAL_MARKER`, whose own comment says it is
   *"deliberately NOT shaped like a real key"*.
3. **#10's timing evidence for launch gate 8 measures the wrong interval.** The helper *named* `activateStop` is
   a raw `INSERT`, not the production use case, so the measured ≤5s window excludes activation entirely.
4. **Two green tests read as #15 coverage to any grep** — real `whsec_`/`sk_test_` literals in real `Response`
   bodies with `not.toMatch` assertions. Neither drives a route module or a configured credential.
5. **#16's audit half is protected by nothing.** `boundedMetadata` rejects objects, arrays, Errors and null —
   then accepts **any string ≤1024 units with no secret detection**.

---

## §1 What this ticket built

| Slice | Artefact | Verified by |
|---|---|---|
| 2 | **The trust-critical index + its checker** — `tools/trust-critical-index.mjs`, `check-trust-critical-index.mjs`, 27 regression cases | It **rejected its own author's citation on first run** (§3) |
| 3 | **#15 — the browser-response negative that did not exist.** All 5 `Secret` fields sentinelled; **every exported HTTP method of all 23 route modules** driven; body *and* headers swept; 2 source guards; 3 controls | Mutation: a route emitting `secretKey.reveal()` turns **2 tests red**, naming method, route, status and which secret |
| 4 | **#16 — the logger hole CLOSED and the audit gap made EXECUTABLE.** `logger.ts` emitted `message` verbatim while `metadata`/`error` were redacted. Plus `metadata-secrets.test.ts` and a reusable real-PG sweep in `@acbp/test-support` | Red-then-green on the logger; 12 sweep regression cases, including one pinning that **the failure never prints the secret** and four added later for the sweep's own vacuity modes |
| 5 | **#19's two vacuous assertions fixed**, repointed at the marker the fake actually plants, with a control proving it still plants it | A mutation on the real result path turns one test red — but **NOT the test row 19 names**, which is §2.2 |
| 6 | **The secret scanner hardened and given its first tests ever** — allowlist→denylist file selection, stale-allowlist detection, self-test, `--json`, named CI step, 28 cases | The denylist change made **734** files visible; the scanner **found itself** (§3) |
| 7 | **Canon corrected**: 10 attribution lines, a misgrouped `#9`, four coverage cells across the two matrices; 3 ASVS tickets proposed | `check-trust-critical-index.mjs` **blocked a statement rewrite** mid-edit (§3) |
| 7b | **Three independent review passes, and the defects they found FIXED** (§2.3) — including the ticket breaking its own central rule | Each fix carries its own regression case; the counts below are the measurable part |

`test:boundaries` went from **3 files / 51 tests** to **6 files / 118 tests**.

### §1.1 A sixth thing caught the author, and it was the gate itself

Running the gate for this ledger, **ESLint died of an out-of-memory at the default 4 GB heap after reporting
30,288 errors** — every one of them inside `.claude/worktrees/`, where the agent tooling had checked out three
*other* branches nested inside this one. So the local gate was reporting a sibling branch's diagnostics against
this branch, and then failing to finish at all.

Fixed with a single ignore in `eslint.config.mjs`. CI checks out a bare tree and was never affected — which is
exactly why it stayed invisible until someone ran the gate locally with worktrees present.

**THIS PARAGRAPH ORIGINALLY CLAIMED ESLINT WAS THE ONLY TOOL IN THE GATE THAT WALKS FROM THE REPOSITORY ROOT,
AND THAT WAS FALSE** — a review found the counterexample *inside the very file this ticket had just hardened*.
`check-secrets.mjs` runs two passes: a **content** scan over an explicit root list (which was indeed immune) and
a **repository-wide `.env` filename walk**, which visited 4,672 files, **3,604 of them inside `.claude/`**. A
`.env` committed on a sibling branch would have been reported as a finding against this one, naming a path not
in this branch's tree. That walk now skips `.claude` too.

The lesson is the one this repository keeps relearning and I keep having to be told: **"I checked and it's the
only instance" is a claim like any other, and mine was made by reading the four tools I expected to be immune
rather than the one I had my hands in.** The other three (`check-encoding`'s `SCAN_DIRS`, `check-conflict-targets`
and `check-migration-drain-loops`) really are root-list-scoped — the sweep was not wrong, it was incomplete, and
incomplete in exactly the place familiarity made me stop looking.

---

## §2 The ruling that shapes the ticket

**A negative is GREEN only when its index row carries a recorded mutation with a hosted CI RUN ID** — the exact
edit that weakens the control, and the run in which the named test actually went **red**.

Not a probe SHA. ACBP-P6-006 recorded probe commit `fe85082`; it is reachable from **no ref today** because that
branch was squash-merged and deleted, and only run id `30646208952` survived. `P7-002-REVIEW-COVERAGE.md` §2.1
told the next ticket to record the run id. **This is that ticket.**

A row without one is **not green — it is UNMEASURED**, in that word. Anchor classes are a closed vocabulary
(`database_state | recorded_row | return_value_only | pure_helper_only | none`) so prose cannot round four weak
items up. The checker enforces both, plus a **ceiling** on rows not yet measured. That ceiling is compared against `origin/main`, so it cannot rise — a property the word "ratchet" asserted for a while before anything enforced it (§2.3).

### §2.1 The probe: run `31113087854`

A disposable branch (`p7-007-mutation-probe`, PR #77) carried three defects, one per row. Each was made
**type-safe and lint-clean deliberately** — a mutation that dies at the static gate never reaches the tests,
which is exactly how ACBP-P7-002's first probe produced a false confirmation.

**It worked, and here is the evidence rather than the assertion.** The dedicated *Secret scan* step passed, the
aggregate gate reached the suites, typecheck and lint produced **zero** errors, and the run reports
**3747 passed, 5 failed of 3752**:

The run's five red tests, and which rows they actually bought:

| Row | Mutation | Test that went red | Counts? |
|---|---|---|---|
| **#15** | `auth-check/route.ts` emits `secretKey.reveal()` in its 401 body | `every exported HTTP method of every route module answers WITHOUT emitting a secret` **and** the `.reveal()` source guard | **YES** |
| **#16** | `logger.ts` stops passing `message` through `redact()` | `sentinel secret never appears in an emitted MESSAGE either` | **YES** |
| **#19** | the gateway appends the provider's internal text to `model` | `a material decision that fails, fails HONESTLY` | **NO — see below** |
| — | (same mutation) | `model-gateway.test.ts > success returns validated output…` | collateral |

**Ceiling: 20 → 18. TWO rows are MEASURED; eighteen are not, and the index says so in that word.**

### §2.2 I marked row 19 measured on a run that did not measure it

This is the most important correction in the ticket, because it is the ticket's own thesis committed by the
ticket itself.

Row 19 names the test `a MATERIAL decision does NOT silently fall over — generation fails on the primary`. That
test asserts `outcome`, `fallbackUsed`, `callCount` and `validatedOutput` — **and appending text to `model`
cannot touch any of them.** It was green in run `31113087854`. What went red was a *different* test in the same
file, `a material decision that fails, fails HONESTLY`, and it went red through that test's **leak** assertion —
so the evidence is about egress, not about silent fallback. **Two independent reviews caught it; one pulled the
run log and enumerated the failing set.**

The checker could not catch it, and that is a design fact worth naming: **nothing cross-checks a row's `mutation`
against its `testTitle`.** `check-trust-critical-index.mjs` verifies that the title exists and that a `measured`
row carries a run id. It cannot verify that *that run* reddened *that test*. So the rule I wrote —

> the run in which **the named test** actually went red

— was enforced by me reading a log, and I read it wrong. Row 19 is back to `unmeasured`, the ceiling is 18, and
both limits are now stated in the checker's own header and printed in its success line (`run id recorded —
shape-checked, not resolved`) rather than left for a reader to assume away.

**The mutation was also not surgical**, and that is recorded rather than trimmed: appending the marker to `model`
broke an unrelated **success-path** assertion in `model-gateway.test.ts`. Locally I ran only the three touched
files and saw four failures; the fifth existed only in the full suite. **A partial local run is not a preview of
CI.**

Deliberately absent too: **#19's second mutation — re-labelling `strategy.options` as `extraction`** — is the one
that would actually prove the row, by turning the platform's most material decision fallback-eligible with the
whole suite green. It has never been run.

---

## §2.3 The second review pass: three lenses, and the ticket failed its own standard in six places

Before reporting complete, three independent adversarial reviews ran over the whole diff — one on whether each
new guard is a guard or merely guard-shaped, one on every prose claim against the code, one on security and
scope. **The first two converged on the same HIGH independently.** Everything below was found there, verified at
the source, and fixed in this branch.

| # | What was wrong | Why it mattered | Now |
|---|---|---|---|
| 1 | **Row 19 `measured` on a run its named test did not fail** (§2.2) | The one rule the whole ticket exists to enforce, broken by the ticket | `unmeasured`; ceiling 18 |
| 2 | **`testTitle` was a bare substring match** | `test.skip(…)`, an emptied body, and a title surviving only in a **comment** all passed while printing *"pinned to live tests"*. Renaming a test broke the build; **neutering** it did not — and neutering is the cheaper move for anyone chasing green | Must attach to a live `test(`/`it(`; `.skip`/`.todo`/`.fails` rejected; **6 new regression cases** |
| 3 | **The "ratchet" was an editable integer** | `MAX_UNPROVEN` is a constant in a file the author edits; nothing stopped raising it in the same commit that broke a measurement. Its docstring said *"may only ever go DOWN"* and **could not name an enforcer** — the exact rule this repo applies to every other comment | Compared against `origin/main`; CI fetches the baseline; where no baseline is readable it **says so** instead of passing quietly |
| 4 | **The route sweep counted handlers FOUND, not handlers that ANSWERED** | `exercised` was incremented *before* the call and thrown handlers were swallowed. If every route threw — one new required env var, a config change — the suite would go green **having swept zero response bodies**, permanently, with row 15 still `measured` | Asserts responses were produced, that throws are a minority, and that the sentinel actually reached `loadClerkConfig()` |
| 5 | **The audit sweep was vacuous against the real schema** | Both swept tables carry **FORCE ROW LEVEL SECURITY**. Called the way its own docstring prescribed — outside `withAccountTransaction` — both queries return **zero rows and no error**, so it reports a clean audit trail it never read. It also promised a `sweptTables` field **that did not exist**, and its bare `catch` turned permission-denied into "clean" | Returns what it read; throws on all-zero-rows unless the caller passes `allowEmpty`; distinguishes absent from unreadable; **5 new cases** |
| 6 | **Two allowlist entries rested on a false justification** | They claimed *"there is no shape that both matches `containsSecret` and evades this scanner"*. There is: assemble the literal from parts, or stop naming a constant `SECRET`. Each entry silenced a rule for a **whole file forever** — the blind spot this ticket exists to close, in this ticket's own diff | Both files reshaped; **3 entries removed**, 10 → 7 |

And two that are the same defect class as everything above, committed in this ticket's own artefacts:

| # | What was wrong | Now |
|---|---|---|
| 7 | **`check-secrets.mjs` still contained a literal NUL byte — inside the comment describing the NUL fix.** So the scanner was *still* skipping its own file while **three separate documents stated the blindness was fixed**, and `CDR-080` carried the same corrupted byte. Found by reading bytes; rendered text cannot show it | Both replaced with the visible escape. The scanner reports **734** files where it reported 733 — the extra one is itself |
| 8 | **Two CSV rows malformed**: `Partially covered - boundary only, no quarantine (MVP)` written **unquoted** into `Coverage status` in BOTH matrices, so a parser read the coverage as `Partially covered - boundary only`, the `Gap or question` as ` no quarantine (MVP)`, and pushed the note into a phantom twelfth column | Quoted. **`tools/check-csv-shape.mjs` is now a static gate** over every tracked CSV, with a negative self-test and 11 cases |

Number 7 is the third time in this ticket that **a correction re-created the defect it was closing**, and the
first time it did so in a byte rather than a sentence. Number 8 is the second time in this repository that a
shifted CSV row has silently answered a coverage question wrongly — ACBP-P6-011's backlog row landed one column
left — which is why it became a gate rather than another lesson. It found two more malformed rows dating to the
Phase 0 initial commit; both were pure quoting errors and both are fixed, so the checker ships with **no
exclusion list**, an exclusion list being the thing that rots.

Two more, in production code rather than tests:

- **The logger fix's own comment named an example the redactor did not handle.** It offered *"a connection string
  or `password=…`"* as equivalents; `password=` was covered and a connection string was **emitted verbatim**, as
  were a JWT, an AWS key id, a Slack token and the `Basic` scheme. The measured mutation proved `message` is
  *piped through* the redactor and nothing about what the redactor knows — because the case it reddened plants
  `password=`, the one shape already covered. `redactString` now composes `redactSecrets` (the contracts
  `SECRET_PATTERNS`, a strict superset, and the **same detector `containsSecret` uses** — before this, the audit
  sweep and the log redactor disagreed about what a secret is, with the sweep stricter). One case per shape.
- **`event` was the second unredacted free-text field**, and the file header claimed *"every emitted record is
  redacted before it reaches an adapter"*. It is `string`-typed; the dotted-name convention is not a control.
  Now redacted, with a control proving ordinary names survive.

**None of the eight is a test that failed. Every one is a test, comment or status that PASSED while meaning less
than it said** — which is the same finding this ticket opened with, turned on its author. The measurable part:
`test:boundaries` 100 → **118**, the logger suite 15 → **23**, the sweep suite 7 → **12**, the index checker's own
suite 21 → **27**, plus **11** new cases for `check:csv-shape`.

---

## §3 Seven times a tool this ticket built caught its own author

Recorded because they are the evidence that the mechanisms work, and because each was one step from being
written down as a success.

1. **The index checker rejected my own citation, one minute after it existed.** Item 14's title had drifted from
   the source, which also escapes an apostrophe. Two fixes came from one red run.
2. **The ratchet failed the build for ADDING COVERAGE.** `MAX_UNMEASURED` counted unmeasured rows alone, so when
   #15 gained its first test the row moved `not_covered → unmeasured` and the count *rose*. Replaced with
   `MAX_UNPROVEN`, counting every not-yet-measured row.
3. **A mutation that proved nothing, caught before it was recorded.** My first #19 mutation edited `errorResult`
   — which serves only the policy-precheck path and **is never reached by a provider failure**. All nine tests
   passed, which reads as *"still vacuous"*. **A mutation that does not reach the assertion fails in the
   direction that looks like a finding.** CDR-080 §8.3.
4. **The secret scanner was invisible to itself.** A literal NUL byte in the binary guard made it skip its own
   file. Replacing it with the escape produced **nine findings** immediately. The fix was *not* to allowlist the
   scanner — the probes are assembled from parts instead.
5. **The index checker blocked a canon edit mid-flight.** My first #10 correction rewrote the canon *statement*
   rather than its attribution; the checker failed with `statement drift`, naming both sides.
6. **ESLint died of an OOM inside a sibling worktree** (§1.1) — the local gate could not finish at all.
7. **The new attachment check failed on the real index within a minute of existing** — item 14's title contains
   an apostrophe, written `\'` in source, and my first version unescaped the file *before* scanning for literal
   boundaries, so the literal appeared to end mid-title. Fixed by reading each literal with escape handling and
   unescaping only what was extracted; the case is now pinned. **Two of the seven entries in this list are the
   same mistake in different clothes: a guard written this week, wrong on its first contact with real data.**

---

## §4 The evidence bundle

- **Local gate, all green** at the head this ledger describes: `typecheck` 0, `lint` 0, the eleven `check:*`
  scripts 0, `test:boundaries` **6 files / 118 tests**, `pnpm test` **2179 passed | 1603 skipped of 3782** across
  265 files, `pnpm audit --audit-level high` 0 (1 moderate, below threshold), `git diff --check` 0.
  **The 1603 skips are the point, not a footnote**: they are the real-PostgreSQL suites, unreachable on this
  machine, which is why hosted zero-skip CI on the exact SHA is the only evidence that counts for anything
  touching the database.
- **The probe ran against a 3752-test tree; this one has 3782.** An earlier draft of this bullet claimed the
  totals "cross-check exactly", which was true when written and stopped being true the moment the second review
  pass added thirty tests. **A number that matches today is not a verification method** — the durable record is
  the run id, which is why the rule is written the way it is.
- **Secret scan**: `pnpm run check:secrets` — 0 findings, 734 files, 10 allowlist entries all in use, self-test
  passed. Machine-readable via `--json`. Now a **named CI step**, so gate-12 evidence is linkable rather than a
  line inside "Aggregate gate".
- **The trust-critical index** is itself the per-negative evidence artefact: file, verbatim test title, entry
  point, anchor class, who really built it, the mutation, its run id, and **what it does not prove**.
- **Hosted CI on the exact head, zero skips** is the only evidence for the real-PG suites; local PostgreSQL is
  unreachable here and `tools/ci/preflight.mjs` is what turns a silent skip into a red build.

---

## §5 What this ticket does NOT deliver

| Not delivered | Why |
|---|---|
| *"Isolation re-proven on **staging**"* | **No staging exists in any form** — no deployment config of any kind in this repository. ACBP-P7-006 owns it; owner-gated. |
| Pen test executed; *"high+ issues closed"* | External vendor; `RELEASE-GATES.md:11` places it at the **General MVP** gate, not the closed-beta gate this feeds. There is also no findings source to close against. |
| **#8** revoked integration | Nothing to revoke. **Structurally unprovable** until integrations exist — CDR-080 §7 item 1. |
| **#15** in its canonical wording | No provider key exists in the runtime. The narrower property that will carry the claim is proven instead, and the row says so. |
| **#16** as a CONTROL | The sweep is a **detector**: it catches a producer *after* the write, *in a test*. `boundedMetadata` still accepts secret-shaped values — enforcement is CDR-080 §7 item 9, an owner decision, because audit-or-nothing means a rejection fails the **product operation**. |
| NFR-018's log-pipeline scanner | No log pipeline is deployed. *"Zero findings on secrets" is evidence about the repository, not about the product.* |
| NFR-010's ASVS items | CSRF, HTTP rate limiting and security headers/CSP are absent from `apps/web` **as of `main` at `2c4f0f5`** — the SHA is deliberate, because three tickets to close them were spawned by this ticket and are in flight (`p7-013-csrf-origin-gate`, `p7-013-http-rate-limiting`, `p7-013-security-headers-and-csp`, unpushed at time of writing). Recorded as findings, owner-ruled (CDR-080 §4). **Do not read this row as current state** — read it as what was true when the finding was made. |
| The remaining strengthening items | #7 (no expired-approval case at the dispatcher), #3, #18, #10, #14, and #17's three gaps are real-PostgreSQL work; local PG is unreachable, so they could not be mutation-verified in this session and are **left unmeasured rather than written unverified**. |
| A scripted full-history secret sweep | PROJECT-STATE cites a 2026-07-31 run; no script exists, so the figure is unreproducible prose. CDR-080 §8.4. |

## §6 What must happen before this ticket is Done

1. The remaining strengthening items above, each with a recorded mutation run id.
2. **#8's disposition** (§7.1) — does its impossibility permanently block *"all 20 green"*?
3. **`boundedMetadata` enforcement** (§7.9).
4. The three ASVS implementation tickets.
5. Staging, the pen-test engagement, and launch-gate-12 sign-off — all owner.
