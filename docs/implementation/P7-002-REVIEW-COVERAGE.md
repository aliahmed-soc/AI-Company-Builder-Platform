# ACBP-P7-002 — independent review coverage

Ticket: **ACBP-P7-002** deactivation flows (ACC-004, COMP-006 final; ADR-006; **launch Gate 14**;
`SECURITY-VERIFICATION-PLAN:23` threat row *"zombie autonomous work"*; `RELEASE-GATES.md:10`). Branch
`p7-002-deactivation-flows`, PR **#74**, CDR-079, migration **0054**.

**THE TICKET IS NOT DONE, AND IT IS NOT MERGED.** PR #74 is an open draft on `p7-002-deactivation-flows`;
merging to `main` is an owner gate that has not been taken. What has *landed on this branch* is the enforcement
half, on the owner's ruling *"land company-pause enforcement first, defer the account half"*. What remains is
recorded in §5 and in CDR-079 §9.

> **This sentence originally read "What merged is…".** A verification pass over this document caught it. Writing
> "merged" about a ticket whose merge is an owner gate is the most consequential error in the whole docs pass:
> it records a gate as taken. It is left visible here rather than silently corrected, on the same principle as
> §0 — the correction is the evidence.

---

## §0 The finding that reshaped the ticket, before any code

Gate 14 says *"deactivation blocks new autonomous work"*, so the obvious work is to add two states to a CHECK
constraint and let the existing gate refuse them.

**There was no gate.** Nothing in production read a company's lifecycle status before doing autonomous work.

> **Pausing a company was a label, not a control** — and had been since ACBP-P1-010.

**Five** artefacts made that gap look closed, which is why it survived six phases. CDR-079 §1.1 names four; the
fifth was found last, during the documentation pass, and is the worst of them:

| Artefact | What it said, on `origin/main` | What is true |
|---|---|---|
| `canPickUpAutonomousWork`'s docstring | *"the single truth a scheduler/worker consults before opening a run"* | **Zero production callers** |
| A green integration test | `'pause blocks new autonomous-work pickup (invariant 16 groundwork)'` | Calls the pure predicate on a returned value; exercises no pickup path |
| `EVENT-CATALOG.md:40` | `company.paused` consumer: *"Workflow coord. (halt/resume pickup, invariant 16)"* | No such consumer exists — and the row predates P1-010, unchanged since the Phase-0 initial commit |
| `stop-service.ts:514` (from P6-007 on) | *"nothing stops a task being created, planned, queued and started while the stop stands"* | Not a false claim — the opposite: a **recorded admission**, already written down, about the machinery deactivation was to reuse |
| **`REQUIREMENT-TRACEABILITY.csv`, COMP-006** | `Coverage status` = **`Covered (MVP)`**, verified by *"Pause-then-schedule negative tests; in-flight safe-stop tests"* | **Neither existed.** The first exists now; the second still does not, which is why the corrected cell reads `Partially covered - new-work halt only (MVP)`. This is the most consequential of the five: a traceability matrix is what a reader consults to ask *"is this requirement covered"* — the exact question it answered wrongly |

**They are not five of a kind.** Four ASSERTED a control that did not exist and agreed with each other — the
docstring, the test name, the catalog row and the coverage cell. The fifth said the OPPOSITE and was ignored.
Four agreeing artefacts are not four pieces of evidence: they are one unverified belief with four copies, and
the fifth was the disconfirmation that had already been written down.

A nine-agent design investigation (four read-only lenses → synthesis → three refutation lenses → completeness
critic) then **killed the first enforcement plan**: its five points did not cover the three shipped worker
bodies, and its own preferred remedy — the `policyPrecheck` seam — would have **permanently precluded NFR-015's
spend caps**, because `createModelGateway` throws when both are supplied.

---

## §1 The independent review — six lenses, ten confirmed findings; the five that changed the branch

