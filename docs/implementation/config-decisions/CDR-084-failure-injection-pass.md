# CDR-084 — Failure-injection pass (ACBP-P7-008)

Governing: **NFR-005** (reliability and resumability), **NFR-019** (model-provider resilience); ADR-008
(Postgres-backed durable jobs and checkpointed workflows), ADR-011 (internal model-gateway contract).
Canon: `docs/architecture/FAILURE-AND-RECOVERY.md` — the 16-row matrix, lines 5–22.
Depends on **ACBP-P6-012** (Done). Release gate: `RELEASE-GATES.md:10`, Closed beta, *"Kill-and-resume,
replay-zero-duplicates, failure-injection pass; restore drill within RTO/RPO"*.

**NFR-020 is deliberately NOT governing this ticket. See §5.**

> **THE MATRIX IS REAL, AND THAT IS THE DIFFERENCE FROM ACBP-P7-007.** That ticket found the twenty-item list it
> was judged against unreliable — seven wrong attributions, two items with no test at all. This list is
> *good*: sixteen numbered rows, each specifying detection, state transition, retry eligibility, idempotency
> requirement, user-facing status, audit, usage behaviour, manual recovery and compensation. `README.md:17`
> identifies it by that count; CDR-059:14 calls it *"the specification"*. Nothing here needs inventing.
>
> **What cannot be met is the acceptance criterion**, because several rows have **no subject to inject a fault
> into**. That is a finding about the criterion, not about the matrix.

---

## §0 What the investigation established, before any code

### §0.1 The criterion "16-scenario matrix green" is not currently achievable

Four rows have no implemented subject, and one of those cannot be built at all:

| Row | Failure | Why it cannot go green today |
|---|---|---|
| **5** | Queue/job-store outage | No injected coverage found. `enqueue-job.integration.test.ts` covers idempotent enqueue, not store *unavailability*. |
| **6** | Database outage | No injected coverage found. The row's own content — *"Platform read-only/unavailable; **no partial writes**"* — is an infrastructure property, not a code path. |
| **10** | Revoked integration | **No subject exists.** There is no integrations entity anywhere: no table, no migration, no service, no contract, no integration value in `TOOL_DENIAL_REASONS`. This is the identical absence ACBP-P7-007 recorded for trust-critical #8, and the row's own `Failure` cell for row 8 says *"(future external)"*. |
| **14** | Audit-event failure | No injected audit-write failure found. |

And four more are partly unserved **by canon's own admission**:

| Row | Failure | The gap |
|---|---|---|
| **2** | Provider outage | Fallback is genuinely proven. The row's *other* half — *"tasks queue"*, the *"Honest banner: provider degraded"*, and *"Operator: drain queue on recovery"* — has no implementation. CDR-059:98 already records this and assigns it to P6/observability. |
| **8** | Tool/API failure | The runtime collapses **every** thrown step into `provider_error`, so a tool failure is indistinguishable from a provider fault. CDR-059:103 names this as the one row citing TASK-006 by name, and unserved. |
| **9** | Expired authorization | Proven at the repository layer only. `TEST-AND-VERIFICATION-STRATEGY.md:39` records that both dispatcher suites contain **zero** expired-approval cases — the same gap ACBP-P7-007 left as trust-critical #7, `not_covered`. |
| **16** | Company pause during execution | The row asserts *"Safe-stop: current tool call completes, then halt"*. `WORKFLOW-STATE-MACHINES.md:35` states the opposite about today's system: *"'in-flight safe-stop' is NOT enforced by pausing. Pause refuses new work; it does not terminate a run already executing. The durable-stop sweep that would is unbuilt."* **Row 16 cannot go green as written.** |

### §0.2 Three coverage claims that do not hold

1. **`TEST-AND-VERIFICATION-STRATEGY.md:23` names the mocking policy for this layer as "fault-injecting fakes".
   The shared fakes largely do not inject faults.** In `packages/test-support/src/adapters/fakes.ts`,
   `FakeModelProvider` **always returns `finishStatus: 'completed'`** — its only non-success path is caller
   abort. `FakeObjectStorage.put` has no failure mode at all. Only `FakeSecretProvider` and
   `FakeIdentityProvider` carry an `unavailable` mode. The real gateway fault injection lives in **inline stubs
   inside one test file** (`model-gateway.test.ts`, `describe('callModel — fault injection …')`), not in the
   shared rig the strategy document describes as existing. **P7-008 has to build the thing that was documented
   as already built.**
