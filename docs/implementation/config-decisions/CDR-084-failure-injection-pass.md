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

**CORRECTED IN SLICE 1. This section originally listed FOUR rows as having no coverage. Two of those were
wrong, and the errors ran in the expensive direction — toward building things that already exist.** The
original text is kept below each correction, because a disposition table that quietly improves is exactly the
artefact class this repository has learned not to trust.

| Row | Failure | Verified position |
|---|---|---|
| **5** | Queue/job-store outage | **ABSENT — confirmed.** All 27 tests in `enqueue-job.integration.test.ts` were read: tenancy stamping, three redundant refusal layers, authz, immutability, state vocabulary, idempotency. None simulates store *unavailability*. **And it is worse than absent**: searching `dequeue\|claimJob\|pickup\|pollJobs\|nextJob\|reserveJob` finds **no implementation at all**. The only hit is `migrations/0031_jobs.ts:61`, an index comment describing *"the runner's pickup path"* for a runner that does not exist. Row 5's detection is *"Enqueue/pickup errors"*, and **half of that has no code path to fail.** |
| **6** | Database outage | **~~ABSENT~~ → PARTIAL.** The *"no partial writes / Transactions atomic"* half is genuinely covered by injection: `database.integration.test.ts:140` throws inside `withTransaction` and asserts the table is gone *and* the pool still healthy; `:92` rejects a migration mid-sequence and asserts the prior one rolled back and the next never ran. `client.test.ts:31` points the pool at a dead port for a real ECONNREFUSED — but asserts a returned health object, not a degraded product surface. **Uncovered: the "Platform read-only/unavailable" transition.** Nothing asserts a user-facing surface degrades. |
| **10** | Revoked integration | **UNBUILDABLE — confirmed.** No integrations entity anywhere; `TOOL_DENIAL_REASONS` has 11 values (`not_registered`, `no_allowlist`, `not_allowlisted`, `emergency_stopped`, `stop_unavailable`, `policy_denied`, `policy_unavailable`, `approval_invalid`, `approval_required`, `untrusted_context`, `company_not_active`) and none is integration-related. `tools/trust-critical-index.mjs` already records the same absence as `unprovable`. |
| **14** | Audit-event failure | **~~ABSENT~~ → STRONG. THIS WAS THE EXPENSIVE ERROR.** There are roughly **25** injected audit-write-failure tests spanning jobs, members, companies, memory, interviews, strategy, planning, understanding, tasks, context, admin, stops, tool dispatch, artifacts, policy, usage and the adversarial tenancy suite. The fault is a documented test seam (`planning/task-generation.ts:74`: *"TEST SEAM ONLY: override the in-tx audit writer to force a failure"*), substituted into real production entry points, asserting **database state**. One of them is at `enqueue-job.integration.test.ts:99` — *"audit-or-nothing: when the audit write fails, NO job row survives (ADR-015)"* — **in the very file this document cited as evidence for row 5.** Building "audit failure blocks the operation" would have rebuilt mature, deliberately designed work. Only the row's *"low-risk queued with alert"* branch is uncovered, plus its *"Audit writes idempotent"* note. |

And four more are partly unserved **by canon's own admission**:

| Row | Failure | The gap |
|---|---|---|
| **2** | Provider outage | Fallback is genuinely proven. The row's *other* half — *"tasks queue"*, the *"Honest banner: provider degraded"*, and *"Operator: drain queue on recovery"* — has no implementation. CDR-059:98 already records this and assigns it to P6/observability. |
| **8** | Tool/API failure | The runtime collapses **every** thrown step into `provider_error`, so a tool failure is indistinguishable from a provider fault. CDR-059:103 names this as the one row citing TASK-006 by name, and unserved. |
| **9** | Expired authorization | Proven at the repository layer only. `TEST-AND-VERIFICATION-STRATEGY.md:39` records that both dispatcher suites contain **zero** expired-approval cases — the same gap ACBP-P7-007 left as trust-critical #7, `not_covered`. |
| **16** | Company pause during execution | The row asserts *"Safe-stop: current tool call completes, then halt"*. `WORKFLOW-STATE-MACHINES.md:35` states the opposite about today's system: *"'in-flight safe-stop' is NOT enforced by pausing. Pause refuses new work; it does not terminate a run already executing. The durable-stop sweep that would is unbuilt."* **Row 16 cannot go green as written.** |

### §0.2 Three coverage claims that do not hold