Six adversarial lenses over the branch diff, each finding then handed to a refuter instructed to default to
REFUTED, then a completeness critic. Ten findings survived refutation; the **five recorded below are the ones
that changed code or documents**, and the two HIGH are among them. The other five were confirmed-but-minor and
are not itemised — said here so the count and the contents of this section visibly agree.

**Both HIGH findings were in the ticket's own claims, not in its code.**

### HIGH-1 — the comment lied, in the fix for comments that lie

`runs/coordinator.ts` asserted the gate makes *"no NEW autonomous work"* true *"since every body takes a
`runId`"*. Three of four sub-claims verify. The fourth is false **and its stated reason is inverted**: a `runId`
parameter is not a check, it is provenance metadata — its own docstring says so — and `runResearch` validates it
against nothing, reaching the network at `:219` and the metered gateway at `:255` **before its first database
statement at `:276`**. A stale or fabricated uuid reaches both identically; only the persist would fail, after
the money is spent.

Corrected to state what is true (no new **run row**, proved against the database) and to name what is not
(the worker bodies — CDR-079 §9.3, still open).

### HIGH-2 — the decision record went stale before the code did

CDR-079 still read *"the enforcement plan the investigation KILLED"* and *"Enforcement — blocked on §9.3"* while
the branch shipped four of those five points, each carrying a *"launch Gate 14"* banner. The only place the
ruling was argued was a code comment.

**Identical to the PROJECT-STATE forward pointer corrected on ACBP-P7-001 FOUR HOURS EARLIER THE SAME EVENING** (`cf67c7f` at 19:52; this ticket's stale-CDR finding landed as `970929d` at 23:55 —
2026-08-05). Twice in two days the record went stale first — because CI verifies code on every push and prose is
verified by nobody. New §4.3 records what was actually built, why four points and not five, and that §4.1's
objection is **not** dissolved.

### MEDIUM — and the one that would have cost somebody

**This ticket silently disabled a merged trust-critical control.** The lifecycle gate outranks the stop gate in
`decideDispatch`, and P6-007's held-work capture was keyed on *which refusal was reported*
(`finalReason === 'emergency_stopped'`). For a company **both** non-active **and** covered by a live stop — a
combination **no fixture ever DISPATCHES from** (the harness pauses company B2 and one dispatcher case raises an
account-wide stop over account B, but every dispatch in that suite runs from the active company A1), which is
exactly why nothing caught it — the capture
stopped running: no `held_work` row, no `running`→`paused`, and ADMIN-002's confirm-or-discard review lost that
task. Clear the stop before resuming the company and it resumes with no review at all.

No test detected it. The contract-level precedence test lists *"allowlist, policy and approval"* and
conspicuously omits `stop`. The audit event carried the identical bug: `stop_scopes` and `held_by_stop_id` were
guarded on the same reason, so the permanent record lost the trace that a stop covered the call.

**And the first fix was too broad — CI refused it.** Keying on `stopEvaluation.kind` alone made *any* denial
pollute the queue, and `'a refusal for a DIFFERENT reason holds nothing — WITH a covering stop in force'` failed
at once. That test's own comment names this exact mutation as the one it exists to catch; it had itself been
hardened by an earlier review after shipping vacuous. **The guard was load-bearing and I widened it past its
purpose.** The line that survives: `not_registered` / `no_allowlist` / `not_allowlisted` describe a request
invalid on its own terms, so the stop interrupted nothing; `company_not_active` describes a well-formed call that
**both** controls independently refused, so the task really is halted and the queue must know.

**The general rule, now CDR-079 §9.14:** *a new gate that outranks an existing one inherits responsibility for
every side effect the old one carried.* Nothing in this repository enforces that rule.

### MEDIUM — two `status: 'ok'` paths that recorded different things