2. **NFR-019 is marked `Covered` in both traceability matrices while half its own acceptance criterion is
   unimplemented.** `REQUIREMENTS.csv:140` requires *"Simulated provider outage: tasks queue, status is honest,
   recovery drains the queue without duplicates"*, and `REQUIREMENT-TRACEABILITY.csv:140` names the approach
   *"Simulated-outage queue/drain tests"*. What exists is fallback. There is no queue-on-outage, no provider-health
   banner, and no drain-on-recovery.
3. **`evidence/` is an empty directory.** The ticket's verification procedure is *"Scenario evidence"*, and the
   repository has no established format or precedent for it. §6 decides one rather than inventing a folder nobody
   will read.

### §0.3 The precedent this ticket must not repeat

`CDR-059-failure-detail.md:92`: *"Both review passes independently found the header's 'all 16 rows' to be a scope
overclaim, so here is the count."* **A previous ticket already claimed this matrix and was caught.** Its §6 is a
row-by-row table of the twelve rows it did not serve, with owners — the single most valuable existing artefact
for this work.

**But it has aged, and copying it would be its own error.** CDR-059 §6 assigns row 7 to *"Needs artifacts to
exist | ACBP-P5-011"* and rows 9, 12, 13, 15/16 to Phase 6 / P5-001b-c / P5-014 / P6-007 — **all of which have
since shipped.** Row 7 is now the *strongest* real fault injection in the repository. So §2 below re-derives
current state from the code rather than inheriting a snapshot, which is the ACBP-P7-007 lesson (*verify with a
different anchor*) applied to the one document that looks most authoritative.

---

## §1 What "16-scenario matrix green" is RULED to mean

The criterion cannot be met on its literal wording (§0.1). Ruling, so nobody later reads a partial pass as a full
one:

**A matrix row is GREEN only when a test INJECTS the failure at a production entry point and asserts the row's
own documented consequence — with a recorded mutation carrying a hosted CI RUN ID.**

Three clauses, each load-bearing:

- **INJECTS.** Constructing an already-failed input object, or writing an already-failed row, is not injection.
  CDR-059:113 makes exactly this complaint about its own tests: *"Nothing here injects anything: the contract
  tests construct input objects and the integration tests write already-failed rows."* The fault must be
  introduced into a dependency the production path calls, and the production path must be the thing that
  reacts.
- **THE ROW'S OWN CONSEQUENCE.** Each row specifies a state transition, a user-facing status, an audit event and
  a usage behaviour. Asserting only that "it failed" proves the least interesting cell. Where a row names a
  durable consequence (a recorded row, a released credit, a suppressed duplicate), that is what the test asserts.
- **A RECORDED MUTATION WITH A RUN ID.** Inherited verbatim from CDR-080 §2, for the reason established there:
  ACBP-P6-006's probe commit `fe85082` is reachable from no ref today, and only its run id survived. A row
  without a red run is **UNMEASURED**, in that word.

**Rows that cannot be injected are recorded as ABSENCES with a named reason and owner — never as passes, and
never silently omitted.** That is the owner's ruling for this ticket: *prove what exists, record the absences.*

---

## §2 Per-row disposition — the starting inventory

**This table is PROVISIONAL and slice 1 is its verification.** It was derived by an investigation reading test
bodies, not test names, but ACBP-P7-007 established that citations in this repository rot: two of its own
corrections cited line numbers computed against pre-edit files. **Every file:line below is re-checked in slice 1
before any of it is relied on**, and the disposition column may move as a result.

