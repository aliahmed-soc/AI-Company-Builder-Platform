# ACBP-P7-002 — independent review coverage

Ticket: **ACBP-P7-002** deactivation flows (ACC-004, COMP-006 final; ADR-006; **launch Gate 14**;
`SECURITY-VERIFICATION-PLAN:23` threat row *"zombie autonomous work"*; `RELEASE-GATES.md:10`). Branch
`p7-002-deactivation-flows`, PR **#74**, CDR-079, migration **0054**.

**THE TICKET IS NOT DONE.** What merged is the enforcement half on the owner's ruling *"land company-pause
enforcement first, defer the account half"*. What remains is recorded in §5 and in CDR-079 §9.

---

## §0 The finding that reshaped the ticket, before any code

Gate 14 says *"deactivation blocks new autonomous work"*, so the obvious work is to add two states to a CHECK
constraint and let the existing gate refuse them.

**There was no gate.** Nothing in production read a company's lifecycle status before doing autonomous work.

> **Pausing a company was a label, not a control** — and had been since ACBP-P1-010.

Four artefacts made that gap look closed, which is why it survived six phases:

| Artefact | What it says | What is true |
|---|---|---|
| `canPickUpAutonomousWork`'s docstring | *"the single truth a scheduler/worker consults before opening a run"* | **Zero production callers** |
| A green integration test | `'pause blocks new autonomous-work pickup (invariant 16 groundwork)'` | Calls the pure predicate on a returned value; exercises no pickup path |
| `EVENT-CATALOG.md:40` | `company.paused` consumer: *"Workflow coord. (halt/resume pickup, invariant 16)"* | No such consumer exists |
| `stop-service.ts:513` | *"nothing stops a task being created, planned, queued and started while the stop stands"* | Already true, already written down, about the machinery deactivation was to reuse |

A nine-agent design investigation (four read-only lenses → synthesis → three refutation lenses → completeness
critic) then **killed the first enforcement plan**: its five points did not cover the three shipped worker
bodies, and its own preferred remedy — the `policyPrecheck` seam — would have **permanently precluded NFR-015's
spend caps**, because `createModelGateway` throws when both are supplied.

---

## §1 The independent review — 37 agents, ten confirmed findings, two HIGH

Six adversarial lenses over the branch diff, each finding then handed to a refuter instructed to default to
REFUTED, then a completeness critic. **Both HIGH findings were in the ticket's own claims, not in its code.**

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

**Identical to the PROJECT-STATE forward pointer corrected on ACBP-P7-001 two days earlier.** Twice in one week
the record went stale first. New §4.3 records what was actually built, why four points and not five, and that
§4.1's objection is **not** dissolved.

### MEDIUM — and the one that would have cost somebody

**This ticket silently disabled a merged trust-critical control.** The lifecycle gate outranks the stop gate in
`decideDispatch`, and P6-007's held-work capture was keyed on *which refusal was reported*
(`finalReason === 'emergency_stopped'`). For a company **both** non-active **and** covered by a live stop — a
state the shipped fixture itself produces — the capture stopped running: no `held_work` row, no
`running`→`paused`, and ADMIN-002's confirm-or-discard review lost that task. Clear the stop before resuming the
company and it resumes with no review at all.

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

The fourteenth contracts mutation was **expected to survive and did**: it reinstates a `?? []` fallback that
earlier mutation testing had shown to be *unmeasurable*, because `Record<CompanyStatus, …>` makes the missing key
a compile error. It was removed for that reason — a guard nothing can reach reads as a control and is not one,
which is ACBP-P7-001's duplicated-allowlist finding arriving through a different door.

### §2.1 The probe that proved the Gate-14 suite measures anything

A **disposable probe branch** neutralised the lifecycle gate **without touching a single test**. Result:
**8 of 17 Gate-14 cases went red** through production paths against real PostgreSQL — `startRun` in all three
blocking states, the attempt-budget case, the account level, `enqueueJob`, `runJobStep`, `dispatchToolCall`.

Two things came out of it worth more than the green run:

- **The first probe attempt was a false confirmation.** It went red at *lint* (an unused constant) and never
  reached the tests. Accepting "CI is red" would have recorded a verification that verified nothing.
- **It exposed a weak assertion in the new suite.** `expect(refused.status).not.toBe('task_not_startable')`
  **passed with the gate off**, because a successful `'ok'` also is not `task_not_startable`. A negative-only
  assertion cannot fail in the direction it is named after. The positive assertion now comes first.

---

## §3 What is proven, and where

| Property | Proven by | Anchor |
|---|---|---|
| A paused / deactivating / deactivated company cannot start a run | real-PG, production `startRun` | **no `task_runs` row** |
| …cannot enqueue a job | real-PG, production `enqueueJob` | **no `jobs` row** |
| …cannot run a new job step | real-PG, production `runJobStep` | **no checkpoint, and the step closure never invoked** |
| …cannot dispatch a tool call | real-PG, production `dispatchToolCall` | the recorded `tool_calls` row with `denial_reason = 'company_not_active'` |
| The refusal is still RECORDED | same | TOOL-002's 100%-recorded property |
| A replay of a pre-pause enqueue still answers | real-PG | `deduplicated: true`, one job row (NFR-006) |
| An already-completed step still answers | real-PG | `already_completed` — resume arithmetic intact |
| A non-active ACCOUNT blocks, naming the account | real-PG | company row still `active` |
| Resuming restores the ability to work | real-PG, production `resumeCompany` | the gate is not a one-way door |
| **Export still works on a deactivated company** | real-PG | ADR-002's ownership guarantee |
| The suite measures the gate | the probe branch | 8/17 red with the gate neutralised |

---

## §4 Disclosed rather than designed around

- **§4.3** — the three worker bodies still reach the network and the metered gateway without crossing any gated
  function. `startRun` closes run *creation*; it does not close that.
- **§10 slice 5** — the transitions are not built, so **nothing can reach `deactivating` in production yet**. The
  gate is live for `paused`, which is what the ruling asked for first.
- **§7** — there is no scheduler (TASK-003 is deferred), session revocation is Clerk-side and owner-gated, work
  *creation* paths are ungated, live HTTP routes are unruled, and `RELEASE-GATES.md:10` wants a **drill**.
- **§6-G3** — the `FOR SHARE` ordering guarantee is asserted structurally, not by a real-PG race. A race that
  happens not to interleave is a green test proving nothing; a structural assertion fails every run the lock is
  missing. Stated so nobody mistakes it for a concurrency proof.

## §5 What must happen before this ticket is Done

1. The deactivate transitions (§9.5 — behavioural change to a merged `pauseCompany`).
2. The durable-stop sweep, without which a halt does not terminate runs.
3. The account vocabulary (§9.2) and the account transitions.
4. Worker-body enforcement (§9.3).
5. Reactivation semantics (§9.7) and the two Post-MVP cells (§9.1).