1. **~~The shared fakes largely do not inject faults.~~ RETRACTED IN SLICE 1 — THIS FINDING WAS FALSE, AND IT IS
   THE MOST INSTRUCTIVE THING IN THIS DOCUMENT.** The original claim was that `TEST-AND-VERIFICATION-STRATEGY.md:23`
   promises *"fault-injecting fakes"* that do not exist, and that P7-008 would have to build them. **The rig
   exists, in `@acbp/adapters`, and it is good:**
   - `FakeModelProvider` (`adapters/src/model/fake-provider.ts:66`) injects five normalized failures
     (`timeout`, `rate_limited`, `provider_unavailable`, `content_refused`, `internal`), supports
     `{ kind: 'hang', ms }` to drive **real deadline enforcement** rather than a thrown error, and takes a
     `script[]` consumed one-per-call so a test can drive whole retry / re-ask / fallback sequences.
   - `InMemoryObjectStorage` (`adapters/src/storage/in-memory-storage.ts:39`) can **lie**: `failNextPut` throws,
     `dropNextPut` returns plausible success metadata and stores nothing, `truncateNextPut` stores fewer bytes
     than it reports. Its own header says so. A dependency that lies is a different test from one that fails,
     and this is the only place in the repository that distinguishes them.

   **How the claim went wrong is the finding worth keeping. There are TWO classes named `FakeModelProvider`.**
   The one in `@acbp/test-support` (`fakes.ts:173`) always returns `finishStatus: 'completed'` — its only
   non-success path is caller abort — and `FakeObjectStorage.put` there has no failure mode either. An
   investigation looking for the fault-injection rig found the weaker same-named pair, concluded it did not
   exist, and that conclusion was written into this CDR and its PR body before slice 1 read the imports.

   **Two identically-named classes with opposite capability is a trap that already caught someone**, and the
   next person to reach for a "fake model provider" to write a failure test will reach for the same wrong one.
   §4 now proposes making that impossible rather than building what already exists.
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
| 5 | Queue/job-store outage | none; and **no pickup path exists to fail** | **ABSENT — verified.** The only true absence in the matrix |
| 6 | Database outage | `database.integration.test.ts:140` throw inside `withTransaction` → table gone, pool healthy; `:92` failing migration → prior rolled back, next never ran; `client.test.ts:31` real ECONNREFUSED → structured, credential-free health failure | **PARTIAL — corrected from ABSENT.** Atomicity genuinely injected; the read-only/unavailable *transition* is not |
| 7 | Object-storage failure | `artifacts/persist.integration.test.ts` — a write that THROWS refuses and writes no row; a write **reporting success while storing nothing** refuses; a truncated write refuses; retry after refusal ends with exactly one artifact; no orphaned object on tenancy refusal | **INJECTABLE — strongest in the repo.** Real injection of a *lying* dependency, not just a throwing one |
| 8 | Tool/API failure | `runtime.integration.test.ts` records a throwing step as `provider_error` — which is the defect | **UNSERVED.** Requires splitting tool failure from provider fault (CDR-059:103) |
| 9 | Expired authorization | repository layer only; zero dispatcher cases | **PARTIAL.** Same gap as trust-critical #7 |
| 10 | Revoked integration | no entity exists | **UNBUILDABLE.** Record as absence; identical to trust-critical #8 |
| 11 | Duplicate delivery | `idempotency/replay.integration.test.ts` — re-delivered enqueue creates no second job **and** records the suppression; webhook re-delivery; same event id with a different payload is a security conflict; re-delivered metered call leaves one usage row; the suppression never carries the key | **INJECTABLE — strongest.** CDR-074 §0 already requires the duplicate be actually delivered |
| 12 | Partial completion | `checkpoint.integration.test.ts` | **PARTIAL.** Resume proven; *"labeled partial"* surface not found |
| 13 | Usage-recording failure | `model-gateway.test.ts` — a usage-write failure aborts the call and withholds the output | **INJECTABLE — good.** Real injection, fail-closed |
| 14 | Audit-event failure | ~**25** injected audit-write failures across jobs, members, companies, memory, interviews, strategy, planning, understanding, tasks, context, admin, stops, dispatch, artifacts, policy, usage and the adversarial tenancy suite — e.g. `enqueue-job.integration.test.ts:99` *"audit-or-nothing: when the audit write fails, NO job row survives (ADR-015)"*. `usage-correction-service.integration.test.ts:404` even carries the anti-vacuity control | **STRONG — corrected from ABSENT.** Only the *"low-risk queued with alert"* branch and *"Audit writes idempotent"* are uncovered |
| 15 | Emergency stop | CDR-072; `runtime.integration.test.ts`; `coordinator.integration.test.ts` bounded safe-stop | **PARTIAL.** Only 5 of 7 scopes enforceable; the ≤5s measurement excludes activation (`TEST-AND-VERIFICATION-STRATEGY.md:42`) |
| 16 | Company pause | `gate-14.integration.test.ts` (P7-002); `readLifecycleDecision` at four call sites | **PARTIAL — and the row overstates the system.** New work refuses; in-flight halt is unbuilt (`WORKFLOW-STATE-MACHINES.md:35`) |