`enqueueJob`'s new blocked-replay branch returned `ok, deduplicated: true` while writing **no audit event and no
suppression counter**, unlike the byte-identical branch beside it, whose comment already gives the reason: *"an
enqueue attempt that collapsed into an existing job is exactly the event a run trail would otherwise be missing,
and the caller was told `ok`."* Being also lifecycle-blocked changes none of that. Both effects added.

### MEDIUM — the Gate-14 fixture could not have authorized anything

It seeded no policy. The dispatcher evaluates policy unconditionally, `no_active_policy` maps to deny, so an
**active** company in that fixture is refused `policy_denied` — meaning the two dispatcher cases were passing
against a fixture whose every call was refused for an unrelated reason. `dispatcher.integration.test.ts` had
already written the warning: *"a suite that seeded none would only ever be testing the no-policy refusal."*
A policy is now seeded and a **dispatch control** asserts an active company reaches `authorized`.

---

## §2 Mutation testing

| Target | Mutations | Caught |
|---|---|---|
| `mayStartAutonomousWork` + the transition table | 14 | 13 real guards, all 13 |
| `readLifecycleDecision` (both locks, both levels, scope-sourced ids, absent row) | 5 | 5 |
| `decideDispatch` lifecycle placement | 4 | 4 |

22 of the 23 were caught. The twenty-third was **expected to survive and did**: it adds a `?? []` fallback to the
transition lookup that nothing can distinguish from its absence, because `Record<CompanyStatus, …>` makes the
missing key a compile error. No such fallback was ever committed — `company.ts:94-99` records the decision not to
write one. A guard nothing can reach reads as a control and is not one, which is ACBP-P7-001's
duplicated-allowlist finding arriving through a different door.

### §2.1 The probe that proved the Gate-14 suite measures anything — and what it does not prove

A **disposable probe branch** neutralised the lifecycle gate **without touching a single test**. Result:
**8 of the suite's then-17 cases went red** through production paths against real PostgreSQL — `startRun` in all
three blocking states, the attempt-budget case, the account level, `enqueueJob`, `runJobStep`,
`dispatchToolCall`.

**Read that number with two caveats, both of which are this ticket's fault:**

- **The probe branch was disposable and was NOT preserved, and no CI run is cited.** ACBP-P6-006 did the
  recoverable half properly: it wrote down BOTH the probe SHA (`fe85082`) AND its CI run id (`30646208952`,
  recorded in CDR-071:184). **That SHA is reachable from no ref today either** — P6-006's branch was
  squash-merged and deleted — so the RUN ID is the half that actually survived, and the half to copy. Nobody can
  re-derive this ticket's figure at all, which makes "mutation-proven" rest on prose: the precise weakness §0 is
  about. **Record the next probe's run id, not just its commit.**
- **The suite is 18 cases now, not 17.** `970929d` later seeded a policy and added the dispatch control case, and
  the probe was not re-run. The enumeration above is also probably short by one: `'RESUMING restores the ability
  to work — the gate is not a one-way door'` asserts the same refusal and cannot have stayed green under a
  neutralised gate, which would make it 9. Recorded as measured rather than adjusted after the fact.

Two things came out of it worth more than the green run:

- **The first probe attempt was a false confirmation.** It went red at *lint* (an unused constant) and never
  reached the tests. Accepting "CI is red" would have recorded a verification that verified nothing.
- **It exposed a weak assertion in the new suite.** `expect(refused.status).not.toBe('task_not_startable')`
  **passed with the gate off**, because a successful `'ok'` also is not `task_not_startable`. A negative-only
  assertion cannot fail in the direction it is named after. The positive assertion now comes first.

---

## §3 What is proven, and where

The state column is exact on purpose: **only `startRun` is exercised in all three blocking states.** The gate is
state-agnostic by construction, so the others would pass — but this table is the evidence inventory, and an
untested combination does not belong in it.

