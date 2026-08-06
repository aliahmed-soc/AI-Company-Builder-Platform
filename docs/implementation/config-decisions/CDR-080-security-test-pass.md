# CDR-080 — Security test pass (ACBP-P7-007)

Governing: **NFR-010** (security baseline / pen review), **NFR-018** (secret handling), **NFR-021** (prompt-injection
boundaries); ADR-007, ADR-009, ADR-014; `docs/implementation/SECURITY-VERIFICATION-PLAN.md`;
`docs/implementation/TEST-AND-VERIFICATION-STRATEGY.md` §"Trust-critical negative tests" (the twenty).
Depends on **ACBP-P6-012** (Done). Launch gate 12 (secrets) feeds from this ticket; gate sign-off is the owner's.

> **THIS TICKET'S DELIVERABLE IS A DOCUMENT, AND THAT IS THE PROBLEM.** Its acceptance criterion is *"all suites
> green"*, and **all twenty trust-critical negatives already have something green beside their names.** A report
> citing twenty real files and twenty real `test(...)` titles could be written in an afternoon, be true in every
> line, and be worthless — because a file name and a test title are precisely the two things ACBP-P7-002 proved
> are not evidence. §6 is the mechanism that stops this ticket producing that artefact.

---

## §0 What the investigation found, before any code

An eight-agent investigation mapped each of the twenty canonical negatives to the test that actually proves it —
reading test bodies, not names — and classified the assertion anchor. Summary, and every number here is a
finding rather than a target:

| Class | Count | Items |
|---|---|---|
| Database state / recorded row, through the production entry point | **12** | 1, 2, 5, 6, 9, 11, 12, 13, 17, 20, and 4 within its stated scope |
| **Return-value-only or weaker** | **4** | 7, 10, 14, 19 |
| **Partial** — the claim as worded is not executed | **3** | 3, 16, 18 |
| **Not covered at all** | **2** | 8, 15 |