**Totals after slice-1 verification: 7 strong, 7 partial, 1 absent, 1 unbuildable** — 7+7+1+1 = 16.

The provisional table said *6 injectable, 5 partial, **4 absent**, 1 unbuildable*. Two of those four absences
were wrong. **The correction runs almost entirely in one direction: the system is better covered than the
investigation believed**, and every error would have cost build effort rather than shipped a false claim. That
is the safer direction to be wrong in, and it is not an accident — it is what verifying before building is for.

**The single genuine absence is row 5**, and it is absent twice over: no outage injection, and no pickup code
path that could fail.

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

**REWRITTEN IN SLICE 1. This section originally said "this ticket builds them". It does not — they exist
(§0.2 item 1).** What is actually needed is much smaller, and one item is a hazard rather than a gap:

1. **Remove the naming trap — DONE IN SLICE 2, by rename (option b).** Option (a), deleting test-support's pair
   and re-exporting the adapters ones, was ruled out on evidence: the sole consumer is
   `adapters/src/adapter-contracts.test.ts` (ACBP-P0-019), which exercises **lifecycle** conformance
   (`init`/`shutdown`/`isStarted`) — and the adapters `FakeModelProvider` does not implement `AdapterLifecycle`.
   The two fakes do genuinely different jobs; only the name was wrong.

   `FakeModelProvider` → **`AlwaysSucceedsModelProvider`**, `FakeObjectStorage` → **`NonFailingObjectStorage`**,
   both in `@acbp/test-support`, with a header naming the limitation and pointing at the real rig. One consumer
   updated. ~20 core suites were untouched because they already imported the adapters one.

   **And the trap cannot come back**: `tools/check-duplicate-exports.mjs` (new, in `check:static`) fails the
   build if any exported class name is defined in **two packages**. A survey found exactly one such duplicate
   across 52 exported classes — this one — so the general rule ships without exceptions. It has a negative
   self-test, refuses to pass when it can see no classes at all, and carries 13 regression cases including the
   shapes that must *not* be flagged: same name twice inside one package, a class in a `.test.ts`, a barrel
   re-export, and a non-exported class.
2. **A usage-ledger failure seam for row 13** — currently injected inline in `model-gateway.test.ts` via a
   `recordUsage` that rejects. That is genuine injection and needs no rig, but a shared helper would let the
   other metered paths assert the same fail-closed property.
3. **Nothing is needed for row 14.** The `auditWriter?` test seam is already documented, deliberate, and used at
   ~25 sites.
4. **Row 5 needs a job-store seam that does not exist** — and §7 item 2 asks whether it should, because a fault
   hook reachable in production is a liability. Note the sharper problem: **there is no pickup implementation at
   all**, so half of row 5's detection has nothing to hook.