| Property | Proven by | Anchor |
|---|---|---|
| A **paused / deactivating / deactivated** company cannot start a run | real-PG, production `startRun` | **no `task_runs` row** |
| A **paused** company cannot enqueue a job | real-PG, production `enqueueJob` | **no `jobs` row** |
| A **paused** company cannot run a new job step | real-PG, production `runJobStep` | **no checkpoint, and the step closure never invoked** |
| A **paused** and a **deactivated** company cannot dispatch a tool call | real-PG, production `dispatchToolCall` | the recorded `tool_calls` row with `denial_reason = 'company_not_active'` — **presence, not absence**, because TOOL-002 requires the refusal itself to be recorded |
| A replay of a pre-pause enqueue still answers | real-PG | `deduplicated: true`, one job row (NFR-006) |
| An already-completed step still answers | real-PG | `already_completed` — resume arithmetic intact |
| A non-active ACCOUNT blocks, naming the account | real-PG | company row still `active` |
| Resuming restores the ability to work | real-PG, production `resumeCompany` | the gate is not a one-way door |
| **Export still works on a deactivated company** | real-PG | ADR-002's ownership guarantee |
| The suite measures the gate | a probe branch that was **not preserved** — see §2.1 | 8 of the then-17 cases red with the gate neutralised |

---

## §4 Disclosed rather than designed around

- **§4.3** — the three worker bodies still reach the network and the metered gateway without crossing any gated
  function. `startRun` closes run *creation*; it does not close that.
- **§10 slice 5** — the transitions are not built, so **nothing can reach `deactivating` in production yet**. The
  gate is live for `paused`, which is what the ruling asked for first.
- **§7** — there is no scheduler (TASK-003 is deferred), session revocation is Clerk-side and owner-gated, work
  *creation* paths are ungated, live HTTP routes are unruled, and `RELEASE-GATES.md:10` wants a **drill**.
- **`lifecycle-guard.test.ts:6`** — the `FOR SHARE` ordering guarantee is asserted **structurally**, not by a
  real-PG race. A race that happens not to interleave is a green test proving nothing; a structural assertion
  fails every run the lock is missing. Stated so nobody mistakes it for a concurrency proof. **CDR-079 §6-G3 now
  carries the same caveat**, and records that an earlier draft of it wrongly asserted the transition's read *"is
  `FOR UPDATE`"*. It is not: `CompanyRepository.findById` (`company-repositories.ts:35`) is an unlocked
  `SELECT`, and the ordering rests on the gate's `FOR SHARE` conflicting with the row lock the transition's
  `UPDATE` takes implicitly. *(This bullet said §6-G3 did **not** carry the caveat — written in the same commit
  that added it. A cross-document claim about a file you are editing goes stale before the commit closes.)*

## §5 What must happen before this ticket is Done

CDR-079 §9 is a fourteen-item numbered list; the citations below were checked against it item by item, because a
pointer to the wrong open question is worse than none — the reader finds a real section, reads a real decision,
and never learns theirs is unrecorded.

1. **The deactivate transitions** (**§10 slice 5** — not §9.5, which asks the prior question). Nothing performs
   `active/paused → deactivating`.
2. **The durable-stop sweep** (**§9.5**, *"Does pause now raise a real halt?"*) — without it a halt refuses new
   work but does not terminate runs already executing. Item 1 depends on this one.
3. **The account vocabulary** (**§9.2**) and the account transitions.
4. **Worker-body enforcement** (**§9.3**) — and note this is *not* "the fifth point of the killed plan". The
   fifth point was `runWorkerStep`, which waits on item 2; the three worker bodies pass through none of the five
   points, which is why §4.1 killed the plan.
5. **Reactivation semantics** (**§9.7**) — what reactivating a *deactivated* company means — and separately
   **§9.8**, whether `paused → active` enforces ADMIN-002's held-work review. Two different decisions; §9.8 was
   cited nowhere until now.
6. **The event names** (**§9.10**): `company.deactivated` is catalogued but unregistered, and canon names no
   event at all for `deactivating → deactivated`.
7. The two **Post-MVP** cells (**§9.1**).