**Seven of the twenty attribution lines are wrong or incomplete** (#3, #4, #8, #9, #11, #18, #19), plus a wrong
grouping in a second canon document. The list this ticket is judged against is itself unreliable, which is the
first thing the ticket has to fix.

### §0.1 The five findings that shaped this CDR

1. **#8 can never go green, and its canon line asserts a rig that was never built.** `TEST-AND-VERIFICATION-
   STRATEGY.md:40` reads *"rig in P6-002; full when integrations exist"*. There is **no integrations entity
   anywhere** — no table, no migration, no service, no contract; `grep integrations packages/database` returns
   nothing. P6-002's own decision record (CDR-067) never mentions integrations. `REQUIREMENT-TRACEABILITY.csv`
   compounds it: INTEG-003 reads `Covered (Post-MVP; rig in MVP)` verified by *"Revoke-then-use tests"* that do
   not exist. **This is the ACBP-P7-002 artefact class, found in a different ticket.**
2. **#19 contains two assertions that cannot fail.** `silent-fallback-negative.test.ts:103` and `:189` assert
   `not.toContain('SECRET')`. The literal `SECRET` appears nowhere in the harness — the planted value is
   `FAKE_INTERNAL_MARKER = 'PLANTED-INTERNAL-MARKER-9f8e7d6c'`, whose own comment says it is *"Deliberately NOT
   shaped like a real key"*. Unconditionally true; detects nothing.
3. **#10's timing evidence for launch gate 8 measures the wrong interval.** The helper *named* `activateStop`
   (`dispatcher.integration.test.ts:262`) is a raw owner-client `INSERT INTO emergency_stops`, not the production
   use case. The measured ≤5s window excludes the activation path entirely. A test helper whose NAME asserts a
   control it does not exercise — §0's lesson reproduced one level down.
4. **Two green tests would read as #15 coverage to anyone grepping.** `clerk-webhook-handler.test.ts:157-172`
   and `fail-closed-proxy.test.ts:86-88` both carry real `whsec_`/`sk_test_` literals in real `Response` bodies
   with `not.toMatch` assertions. Neither drives a route module; neither uses a configured credential.
5. **#16's audit half is protected by nothing.** `audit.ts` `boundedMetadata` rejects objects, arrays, Errors and
   null — and accepts **any string ≤1024 units with no secret detection**. Safety rests entirely on typed
   factories happening to carry scalars. That is a convention, not a control.

### §0.2 Three mutations survive TODAY — verified in this repository, not inferred

- **#7:** delete nothing — there is simply no expired-approval case at the chokepoint. `Select-String "expired"`
  over `policy-enforcement.integration.test.ts` and `dispatcher.integration.test.ts` returns **0**. Every sibling
  approval state (revoked, spent, mismatched-payload, version-moved, pending, deferred, scheduled) has one.
- **#19:** re-label `strategy.options` as `extraction` and the platform's most material decision becomes
  fallback-eligible **with the whole suite green**.
- **#9:** add a fifth autonomous-work entry point without `readLifecycleDecision` and nothing fails. Approvals
  have `check-approval-port.mjs` and stops have `check-stop-port.mjs`; the nine checkers in `tools/` contain **no
  `check-lifecycle-gate.mjs`**.

A pass reporting "20/20 green" without naming those three survivors is the artefact ACBP-P7-002 was written to
destroy.

---

## §1 What "all 20 trust-critical negatives green" is RULED to mean

The acceptance criterion cannot be met on its literal wording, because **#8 is structurally unprovable** and
**#15 is unbuildable as worded** (see §3). Ruling, so that nobody later reads a partial pass as a full one:

**A negative is GREEN only when its index row carries a recorded mutation with a hosted CI RUN ID** — the exact
source edit that removes or weakens the named control, and the run in which the named test actually went **red**.

- Not "a mutation was considered."
- Not a probe SHA. ACBP-P6-006's probe commit `fe85082` is reachable from no ref today; only its run id
  (`30646208952`) survived, and `P7-002-REVIEW-COVERAGE.md` §2.1 instructs the next ticket to record the run id.
  This ticket is that next ticket.
- A row that cannot produce a red run id is **not green — it is UNMEASURED**, and the report says so in that word.

Anchor classes are a **closed vocabulary**: `database_state | recorded_row | return_value_only | pure_helper_only
| none`. The distribution *is* the finding; prose may not round four weak items up to "green".

---

## §2 The three-way disposition

**(a) Negatives this ticket OWNS and must write** — #15, #16 (audit half), #17 (the useful half).
**(b) Covered, but the evidence is weak** — #7, #10, #14, #19, plus partials #3, #16 (logs), #18. Strengthen.
**(c) Genuinely covered** — run and record only: #1, #2 (write side), #5, #6, #9, #11, #12, #13, #20, and #4/#17
within their stated scope. Evidence for these is a **hosted zero-skip CI run on the exact SHA** — every suite is
`describe.skipIf(!hasTestDatabase)`, local PostgreSQL is unreachable, and a local pass proves only that the files
parse.

### §2.1 On #17: growing the corpus adds almost nothing, and the CDR says so

The refusal is **provenance-based, not detection-based** — nine empty strings produce the same nine denied rows,
and the corpus file states this itself. Adding adversarial strings therefore buys ~zero assurance. What is
actually missing, and what this ticket builds instead:

- a payload in `params.args` — `injectionSignalsIn` reads only `context[].content`;
- the 64,000-character `detectInjection` slice boundary, past which the flagging half of NFR-021 goes blind;
- **untrusted context + a live standing approval**, which `dispatch.ts:249` makes *authorized*
  (`approvalRequired = policy === 'require_approval' || untrusted`) and which no integration test exercises.

That third one is a design property worth stating plainly: **untrusted provenance demands an approval, it does
not forbid the call.** A human approval currently licenses a call proposed under injected content. That is
defensible and probably intended — but it is unwritten, and §7 raises it.

---

## §3 What this ticket CANNOT deliver, stated up front

| Not deliverable | Why |
|---|---|
| *"Isolation re-proven on **staging**"* (the row's Tenant considerations) | **No staging exists in any form** — one checks-only workflow that "runs no releases and changes no environments"; no render.yaml, Dockerfile, Terraform, fly.toml or `infra/`. **ACBP-P7-006** owns creating it and is `Planned`. Owner gate. |
| Pen test executed; *"high+ issues closed"* | External engagement, and `RELEASE-GATES.md:11` places pen review at the **General MVP** gate, not the closed-beta gate this ticket feeds. The row's own word is *prep*. There is also **no findings source to close against**: `git ls-files evidence` returns zero tracked files. |
| **#8** revoked integration | Nothing to revoke. Recorded as deferred-until-integrations-exist; see §7. |
| **#15** in its literal wording (*"provider keys"*) | **No provider key exists in the runtime.** `packages/adapters/src/infisical/index.ts` is `export {};`, the only model adapter is `fake-provider.ts`, the only storage adapter is in-memory, and there is no `credential_ref` table. The buildable claim is narrower and §5 states it as such. |
| NFR-018's **log-pipeline** scanner | No log pipeline is deployed. `tools/check-secrets.mjs` is a source scanner and **structurally cannot** prove #15 or #16, which are runtime properties. The report must say: *"zero findings on secrets" is evidence about the repository, not about the product.* |
| Running any suite as first-hand evidence | Local PostgreSQL unreachable; skipped ≠ green. Hosted CI on an exact SHA only. |
| Wiring `dispatchToolCall` to a production producer | `dispatchToolCall` has **no production caller** — every call site is a test or the slice-F journey — and `workers/runtime.ts:6-10` records the routing as a forward obligation on P5-006/007/008. Production behaviour change; owner gate. |
| The ADR-014 vertical (Infisical vault, `credential_ref`, rotation) and the promised serializer denylist | Several tickets of new architecture requiring a live provider account. §7. |

---

## §4 NFR-010's absent ASVS items — RULED

NFR-010's baseline names **CSRF protection, HTTP rate limiting, and security headers / CSP**. None of the three
exists in `apps/web`. The row's Objective says *"test pass"*, not *"build controls"*.

**Ruled (owner, this session): record each as a finding with its NFR-010 clause and evidence of absence, and
propose separate implementation tickets.** This ticket stays a verification pass; the gaps stop being invisible.
Building them inside a test pass would turn it into a cross-cutting implementation change, and deferring them
silently to the General MVP gate would repeat the defect this ticket exists to find.

---

## §5 Canon corrections — RULED to land in this ticket

**Ruled (owner, this session): land them here.** ACBP-P7-002 corrected `EVENT-CATALOG.md`,
`WORKFLOW-STATE-MACHINES.md` and both traceability matrices as part of its own PR, on the reasoning that leaving
a known-false *"Covered"* cell standing is the defect. The same applies with more force here, because the wrong
lines are the ones **this ticket is judged against**.

`docs/implementation/TEST-AND-VERIFICATION-STRATEGY.md` lines 30-52:

| Line | Item | Correction |
|---|---|---|
| 32 | #3 | `(P5-001/005)` → the enqueue proof is **P5-001a**; `/005` is unearned — `runtime.ts:1` and `0040_worker_runs.ts:1` both *declare* trust-critical #3 while shipping no context-absence test |
| 33 | #4 | `(P5-003)` → **`(P5-003/004)`** — the proof that the enforced list is the worker's own registered allowlist is P5-004's |
| 39 | #7 | annotate: *"cannot execute"* is proven at the repository layer only, never at `dispatchToolCall` |
| 40 | #8 | `(rig in P6-002; …)` → **not built; no integrations entity exists** |
| 41 | #9 | `(P6-007)` → **`(P7-002)`**, citing `gate-14.integration.test.ts` |
| 42 | #10 | *"all scopes"* → **five enforceable scopes**; record that the timed helper is a raw INSERT |
| 43/44 | #11/#12 | under-credit **P5-001b** and **P5-003b** |
| 50 | #18 | `(P5-010/013)` → **`(P5-011/P6-008)`** — P5-010 self-files as *"groundwork"* and its own review coverage says the criterion is *"honestly HALF met"* |
| 51 | #19 | suite is P5-009; **mechanism is P2-003** |

`docs/implementation/SECURITY-VERIFICATION-PLAN.md`: **#9 is on the wrong row.** Line 24 (Emergency stop,
ADMIN-001/002, Gate 8) reads `Trust-critical #9/#10`; line 23 (Deactivation, ACC-004/COMP-006, **Gate 14**),
where #9 belongs, names no trust-critical number. That grouping is almost certainly the origin of the false
`(P6-007)` attribution.

`docs/architecture/REQUIREMENT-TRACEABILITY.csv` — four cells of the class that lied in P7-002:
**INTEG-003** `Covered (Post-MVP; rig in MVP)` against tests that do not exist; **NFR-018** `Covered (MVP)`
naming *negative API tests* that do not exist; **NFR-021** `Covered (MVP)` whose security control names a
*quarantine* store, task flag and event that exist nowhere; **NFR-010** `Covered (MVP)` against a pen review that
has not happened. Each is downgraded with the unmet half named in `Gap or question`.

---

## §6 The mechanism that prevents a rubber stamp

A **machine-checked evidence index** — one row per canonical negative, in the `tools/check-*.mjs` family the
repository already uses for approvals, stops, reset lists and conflict targets:

```
# | statement | attributed to | ACTUALLY built by | file | test title | anchor class | production entry point |
mutation description | mutation CI run id | what it does NOT prove
```

**BUILT in slice 2** as `tools/trust-critical-index.mjs` (the data) and `tools/check-trust-critical-index.mjs`
(the checker), registered in `check:static` and `test:boundaries`, with 20 regression cases in
`tools/tests/check-trust-critical-index.test.mjs`.

The checker parses the twenty items out of `TEST-AND-VERIFICATION-STRATEGY.md` and **fails the build** when:

- an item has no index row, or a row matches no item, or two rows share a number;
- an index `statement` has drifted from the canon line it pins;
- a cited file or `test(...)` title no longer exists — **renaming a test breaks the build rather than the claim**;
- a row claims `measured` **without a hosted CI run id** (a SHA is rejected: the pattern requires ≥6 digits);
- a row records a run id while still calling itself `unmeasured`;
- a row names no mutation — a control nobody tried to break is unmeasured by definition;
- `anchor` or `status` falls outside its closed vocabulary, or `doesNotProve` is blank;
- a `not_covered`/`unprovable` row cites a file or claims a real anchor;
- the count of `unmeasured` rows exceeds `MAX_UNMEASURED`.

### §6.1 One deliberate departure from the plan above, and why

This section originally said the build fails when **any** row's run id is empty. **It does not, and should not.**
A blanket failure on day one — when every row is unmeasured — creates exactly one incentive: relabel rows
`not_covered` until the build goes green. That would make the index lie in the direction this ticket exists to
prevent.

What is enforced instead is **you may not claim a measurement you do not have**, plus a **ratchet**:
`MAX_UNMEASURED` starts at **18** and may only ever decrease. Lowering it is the work of recording a run id;
raising it means a control that was measured stopped being measured, and the checker refuses. Honesty is cheap
here and overclaiming is what costs, so the check is built to make the honest state easy and the false state
impossible.

The checker also carries a **negative self-test** (the house pattern from `check-conflict-targets.mjs`): it
proves its own canon parser still recognises a numbered, wrapped list before reporting a clean tree. A checker
that silently stops matching is the "guard written but never applied" failure one level up.

**This artefact is the durable fix for the P7-002 failure mode**: it converts "an attribution with no test" from
prose that nobody checks into a red build.

### §6.2 What it found immediately

Run against the index on first execution, the checker rejected a citation for item 14 — the title had drifted
from the source, which also escapes an apostrophe. Two corrections came out of one red run: the index now cites
the real title, and the checker unescapes quote escapes before matching, so the index can store human-readable
titles rather than source-level escaping that would drift on the next reflow. **The tool caught its own author
inside a minute of existing**, which is the only kind of evidence this ticket accepts.

Its first clean run reports the honest position, in these words:

> `20 canon items pinned to live tests; 0 MEASURED (red run recorded), 18 unmeasured (ratchet 18), 2 with no
> test. 4 rest on a returned value or weaker.`

Run the probe against the **canonical claim's wording**, not the test's title. The mutation for #7 is *"delete
the `expires_at > now` conjunct AND the approval-usability pre-check, then dispatch an expired approval"*; for
#19 it is *"re-label `strategy.options` as `extraction`"*; for #9 it is *"add a fifth autonomous-work entry point
without `readLifecycleDecision`"*. All three survive today (§0.2).

---

## §7 Open owner decisions

1. **#8's disposition.** Does its structural impossibility block *"all 20 green"* forever, or is it recorded as
   deferred-until-integrations-exist? This decides whether the ticket can ever be `Done`.
2. **Untrusted context + standing approval.** `dispatch.ts:249` lets a human approval authorize a call proposed
   under injected content. Ratify as an accepted design or revisit — it is authorization semantics, unwritten.
3. **Wiring a worker to `dispatchToolCall`.** Would make #17 real end-to-end. Production behaviour change and a
   forward obligation on P5-006/007/008.
4. **`classifySources`** (`workers/research.ts:118`) is exported, has **zero callers**, and `P5-006-REVIEW.md:34`
   justifies keeping it with a present-tense claim that `hasUntrustedContext` consults it. Wire it or delete it;
   either way the review doc is wrong today.
5. **ADR-014's promised serializer denylist and Infisical vault** — built now, or formally deferred with the docs
   corrected? Changes what *"secrets never reach clients"* means as a public guarantee.
6. **Staging** (and any credential or deploy it needs) for the *"isolation re-proven on staging"* clause.
7. **The pen-test engagement**, and what *"high+ issues closed"* is measured against.
8. **Launch-gate 12 sign-off.** This ticket produces evidence; declaring the gate passed is the owner's.
9. **Should `boundedMetadata` REJECT secret-shaped values?** (§8.2.) It accepts them today, so trust-critical
   #16's audit half rests on convention. Enforcing it changes merged behaviour on **every audited write**, and
   because audit-or-nothing binds the audit to the operation, a rejection fails the **product operation** — and
   the high-entropy pattern matches a base64 SHA-256 that audit metadata legitimately carries. Options: reject
   (fail-closed, risks breaking real writes), redact-and-proceed (keeps the write, silently alters a permanent
   record), or leave detection to the test sweep. `metadata-secrets.test.ts` will go red the moment anyone
   implements the first two, so the decision cannot be taken by accident.

---

## §8 Slices

1. **CDR + branch + draft PR** — **DONE.** This document. *Verifiable:* every disposition cites a file:line, and
   the per-class counts match §0.
2. **The machine-checked evidence index + its checker + regression suite** — **DONE** (§6, §6.1, §6.2).
   `tools/trust-critical-index.mjs`, `tools/check-trust-critical-index.mjs`,
   `tools/tests/check-trust-critical-index.test.mjs` (20 cases), wired into `check:static` and
   `test:boundaries`. *Verified:* the checker rejected one of its own author's citations on first run.
3. **#15** — **DONE.** `apps/web/src/server/adversarial/secret-egress.test.ts`: all five `Secret` fields loaded
   with distinct sentinels, **every exported HTTP method of all 23 route modules driven**, body *and* headers
   swept, plus two source guards (the sweep discovers every route; no route calls `.reveal()`). Three controls:
   the detector finds a planted secret, a clean response yields nothing, and the client-safe `publishableKey` is
   explicitly not a secret. **No database required** — `resolveVerifiedIdentity` returns `unauthenticated`
   before any query, so it runs everywhere rather than only where PostgreSQL is reachable.
   *Verified by mutation:* adding `debug: loadClerkConfig().secretKey.reveal()` to `auth-check`'s 401 body turns
   **two** tests red, reporting `GET auth-check/route.ts → 401 carrying: clerkSecretKey` — the method, the
   route, the status and **which** secret, without printing its value. Run id pending slice 7.

### §8.1 Two things building slice 3 found, recorded because both were my own defects

**The ratchet was measuring the wrong thing, and slice 3 tripped it.** `MAX_UNMEASURED` counted `unmeasured`
rows alone. The moment #15 gained its first test the row moved `not_covered → unmeasured`, the count ROSE from
18 to 19, and **the build failed for adding coverage** — the exact opposite of the intended incentive. Replaced
with `MAX_UNPROVEN`, counting every row not yet `measured`: adding a test leaves it flat, recording a red run
lowers it, losing a measurement raises it. A regression case now pins the corrected behaviour.

**The secret scanner caught this suite twice, and both times the file changed rather than the scanner.** First
`generic-credential-assignment`, because the sentinels sat under credential-shaped keys (`clerkSecretKey: '…'`)
— restructured to `{id, canary}` pairs. Then `clerk-secret-key`, because the canary carried key-shaped entropy
— given a deliberately low-entropy suffix, matching the existing `sk_test_adversarial_synthetic` precedent. The
`sk_`/`pk_` prefixes had to stay, since `@acbp/config` validates them and a prefix-free sentinel would fail
config load, leaving the suite green **without ever having driven a route**. Neither finding was allowlisted:
`tools/secret-allowlist.txt` silences a rule for a whole file forever, and the investigation already flagged
that all seven existing entries do exactly that.
4. **#16** — **DONE, in three parts, and one of them was a real hole.**
   - **The logger `message` hole is CONFIRMED and CLOSED.** `logger.ts:109` emitted `fields.message` **verbatim**
     while `metadata` and `error` both went through `redact()`. The covering test honestly named its own scope
     — *"metadata + error"* — so the third field was visible and unasserted. Fixed red-then-green: the new case
     `'sentinel secret never appears in an emitted MESSAGE either'` fails before the one-line change and passes
     after, with a companion case proving redaction is not blanket erasure.
   - **The audit gap is now EXECUTABLE rather than prose** —
     `packages/contracts/src/audit/metadata-secrets.test.ts` pins both what `boundedMetadata` enforces (types,
     key shape, lengths, totals, and that its error names the KEY never the value) and what it does not: it
     **accepts every secret shape tested**, with an anti-vacuity control proving `containsSecret` recognises
     each one. Written to **fail the day enforcement lands**, so whoever adds it must come here deliberately.
   - **A reusable real-PG detector** — `assertNoSecretsInAuditPayloads` / `sweepAuditPayloadsForSecrets` in
     `@acbp/test-support`, sweeping `audit_events` **and** `activity_events`, with 7 regression cases including
     one pinning that **the failure never prints the secret it found** (a security test that leaks its finding
     has moved the leak, not closed it). Any real-PG suite can call it in `afterAll`, which is what makes #16 a
     suite-wide property rather than three hand-written assertions.

### §8.2 Why enforcement was NOT added to `boundedMetadata` — this is §7's new item 9

Making `boundedMetadata` reject secret-shaped values would turn a convention into a control, and that is the
right end state. It was not done here, deliberately:

- It is a **behavioural change to a merged contract on every audited write**, and **audit-or-nothing (ADR-015)**
  means a rejection does not fail the audit — it fails **the product operation**.
- `SECRET_PATTERNS`' high-entropy catch-all (`[A-Za-z0-9_-]{40,}` with mixed case and digits) **matches a
  base64 SHA-256**, which audit metadata legitimately carries. A naive rejection would break real writes.
- A test-pass ticket is the wrong place to take that trade-off silently. **§7 item 9** records it as the
  owner's, and the characterisation test guarantees the decision cannot be forgotten: it goes red the moment
  anyone implements it.

Also worth stating plainly: the sweep is a **detector**, not a control. It catches a producer that wrote a
secret, *after* the write, *in a test*. Nothing prevents one in production.
5. **The strengthening pass** — **#19 DONE**; #7, #3, #18, #10, #14 and #17's three gaps remain.
   **#19's two vacuous assertions are fixed and now detect a leak.** `not.toContain('SECRET')` at `:103` and
   `:189` were unconditionally true — the literal `SECRET` appears nowhere in that harness; the planted value is
   `FAKE_INTERNAL_MARKER`, whose own comment says it is *"deliberately NOT shaped like a real key"*. Both now
   target that marker, and a new **CONTROL** proves the fake still plants it — otherwise repointing them would
   be an improvement nobody could verify, and they would drift back to proving nothing exactly as before.

### §8.3 The mutation that proved nothing, caught before it was recorded

The first mutation for #19 added the leaking field to **`errorResult`**, ran the suite, and **all 9 tests
passed**. The obvious reading is "the assertions are still vacuous". The true reading is that **`errorResult`
serves only the policy-precheck and early-internal paths and is never reached by a provider failure** — the
suite's own path builds its result at the end of `callModel`. Mutating there turns exactly one test red, by
name, and reverting restores green.

**A mutation that does not reach the assertion proves nothing about the assertion**, and it fails in the
direction that looks like a finding — which is worse than failing loudly. This is ACBP-P7-002's false-confirmation
lesson (a probe that went red at *lint* and never reached the tests) arriving through a different door: there,
the probe never ran the tests; here, it ran them and never touched their path. **Before recording a mutation
result, confirm the edited code is on the path the named test executes.** That instruction is now in the index
row itself, which spells out which function to edit and which not to.
6. **Scanner hardening + its first regression suite.** `tools/check-secrets.mjs` has **zero tests** while
   `check-boundaries`, `check-reset-lists` and `check-approval-port` all have them; plus the extension holes,
   allowlist hygiene, a scripted full-history sweep (the 2026-07-31 figure is unreproducible prose), and a named
   CI step so *"zero findings"* is a linkable check.
7. **Report, mutation probe, canon corrections, review, finalization** — with the probe's **run id** recorded.