**Any new failure mode ships with a control proving the fake still succeeds when not told to fail.** The
existing rig already models this — `usage-correction-service.integration.test.ts:404` pairs its audit-failure
case with *"the identical call with a working audit writer DOES record one"*. Without such a control a silently
broken rig turns every negative into a vacuous pass, which is the defect class ACBP-P7-007 spent its length on.

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
5. **Row 8 requires splitting tool failure from provider fault — and it needs a MIGRATION, not just code.**
   `runtime.ts:271` is a bare `catch {}` that finishes with `failureCategory: 'provider_error'` unconditionally.
   `RUN_FAILURE_CATEGORIES` is a **closed five-value set** (`worker_lost`, `timeout`, `provider_error`,
   `policy_blocked`, `internal_error`) with no `tool_error`, mirrored by CHECK constraints on **two** tables
   (`0035_task_runs.ts:64`, `0040_worker_runs.ts:60`) and pinned by a test asserting the constant and the CHECK
   are the same set. So the change is: contract constant + migration on two tables + the runtime/coordinator
   guards. In scope for a "failure-injection pass", or its own ticket? (This item originally said "a production
   behaviour change … not test-only work" and understated it by omitting the migration.)
6. **Launch-gate sign-off.** `RELEASE-GATES.md:10` names the failure-injection pass at the Closed beta gate.
   This ticket produces evidence; declaring the gate passed is the owner's.

---

## §8 Slices

1. **CDR + branch + draft PR + per-row verification — DONE.** The verification was the point, and it paid:
   **two of four claimed absences were false** (rows 6 and 14), the "build the fault-injection rig" premise was
   **retracted entirely** (§0.2 item 1), and row 8's fix turned out to need a **migration** rather than only a
   code change. Every correction moved toward *less* work, which is the direction verification is supposed to
   move a plan.
2. **Close the naming trap** (§4 item 1) and add the shared usage-failure helper. Much smaller than the original
   slice. *Verifiable:* it is no longer possible to import a `FakeModelProvider` that cannot fail without
   knowing you did.
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

---

## §10 What slice 6 found before it could run — the `mutation` column was mostly wishes

Slice 6 is the probe. Before applying anything, the `mutation` column of BOTH evidence indexes was read as what
it claims to be — *the exact edit someone applies to make the cited test go red*. **Eighteen of the
thirty-three rows carrying a mutation could not be applied by anyone who had not written them.**

> "Widen the heartbeat grace to infinity." · "Skip the stop check at the step boundary."
> "Remove the idempotency read-back." · "Drop the usage-event uniqueness constraint."

None names a function, a file or a column. Running one requires first re-deriving the author's intent, and
re-derivation is precisely where a probe reddens a *different* test than the row it is filed under — the defect
ACBP-P7-007 shipped on row 19 and two human reviews had to catch.

**The column is now machine-checked.** `checkMutationNamesRealCode` requires every mutation to name at least one
camelCase / snake_case / SCREAMING_SNAKE symbol, or a source filename, that **exists in non-test source**. Both
checkers use it, and both exit 2 rather than 0 if the source walk finds zero files — an empty corpus would report
every correct row as naming nothing, and a guard that cannot see its target must say so.

Plain English words and bare acronyms are deliberately not symbols. If `company` or `RLS` counted, every
sentence in the column would pass and the rule would enforce nothing.

### Three corrections worth naming

| Row | What was wrong |
|---|---|
| Scenario 2 | *"Make every task class fallback-eligible"* would have reddened the **ineligible sibling** test and left this row's own test green. A mutation aimed at a neighbour is the row-19 defect exactly. |
| Scenario 3 | *"Remove the re-ask cap"* makes the fixture loop forever, so the only signal is a suite timeout — a red that says nothing about the bound. Raising `MAX_REASK_ATTEMPTS` by one reddens the assertion instead. |
| Trust-critical 1 | *"Remove the tenant predicate from the company read"* is an **equivalent mutation**: RLS still returns no row, so foreign and unknown ids stay byte-identical and the cited test never notices. A green probe would have been read as proof. |

### The limit of the new rule, stated because it has already bitten

It cannot tell a RIGHT symbol from a WRONG-but-real one. **Scenario row 16 named `startRun` while its cited test
drives `enqueueJob`** — both real functions used in the same file, so the rule passes it. A human reading the
test body caught it; no tool did. Corrected by hand, and pinned as a test case so the limit cannot quietly stop
being true. This sits beside CDR-080 §7.10 (a run id is shape-checked, never resolved) and §7.11 (nothing
cross-checks a mutation against its test title).

A first version of the rule also **rejected honest rows**: the tokeniser did not admit hyphens, so
`enqueue-job.ts` became `job.ts` and a row naming a real file read as stale. That direction is the worse one — a
rule that fails good rows teaches people the tool is wrong — and it was found reviewing the diff before the
documentation describing it was written.

### §5's action is done

The backlog row's `Requirement IDs` is now `NFR-005;NFR-019`. The edit was made against an anchored prefix
asserted to occur exactly once, then verified by re-parsing the CSV and diffing every cell of all 101 rows:
**exactly one cell changed**, in the ACBP-P7-008 row, in `Requirement IDs`.

### What is still owed

The probe itself. GitHub Actions entered a major outage at 15:22 UTC on 2026-08-06 with webhooks throttled to
~15%, and **no run has ever been created for this branch** — not for `f90566b`, not for `9c34123`, not since.
The slice-4 and slice-5 tests are therefore written, typechecked and cited but **unverified**: they are
`describe.skipIf(!hasTestDatabase)` and skip locally, 51 collected and 51 skipped. Nothing here claims they pass.