| Row | Failure | Current evidence | Provisional disposition |
|---|---|---|---|
| 1 | Model timeout | `model-gateway.test.ts` — per-class timeout on a hanging provider; deadline follows task class not request field; bounded retry then success; exhaustion → normalized error; terminal errors not retried. `runtime.integration.test.ts` — duration overrun halts with `timeout` | **INJECTABLE — strong.** Confirm it drives production and mutation-measure it |
| 2 | Provider outage | Fallback proven (`model-gateway.test.ts`, `silent-fallback-negative.test.ts`, both-providers-fail from P5-009) | **PARTIAL.** Fallback half injectable; queue / banner / drain **absent** (CDR-059:98, P6/observability) |
| 3 | Invalid structured output | `model-gateway.test.ts` — bounded re-ask then accepted; still-invalid after cap → `invalid_output`; `structured-output-conformance.test.ts` | **INJECTABLE — strong** |
| 4 | Worker crash | `coordinator.integration.test.ts` — silent worker past grace → `worker_lost`; live run never reclaimed; heartbeat cannot revive a reclaimed run; sweep is one-instant and company-scoped. `checkpoint.integration.test.ts` — kill and resume. `retry.integration.test.ts` — dead-letter | **INJECTABLE — strong.** The NFR-005 anchor |
| 5 | Queue/job-store outage | none | **ABSENT.** No injection point; needs a job-store seam |
| 6 | Database outage | none | **ABSENT.** Infrastructure property; §7 asks whether it is testable here at all |
| 7 | Object-storage failure | `artifacts/persist.integration.test.ts` — a write that THROWS refuses and writes no row; a write **reporting success while storing nothing** refuses; a truncated write refuses; retry after refusal ends with exactly one artifact; no orphaned object on tenancy refusal | **INJECTABLE — strongest in the repo.** Real injection of a *lying* dependency, not just a throwing one |
| 8 | Tool/API failure | `runtime.integration.test.ts` records a throwing step as `provider_error` — which is the defect | **UNSERVED.** Requires splitting tool failure from provider fault (CDR-059:103) |
| 9 | Expired authorization | repository layer only; zero dispatcher cases | **PARTIAL.** Same gap as trust-critical #7 |
| 10 | Revoked integration | no entity exists | **UNBUILDABLE.** Record as absence; identical to trust-critical #8 |
| 11 | Duplicate delivery | `idempotency/replay.integration.test.ts` — re-delivered enqueue creates no second job **and** records the suppression; webhook re-delivery; same event id with a different payload is a security conflict; re-delivered metered call leaves one usage row; the suppression never carries the key | **INJECTABLE — strongest.** CDR-074 §0 already requires the duplicate be actually delivered |
| 12 | Partial completion | `checkpoint.integration.test.ts` | **PARTIAL.** Resume proven; *"labeled partial"* surface not found |
| 13 | Usage-recording failure | `model-gateway.test.ts` — a usage-write failure aborts the call and withholds the output | **INJECTABLE — good.** Real injection, fail-closed |
| 14 | Audit-event failure | none injected | **ABSENT.** CDR-059:108 calls it "fail-closed already"; nothing proves it |
| 15 | Emergency stop | CDR-072; `runtime.integration.test.ts`; `coordinator.integration.test.ts` bounded safe-stop | **PARTIAL.** Only 5 of 7 scopes enforceable; the ≤5s measurement excludes activation (`TEST-AND-VERIFICATION-STRATEGY.md:42`) |
| 16 | Company pause | `gate-14.integration.test.ts` (P7-002); `readLifecycleDecision` at four call sites | **PARTIAL — and the row overstates the system.** New work refuses; in-flight halt is unbuilt (`WORKFLOW-STATE-MACHINES.md:35`) |

Provisional totals: **6 injectable**, **5 partial**, **4 absent**, **1 unbuildable**. Not 16 green, and this
document says so on its first page.

---

## §3 The mechanism: a machine-checked failure-scenario index

Mirroring `tools/trust-critical-index.mjs` (ACBP-P7-007, CDR-080 §6), which converted *"an attribution with no
test"* from prose nobody checks into a red build.

**New: `tools/failure-scenario-index.mjs` + `tools/check-failure-scenario-index.mjs`, wired into `check:static`.**
Sixteen rows, one per matrix row, each carrying:

```
number          the matrix row number
failure         MUST match the matrix's `Failure` cell verbatim — pinned by the checker
consequence     the specific cell of the row this test asserts (transition / status / audit / usage)
status          measured | unmeasured | absent | unbuildable
injection       HOW the fault enters: which dependency is made to fail, at which seam
anchor          database_state | recorded_row | return_value_only | pure_helper_only | none
file            repo-relative path of the proving suite ('' when none)
testTitle       verbatim title, and the checker requires it be attached to a LIVE test( / it( call
entryPoint      the production function the test drives
mutation        the exact edit that should make `testTitle` fail
mutationRunId   the hosted CI run in which it did
doesNotProve    the limit of this row's evidence — never blank
```

**A separate tool rather than a widened one, and the reason is specific**: the trust-critical checker parses a
numbered Markdown *list* under a named heading; the failure matrix is a *table* with a different column
structure. Forcing one parser to do both would make the P7-007 gate more fragile to serve a different document —
and that gate is now load-bearing. **What IS shared is extracted rather than copied**: `liveTestCallFor` (the
attachment check, including the escaped-apostrophe handling that its first version got wrong), the anchor
vocabulary, and the run-id rules move to `tools/lib/test-citation.mjs` and both checkers import them. Duplicating
a guard is how guards drift apart.

**The ratchet is inherited too**: `MAX_UNPROVEN` compared against `origin/main`, so it cannot rise — the property
that CDR-080 §6.1 records as having claimed an enforcer it did not have until ACBP-P7-007's second review pass
built one.

---

## §4 The shared fault-injection rig

§0.2 item 1 established that the "fault-injecting fakes" the strategy document names largely do not inject
faults. This ticket builds them, in `@acbp/test-support`, because a rig that lives in one test file's inline
stubs cannot be reused by the fifteen other rows:

- **`FakeModelProvider` gains failure behaviours** — it currently always reports `completed`. Needed: each
  category in ADR-011's closed taxonomy (`timeout · rate_limited · provider_unavailable · invalid_output ·
  content_refused · budget_exceeded · internal`), plus *hang* (for the timeout row, which must be a real deadline
  and not a thrown error).
- **`FakeObjectStorage` gains failure modes** — throw, and the more interesting one the artifact suite already
  proves in an inline stub: **report success while storing nothing**. A dependency that lies is a different test
  from a dependency that fails, and row 7 is the only place in the repo that currently distinguishes them.
- **A usage-ledger failure seam** for row 13 and an audit-write failure seam for row 14.

**Every new failure mode ships with a control proving the fake still succeeds when not told to fail** — without
it, a rig that silently broke would turn every negative into a vacuous pass, which is the exact defect class
ACBP-P7-007 spent its length on.

---

## §5 NFR-020 is removed from this ticket

The backlog row lists `NFR-005;NFR-019;NFR-020`. **NFR-020 does not belong**, on the owner's ruling, and the
evidence is that the repository already says so three times:

| Source | What it says about NFR-020 |
|---|---|
| `product-specification/REQUIREMENTS.csv:141` | MVP status **Post-MVP** |
| `REQUIREMENT-TO-TICKET-TRACEABILITY.csv:141` | Verification ticket `—`, release gate `—`, coverage status **"Deferred by approved scope"** |
| `REQUIREMENT-TRACEABILITY.csv:141` | Governing ADR is **ADR-014** — which P7-008 does not cite |

So one third of the ticket's stated requirement basis was scope the approved plan had already deferred, governed
by an ADR the ticket does not name. Its subject is row 10, whose entity does not exist.

**Action:** the backlog row's `Requirement IDs` becomes `NFR-005;NFR-019`, and this contradiction is recorded as
a finding rather than silently fixed — a requirement appearing in a ticket's basis while being deferred
everywhere else is a defect in the traceability, and the next reader deserves to know it happened.

---

## §6 "Scenario evidence" — what the verification procedure produces

`evidence/` is empty and the procedure names no format, so this ticket defines one. **The index in §3 IS the
evidence artefact.** Per row: the injection seam, the production entry point, the asserted consequence, the
mutation, its run id, and what it does not prove. No separate folder of screenshots or logs — those are the
artefact class ACBP-P7-002 proved unreliable, because nothing checks them.

**A generated `docs/implementation/P7-008-SCENARIO-EVIDENCE.md` is rendered FROM the index**, so the human-readable
table cannot drift from the machine-checked one. Rendering it, rather than writing it, is the whole point.

---

## §7 Open owner decisions

1. **Is row 6 (database outage) testable in this repository at all?** Its consequence is *"Platform
   read-only/unavailable; no partial writes"*. The no-partial-writes half is provable — transaction atomicity
   under an injected mid-transaction failure. The platform-status half is infrastructure. Options: prove the
   atomicity half and record the rest as an ops absence; or declare the whole row ops-owned.
2. **Row 5 (queue/job-store outage) needs a seam that does not exist.** Making the job store injectable means a
   test-only fault hook in a production path. That is a real design change with a real risk — a hook that exists
   in production is a hook that can be triggered in production. Options: build the seam behind a test-only
   boundary; test at the repository layer only and record the gap; or defer the row.
3. **Row 16 asserts behaviour the system does not have.** The matrix says in-flight safe-stop; the state-machine
   doc says pause does not terminate a running run. **One of the two canon documents is wrong.** Either the
   matrix row is aspirational and should be marked so, or the durable-stop sweep is owed. This is an architecture
   decision, not a test decision.
4. **Does NFR-019 stay `Covered` in two traceability matrices** while its queue/banner/drain half is
   unimplemented? ACBP-P7-007 downgraded four such cells; this is the same call on a fifth.
5. **Row 8 requires splitting tool failure from provider fault in the runtime** — a production behaviour change
   (a new normalized category and a changed error path), not test-only work. In scope for a "failure-injection
   pass", or its own ticket?
6. **Launch-gate sign-off.** `RELEASE-GATES.md:10` names the failure-injection pass at the Closed beta gate.
   This ticket produces evidence; declaring the gate passed is the owner's.

---

## §8 Slices

1. **CDR + branch + draft PR + per-row verification.** This document, and slice 1's real work: **re-check every
   file:line in §2 against the code**, because the table is provisional and citations rot. Output is a §2 that
   has been verified rather than inherited. *Verifiable:* each row's disposition cites a test body that was read.
2. **The shared fault-injection rig** (§4) in `@acbp/test-support`, each failure mode with its success control.
   *Verifiable:* a rig test proves each mode both fails when told to and succeeds when not.
3. **The index + checker + regression suite** (§3), with `tools/lib/test-citation.mjs` extracted and the
   trust-critical checker migrated onto it. *Verifiable:* the P7-007 gate still passes on the shared helper, and
   the new checker has a negative self-test plus cases for every failure mode it claims to catch.
4. **The injectable rows** — 1, 3, 4, 7, 11, 13 driven through production entry points against real PostgreSQL
   where the consequence is durable. *Verifiable:* each asserts the row's own documented consequence, not merely
   that something failed.
5. **The partial rows** — 2, 9, 12, 15, 16 — proving the half that exists and recording the half that does not,
   in the row's `doesNotProve`.
6. **The mutation probe**: one disposable branch, type-safe and lint-clean deliberately (a mutation that dies at
   the static gate never reaches the tests, which is how ACBP-P7-002's first probe produced a false
   confirmation), one run id recorded per measured row. **Surgical mutations only** — ACBP-P7-007's probe took
   collateral damage and made its own red run harder to read.
7. **Docs, rendered evidence, the backlog NFR-020 correction, independent review before reporting complete,
   finalization.**

---

## §9 Lessons carried in from ACBP-P7-007, so they are not re-learned

- **A green checkmark and a test title are the same artefact to a reader and different artefacts to a machine.**
  Only one can be verified; the index is the machine-readable one.
- **Verify with a different anchor.** CDR-059 §6 is the most authoritative-looking inventory of this matrix and
  it has aged out of correctness (§0.3). Re-derive from code.
- **Check the line number after your own edit lands.** Two P7-007 corrections cited positions computed against
  pre-edit files.
- **A correction is the most likely place to re-commit the defect it describes.** P7-007 did it three times, once
  in a literal byte — a comment explaining a NUL-byte fix that itself contained a NUL.
- **A partial local run is not a preview of CI**, and a red build that executed no steps is not evidence in
  either direction.
- **Name the commit, not the state.** A status word goes stale at merge; a SHA does not.
