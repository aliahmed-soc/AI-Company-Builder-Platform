# CDR-079 — Deactivation flows (ACBP-P7-002)

Governing: **ACC-004** (account deactivation stopping all autonomous work), **COMP-006 (final)** (company pause —
stops autonomous work, keeps data); ADR-006; `WORKFLOW-STATE-MACHINES.md §1`; `diagrams/08`, `diagrams/15`;
**SECURITY-VERIFICATION-PLAN Gate 14** and **RELEASE-GATES.md:10**; threat row *"zombie autonomous work"*.
Depends on **ACBP-P6-007** (emergency stop, Done).

> **REWRITTEN after a nine-agent design investigation** (four read-only lenses → synthesis → three adversarial
> refutation lenses → a completeness critic). The first draft of this CDR proposed a five-point enforcement plan
> that **would not have gated the autonomous work at all** (§4.1). Everything below that survived is marked as
> such; everything the investigation killed is recorded rather than quietly replaced, because the killed version
> is the one a reader will otherwise re-derive.

---

## §0 The thing this ticket is for, and why it is not "add two states"

> **§0 and §1 DESCRIBE `origin/main` — the tree as it was BEFORE this branch.** They are written in the present
> tense of the moment they were investigated and are deliberately not rewritten, because they are the finding.
> **§4.3 and §10 record what shipped.** If you want to know what is true now, read those.

Gate 14 says **deactivation blocks new autonomous work**. The obvious reading is that `companies.status` gains
`deactivating` and `deactivated`, the CHECK constraint widens, and the gate that already refuses work for a
`paused` company starts refusing these too.

**There is no such gate** (was none — §4.3 built one).

> **Pausing a company was a label, not a control.**

`pauseCompany` writes `companies.status`, writes an audit event, projects an activity row, and returns. It never
touches `jobs`, `tasks`, `task_runs`, `worker_runs`, `tool_calls` or `emergency_stops`. Nothing downstream asked.

So the centre of gravity is the **gate**, not the states. Adding `deactivated` to a vocabulary nothing enforces
would satisfy the acceptance criterion's wording and leave Gate 14's threat exactly where it is.

## §1 The evidence

**This table records `origin/main`.** Four of its seven rows are false at HEAD, because this branch changed
them — that is the point of the ticket. Where it changed, the row says so.

| Where enforcement was expected | What was there on `origin/main` |
|---|---|
| `canPickUpAutonomousWork(status)` — `contracts/company/company.ts:70` | Exists, correct, **zero production callers**. → **DELETED by this branch**; tombstone at `company.ts:103` |
| Run pickup — `runs/coordinator.ts` + `task-run-repository.claimAttempt` | authz, attempt validity, task exists, `canStartRunForTask(task.state)`, attempt-not-claimed. **No company status**. → **now reads it at `coordinator.ts:155`** |
| Tool dispatcher — `tools/dispatcher.ts` | Many precondition gates (membership, authz, run state, idempotency, registry, spend, policy, approval, emergency stop). **Company lifecycle is not among them**; `DispatchRequestFacts` has no field for it. → **now a REQUIRED field, `dispatch.ts:132`** |
| Worker runtime — `workers/runtime.ts` | Checks the **worker's** state, never the company's. → **still true; §9.3** |
| `elevateToCompanyScope` — `database/transaction.ts:128` | `select('id')` — existence only. → **still true** |
| RLS / CHECK / partial indexes | Account and company **identity**. No policy references `companies.status`. → **still true**; the gate is application-level |
| Account level | **Nothing anywhere refuses on `accounts.status`.** → **now `lifecycle-guard.ts:43-44` reads it `FOR SHARE` and refuses `account_not_active`.** Still true: no `AccountStatus` contract exists, and `AccountRepository.findById` has **zero callers** |

The production readers of `companies.status` on `origin/main` were: `interview-session.ts:79`,
`provisioning-service.ts:164,191,298-299,354-369`, `company-lifecycle.ts:85-94,207-210`, `admin-service.ts:82`,
and `portfolio-service.ts:94` (via `portfolio-repository.ts:65`, reached from
`apps/web/.../companies-request.ts`). Only `interview-session.ts` refuses anything, and it covers a
human-initiated discovery start — which is why the true form of this ticket's headline claim carries a
qualifier: nothing read the status **before doing autonomous work**. This branch adds `lifecycle-guard.ts:45`,
**the only reader that enforces before autonomous work**.

*(An earlier draft called this list "closed" at four entries and called the new reader "the only enforcing one".
It was neither: `portfolio-service` was missing, and `interview-session` enforces. An inventory asserting
completeness is worth exactly what its search was worth — see §1.1.)*

### §1.1 Four artefacts that made the gap look closed — and a FIFTH, found later

- **The predicate's docstring** — *"this pure predicate is the single truth a scheduler/worker consults before
  opening a run … Pausing is the enforcement point (P1-010); the scheduler is later."* The first clause describes
  a consultation that never happens; the second was a truthful deferral that stopped being true once schedulers,
  workers and a dispatcher existed.
- **A green test** named `'pause blocks new autonomous-work pickup (invariant 16 groundwork)'` that calls the
  pure predicate on a returned value. It exercises no pickup path and would stay green if every scheduler ignored
  company status forever.
- **`EVENT-CATALOG.md:40`** describes `company.paused`'s consumer as *"Workflow coord. (halt/resume pickup,
  invariant 16)"* — a consumer that does not exist.
- **`stop-service.ts:513-515`**, which already says the quiet part about the machinery deactivation was going to
  reuse: *"AN INDEPENDENT REVIEW FOUND THAT FALSE FOR ALL FOUR: activation holds only tasks that are in flight AT
  THAT MOMENT, and nothing stops a task being created, planned, queued and started while the stop stands."*
- **AND A FIFTH, found only during the documentation pass, after the code had shipped and been reviewed twice:**
  `REQUIREMENT-TRACEABILITY.csv`'s **COMP-006** row read `Coverage status = Covered (MVP)`, verified by
  *"Pause-then-schedule negative tests; in-flight safe-stop tests"* — **neither of which existed**. This is the
  most consequential of the five, because a traceability matrix is what a reader consults to ask *"is this
  requirement covered"*, which is the exact question it answered wrongly. The same claim also survived in a
  SECOND matrix, `docs/implementation/REQUIREMENT-TO-TICKET-TRACEABILITY.csv`, which the first correction pass
  missed entirely.

  Note the five are not five of a kind: four ASSERTED a control that did not exist and agreed with each other;
  `stop-service.ts` said the OPPOSITE and was ignored. Four agreeing artefacts are not four pieces of evidence —
  they are one unverified belief with four copies — and the fifth was the disconfirmation already written down.

## §2 A canon conflict about WHEN, ruled

`MASTER-PRD` marks **ACC-004 Post-MVP** and journey **J-20 Post-MVP**; `SECURITY-VERIFICATION-PLAN:23` places
deactivation at **M6–M7** supporting **Gate 14**, a launch gate; `RELEASE-GATES.md:10` independently requires
*"deletion/deactivation paths work"* plus *"runbooks proven (at least restore + stop drills executed)"*.

**Ruled: build it now** — and the deciding fact is not the phase plan. **COMP-006 is MVP**, is marked `(final)`
on this ticket, and its enforcement half has never existed. A launch gate cannot be satisfied by a requirement
whose control is absent.

**Not silently reconciled**: the two Post-MVP cells are left untouched and flagged (§9.1).

## §3 The gate — the part that survived every attack

- **G3.1 — ONE pure, total function in `@acbp/contracts`.** Both lifecycle values enter as `unknown`, never as
  `CompanyStatus`/`AccountStatus`. Typing them as the union is the failure mode, not a tidiness win: TypeScript
  exhaustiveness then convinces a reviewer that an unrecognised runtime value is impossible, which is exactly
  what a widened CHECK, a later migration or a corrupt row violates. In-repo precedent: `StopRecord.scope` is
  typed `string` for this reason.
- **G3.2 — WRITTEN AS AN ALLOWLIST, POSITIVELY.** Allowed **iff** company status is `'active'` **and** account
  status is `'active'`. Not a denylist, not `!== 'active'` over a union with a `default:` arm. This is canon's own
  phrasing (`WORKFLOW-STATE-MACHINES.md:81`, the `queued→running` row: *"stop-state clear; company active"*;
  `diagrams/06:10` writes it *"stop-state clear + company active"*), and it buys
  three things: fail-closed on unrecognised values **falls out by construction** with no branch to forget; a
  future state is refused before anyone remembers to add it; and `deleted` needs no vocabulary entry (§3.6).
- **G3.3 — LOGICAL AND, EVALUATED INDEPENDENTLY, NEVER A CASCADE.** Account deactivation performs **no cascade
  UPDATE** of `companies.status`. Because there is no walk, there is no half-finished walk: a deactivated account
  refuses at every one of its companies from the instant its row commits. `companies.status` therefore stays
  truthful about the company's own lifecycle (COMP-008), and the *composite* answer refuses.
- **G3.4 — THE ACCOUNT IS EVALUATED FIRST.** When both are non-active, the reported reason names the **account**,
  because that is the broader cause and the one an operator must fix first. Same reasoning as CDR-075's
  `limit_scope`. The reason is for observability and **must never re-enter the decision**.
- **G3.5 — A NON-ANSWER IS A REFUSAL; A THROW IS NOT A REFUSAL AT ALL.** An absent row refuses with an
  `*_unreadable` reason. A read that **throws** is deliberately **not caught**: in PostgreSQL a failed statement
  aborts the enclosing transaction, so a caught-and-converted refusal would try to write its own denial row and
  fail with `25P02` — the identical trap CDR-075 §3-G8 hit with `23505`. Letting it propagate fails the whole
  operation, which is the correct fail-closed outcome and requires no code.
- **G3.6 — `deleted` IS NOT ADDED TO THE VOCABULARY.** COMP-007/ACC-005 own deletion (§8); canon makes three
  different reachability claims for `deleted`, so its transition set cannot be written down without picking a
  winner; and migration `0008_companies.ts:53` set the precedent that the CHECK stays tight to what is reachable.
  The allowlist refuses it correctly without a vocabulary entry.
- **G3.7 — NEVER CALLER-INJECTABLE.** No port, no `ToolGates` field, no options override, no test seam. Tests
  write `companies.status`/`accounts.status`. `dispatcher.ts:76-84` already carries the instruction, having had a
  caller-injectable safety answer re-introduced and deleted twice.
- **G3.8 — NEVER IN A SCOPE PRIMITIVE.** Not in `runInCompanyScope`, `runInAccountScope`,
  `elevateToCompanyScope`, `withTenantTransaction` or `writeAuditEvent`. `elevateToCompanyScope` is `select('id')`
  today, which reads as the natural home for a status predicate and is the single most destructive: it would
  refuse provisioning (deadlocking company creation permanently), every read surface, and the export path.

## §4 Where the gate goes

### §4.1 The enforcement plan the investigation KILLED

The first plan named five points: `startRun`, `enqueueJob`, `runJobStep`, `dispatchToolCall`, `runWorkerStep`.

**The three shipped worker bodies pass through none of them.** `runResearch` fetches external pages at
`research.ts:219` and calls the metered gateway at `:255`; `runDocumentWorker` at `document.ts:106`;
`runStrategyComparison` at `comparison.ts:114`. Their only database touch is `persistArtifact` — *after* the
spend — which checks authz and run existence, not run state and not company status. And `runWorkerStep` has
**zero callers outside its own integration test**; the Slice E journey invokes `ops.runResearch(...)` directly.

That plan would have installed a careful fail-closed gate at five places the work does not go through, and Gate
14 would have read as satisfied. **This is the same failure the ticket exists to fix, reproduced inside the fix**
— the fourth instance in this programme after CDR-074 §5.4, CDR-075 §4.3 and §1.1 above.

### §4.2 The remedy that was ALSO killed

The obvious repair — put the gate at `policyPrecheck` in `createModelGateway`, the one seam all model spending
crosses — fails three ways: the seam has **no production composition** (CDR-075 §4.3's disclosed gap); it is
**caller-injectable configuration**, which G3.7 forbids; and `model-gateway.ts:132-133` **throws** when both
`policyPrecheck` and `caps` are supplied, so lifecycle there would **permanently preclude NFR-015 spend caps**.

- **G4.1 — The lifecycle gate MUST NOT occupy `policyPrecheck`.** Whatever the enforcement location turns out to
  be, it may not be the seam the caps ticket needs.

### §4.3 WHAT WAS ACTUALLY BUILT — the ruling §4.1 and §4.2 left open

> **This section was added after the enforcement landed.** For several commits this record still said enforcement
> was "blocked on §9.3" while the branch shipped four of the five points §4.1 had declared killed. The
> independent review found it, and it is the same defect as PROJECT-STATE's stale forward pointer on ACBP-P7-001:
> **the decision record went stale first, and the only place the ruling was argued was a code comment.**

**Ruled (owner, this session): land COMPANY-PAUSE enforcement first; defer the account half.** On that ruling the
ticket enforces **new-work refusal** — Gate 14's headline — at four points, and does NOT attempt in-flight halt:

| Point | Placement, and why the ordering is the argument |
|---|---|
| `startRun` | Before `claimAttempt`, so a refusal does not burn an attempt number |
| `dispatchToolCall` | Beside the other gate facts, NOT an early return, so the refusal is still RECORDED (TOOL-002) |
| `enqueueJob` | BEFORE the insert, with the REFUSAL withheld until the idempotency read-back finds no existing job, so a replay of a pre-pause success still answers `deduplicated` (NFR-006; see §6-G5) |
| `runJobStep` | After the already-completed short-circuit, before the step closure |

**Why four and not five.** `runWorkerStep` is the in-flight shape, and in-flight halt needs the durable-stop
sweep (§6.1) that §9.5 still gates. Deferring it keeps this ticket's claim exactly "no NEW autonomous work".

**§4.1's objection is NOT dissolved, and this is the honest limit of what shipped.** The three worker bodies
still reach the network and the metered gateway without crossing any gated function. `startRun` closes
run *creation*, so no new run row exists for a non-active company — but a `runId` parameter is provenance
metadata, not a check, and `runResearch` validates it against nothing: it fetches and spends **before its first
database statement**. A stale or fabricated uuid reaches both identically. **Gating the worker bodies remains
§9.3, open.** An earlier version of the comment at `runs/coordinator.ts` claimed otherwise; it was corrected
(§9.14).

## §5 What must keep working — the permit list

Getting this wrong permissively is a security hole; getting it wrong restrictively breaks the ownership guarantee
or deadlocks the company. **Both directions matter**, which is why the list is explicit.

- **G5.1 — `exportCompanyData` is permitted in EVERY non-active state.** ADR-002 makes export the ownership
  guarantee. A founder who deactivates must still be able to take their data. It mutates no company state and
  starts no work.
- **G5.2 — Every read surface is permitted**: `getCompany` (COMP-008 requires a truthful status — it is how
  anyone learns the company is deactivated at all), portfolio, activity, decision room, task board, memory reads,
  admin read, stop state, and the blocked-jobs read. Data is retained, not deleted.
- **G5.3 — The paths OUT are permitted, or the company deadlocks**: `resumeCompany` (it *is* the reactivation
  path), `reviewHeldWork` (whose `confirmed` branch performs the `paused → running` transition), `clearStop`, and
  the system `deactivating → deactivated` transition. Gating a transition out of a non-active state on being
  active is self-defeating.
- **G5.4 — Every path that moves work TOWARD terminal is permitted**: `succeedRun`, `failRun`, `cancelRun`,
  `finishWorkerRun`, `reportToolCallOutcome`, `completeTask`, `recordJobFailure`, and above all
  **`reclaimLostRuns`**. Gating the reaper would leave abandoned runs `running` forever — *Gate 14's own gate
  manufacturing the exact zombie shape Gate 14 is about.*
- **G5.5 — Settlement and metering are permitted**: `settleRun`, credit release, and the in-flight run's spend to
  its stop point. *"Metered to stop"* is a canon **effect** of the halt, and blocking settlement produces
  *"I deactivated and you kept my credits."*
- **G5.6 — Account-spanning reads are permitted, and the gate MAY NEVER BE IMPLEMENTED BY FILTERING AN
  ENUMERATION**: `rebuildAccountUsageRollup`, `reconcileAccountUsageRollup`, `checkUsageCaps`. `checkUsageCaps`
  elevates into **every** company in the account and any throw returns `UNREADABLE`, which fails closed — so
  over-blocking one deactivated company would halt metered calls for **every other company in the account**.
- **G5.7 — Provisioning is permitted BY CONSTRUCTION, and that argument is verifiable rather than asserted**:
  `provisioning-service.ts` imports only the database package, contracts, the scope resolver, authz and the
  logger. It *cannot* reach any gated function. This is why G3.8 matters.

## §6 A status write is not a halt

The investigation's hardest finding after §4.1: the design assumed setting a status stops work. It does not.

- **G6.1 — The lifecycle transition MUST write the durable stop.** Inside the same transaction as the status
  update, sweep the company's `running` task runs and request stop. Without it: the worker run finishes
  `stopped`, the **task run stays `running` forever** with no worker attached until the reaper mislabels it
  `worker_lost`; `heartbeatRun` — canon's only in-band halt channel — keeps answering *"no stop requested"*
  affirmatively; and `settleRun`, which requires a terminal run, can never release the credits.
- **G6.2 — This is a BEHAVIOURAL CHANGE TO A MERGED FEATURE.** `pauseCompany` shipped in P1-010 as a status
  write. COMP-006's own MVP acceptance requires *"in-flight tasks reach a safe stop"*, so the change is required,
  not optional — but it changes what an existing, merged, audited operation does, and that is disclosed here
  rather than discovered later (§9.5).
- **G6.3 — The gate's read must LOCK.** `withTenantTransaction` runs READ COMMITTED and neither side takes a row
  lock, so a run can start strictly *after* the deactivation commits — the two transactions touch disjoint rows
  and neither blocks. Same-transaction reads bound how **stale** the read is, not the **ordering**. The gate's
  read is therefore `FOR SHARE` (`lifecycle-guard.ts:43,45`).

  **AS SHIPPED, the transition does NOT take an explicit lock** — `CompanyRepository.findById`
  (`company-repositories.ts:35`) is a plain `SELECT`, and no `forUpdate()` exists on the `pauseCompany`/`resumeCompany` transition path. (The `forUpdate()` calls on `companies` at `provisioning-service.ts:290,347` belong to provisioning completion and resume, not to the lifecycle transition.) The
  ordering rests on the gate's `FOR SHARE` conflicting with the row lock the transition's `UPDATE` takes
  implicitly. **This is asserted STRUCTURALLY, not by a real-PostgreSQL race** — see `lifecycle-guard.test.ts:6`,
  *"structurally, where its removal is detectable every run"*. A race that happens not to interleave is a green
  test proving nothing; a structural assertion fails every run the lock clause is missing. Stated here so that
  nobody reads this section as a concurrency proof. (An earlier draft of this bullet asserted the transition's
  read *"is `FOR UPDATE`"*. It is not, and never was.)
- **G6.4 — FAIL-CLOSED MUST NOT MEAN A TERMINAL WRITE.** Where a refusal is expressed as finishing a run
  `stopped`, an `*_unreadable` answer must map to a **non-terminal** outcome instead. Every precedent for the
  fail-closed rule is a *retryable* refusal; a transient read failure must not permanently kill a healthy run of
  a healthy company.
- **G6.5 — Ordering at `enqueueJob`**: the gate is READ **before** the insert (`enqueue-job.ts:145`), but its
  **refusal branch asks the idempotency question first** (`findByIdempotencyKey` at `:147`) and only then
  refuses, with nothing inserted. A retry of a pre-deactivation success therefore still returns
  `deduplicated: true` — refusing without asking would leave the caller unable to learn their job exists,
  breaking NFR-006 replay safety, and gating after the insert would be worse still, since the job would already
  exist. (Read the placement literally: an earlier draft said the gate *"fires after the insert-first/read-back
  path"*, which describes an ordering the code does not have and a test at `gate-14.integration.test.ts:145`
  would fail.)

## §7 What this ticket CANNOT deliver, stated up front

Gate 14's wording outruns the platform. Recorded so the evidence pack cannot claim otherwise.

- **There is no scheduler.** No cron, queue runner, dequeue or lease exists anywhere. ACC-004's evidence
  deliverable is *"Deactivate-then-schedule negative tests"*, and **scheduling is itself deferred**
  (`REQUIREMENT-TRACEABILITY.csv:47`, TASK-003, Post-MVP, OQ-13). The acceptance wording cannot be satisfied as
  written; the honest substitute is deactivate-then-**start**/**dispatch**/**spend**.
- **Session revocation is not delivered.** `SECURITY-ARCHITECTURE.md:10` states *"revocation on deactivation"*.
  That is a Clerk-side effect behind an owner gate and is out of scope. Canon's stated deactivation effect will
  not be delivered by this ticket.
- **Work CREATION is not gated by the enforcement plan.** `requestRevision` (whose own docstring says *"the new
  task will spend a credit when it is queued"*), `repeatTask`, `createTask`/`planTask`, and `createCompany` —
  which reads no account status, so a deactivated account can mint unlimited companies that each provision
  themselves to `active`. Either creation is gated or this is disclosed; it is **not** silently omitted (§9.4).
- **Live HTTP routes remain unruled.** `POST /api/companies/[companyId]/interview/resume` reaches
  `applyTransition`, which checks `interview:participate` and the session state machine and **never reads company
  status** — while `startInterviewSession` does. A founder can resume an interview on a deactivated company today
  over a shipped route. Also live and unruled: memory create/edit/delete, `POST /api/companies`,
  `provisioning/resume`, `members/accept`, and `decision-room/stream` (a server-side poll loop — the closest
  thing in the repo to a recurring server-driven process).
- **RELEASE-GATES.md:10 demands a DRILL**, not a test. Out of scope here; it belongs with the runbooks.

## §8 Scope boundaries

- **No deletion or purge** — COMP-007 / ACC-005. Separate requirement ids, separate ticket. `CDR-009:11` confirms
  the retention clock is **deletion-keyed**, so *"data retained per retention"* for a deactivated company is
  satisfied by doing nothing: **no retention work is in scope**.
- **No public-artifact offlining.** Canon marks it *"(future)"*. J-20's *"truthful public-site status"* is
  therefore also undeliverable here.
- **No new halt mechanism** — in-flight safe-stop reuses ACBP-P6-007's machinery (§6.1).
- **No HTTP surface for the transition itself** (§9.6).

## §9 Open owner decisions

1. **The two Post-MVP cells** — `MASTER-PRD:157` (ACC-004) and `:399` (J-20) versus a launch gate.
2. **The account vocabulary, now on better evidence.** `accounts.status` is `active | suspended | closed`, and
   **`suspended` and `closed` have no semantic definition anywhere in the repo** — every occurrence is the CHECK
   constraint plus two passing comments. There is no account state machine and no account transition table.
   Account-scoped audit events DO exist — `membership.invited` and `membership.revoked` (CDR-015:36-37), and
   `usage.rollup_reconciled`, the one registry entry carrying `subjectType: 'account'` (`audit.ts:270`) — but
   **there is no account LIFECYCLE event at all.** `account.created` is not one either: it is a `logger.info` at
   `accounts/provisioning.ts:44`, deliberately absent from `AUDIT_EVENTS`, and `audit.test.ts:196` requires it to
   be *rejected* as an `AuditEventName`. *(Two earlier drafts of this sentence were both wrong — first "no
   account-scoped audit event beyond `account.created`", then an enumeration that missed
   `usage.rollup_reconciled`. Enumerating a registry by memory fails twice as easily as reading it.)* And the
   investigation found the argument had been run
   on the wrong entity: **`DATA-ARCHITECTURE:10` gives the USER lifecycle as `active→deactivated→deleted`** — the
   only canon lifecycle containing the literal word "deactivated" is the User, not the Account.
   **The gate does not depend on this**: an allowlist on `'active'` is correct whichever value means deactivated.
   Only the *transition* needs the answer.
3. **WHERE THE GATE GOES FOR THE WORKER BODIES (§4.3)** — the remaining half. The four run/job/dispatch points
   shipped; `runResearch`, `runDocumentWorker` and `runStrategyComparison` still spend without crossing any of
   them. **Not `policyPrecheck`** (G4.1 — it would preclude NFR-015's caps).
4. **Is work CREATION gated, or disclosed?** (§7.)
5. **Does pause now raise a real halt?** (§6.2 — a behavioural change to merged code.)
6. **No HTTP caller for the transition on merge**, and `API-CONTRACTS.md:28,30` already names `deactivate` for
   both accounts and companies — so shipping no route is a deliberate deviation from a documented contract.
7. **Reactivation of a deactivated company.** Canon marks the state terminal (⏹) while four separate statements
   demand a documented reactivation path. Support-mediated restore, or "create a new company"? Not defaulted.
8. **Does `paused → active` now enforce ADMIN-002 held-work review?** Canon states the precondition; the shipped
   path enforces only `requiredFrom === 'paused'`. Documenting it as *the* reactivation path while its canonical
   precondition is unenforced would repeat §1.1's defect.
9. **Autonomy levels are a THIRD mechanism** meaning "this company may not act by itself" —
   `autonomy.ts` level 1: *"Propose only … nothing at all runs until you approve it"*, restrict-only,
   most-restrictive-wins, already wired into policy evaluation №3. Whether the lifecycle refusal belongs there is
   the same question as the owner gate already on the board about policy evaluation point 1; answer them together.
10. **The event names.** `company.deactivated` is catalogued but `CDR-015:34-35` lists it under *"NOT registered"*, and
    canon fires it on **entering `deactivating`**, not on reaching `deactivated` — the name and the state it
    records diverge. Canon names **no event at all** for `deactivating → deactivated`.
11. **Deactivation from `draft`/`onboarding`** is ruled illegal (canon's sources are `active/paused` only), so a
    company stuck mid-provisioning cannot be deactivated. Foreseeable support case with no answer.
12. **Aborting a deactivation** (`deactivating → active`) is ruled illegal — canon has no reverse edge. *"I
    clicked deactivate by mistake"* has no answer today.
13. **THE TICKET IS SIZED `M` AND IS NOT AN `M`.** On the evidence above it is at minimum: a gate, a behavioural
    change to pause, a durable-stop sweep, an enforcement location that does not yet exist, a migration, two
    consequential fixes, and an unruled HTTP surface. Splitting it is an owner decision — and the owner has now
    taken the first cut (§4.3): company-pause enforcement first, account half deferred.
14. **A REGRESSION THIS TICKET CAUSED AND FIXED, recorded because the class matters more than the instance.**
    The lifecycle gate outranks the stop gate in `decideDispatch`, and P6-007's held-work capture was keyed on
    *which refusal was reported* (`finalReason === 'emergency_stopped'`). So for a company that was both
    non-active AND covered by a live stop, the capture silently stopped running: no `held_work` row, no
    `running`→`paused`, and ADMIN-002's confirm-or-discard review lost that task. No fixture in this repository
    produces that combination, which is exactly why nothing caught it. **A merged trust-critical control disabled
    as a side effect of a new gate, with no test and nothing in the record.**

    **FIXED IN TWO STEPS, AND THE SECOND IS THE ONE TO COPY. This paragraph previously described the first, which
    CI REJECTED — a decision record documenting the rejected version of its own fix is the §9.14 failure mode
    reaching one level up, so read the correction as part of the finding.** The first attempt keyed the capture
    on `stopEvaluation.kind === 'stopped'` alone. `'a refusal for a DIFFERENT reason holds nothing — WITH a
    covering stop in force'` failed at once: a `not_registered` call that a stop merely happens to cover was
    never going to run, so it must not enter the review queue. What shipped is a **two-member set** —
    `dispatcher.ts:622` computes `stopInterrupted = finalReason === 'emergency_stopped' || finalReason ===
    'company_not_active'` and captures only when that **and** `stopEvaluation.kind === 'stopped'` hold;
    `audit.ts:1073-1077` guards `stop_scopes`/`held_by_stop_id` on the identical condition, via
    `stopExplainsRefusal`. *(That citation read `:1067-1071` for one commit — correct until the docstring rewrite
    in the very same commit pushed the guard down six lines. A line number invalidated by its own commit.)* The
    distinction is
    between a call the stop **interrupted** and one that was never going to happen. **The general rule: a new
    gate that outranks an existing one inherits responsibility for every side effect the old one carried** — a
    duty on the author, not something the code does by itself; what it did by itself was the bug. Nothing in this
    repo enforces that rule; it is a review finding,
    and a future gate inserted above another will need the same check made by hand.

## §10 Slices

1. **CDR + branch + draft PR** — done, then rewritten against the investigation.
2. **Contracts** — DONE: the widened vocabulary (`company.ts:14-16`), the two-phase transition table, and the
   gate as a pure total function (`lifecycle-gate.ts`). It was **unblocked by every open question above**,
   because the allowlist form is correct whichever value the account vocabulary settles on.
3. **Migration** — DONE (`0054`): `companies_status_valid` widened, and `tool_calls_denial_reason_valid` widened
   for the new denial reason (without which the dispatcher's denial INSERT raises 23514 and aborts the
   transaction, losing the refusal's own evidence). The account half waits on §9.2.
4. **Enforcement** — DONE for the four new-work points (§4.3). The worker bodies remain §9.3.
5. **The transitions + the durable-stop sweep** — NOT DONE. The sweep is §9.5 (*"Does pause now raise a real
   halt?"*) and the transitions depend on it. Consequence, stated plainly: **nothing can reach `deactivating` in
   production yet**, so the two new states are reachable only by a direct database write and
   `company.deactivated` is never emitted (§9.10). The GATE is live for `paused`, which is what the owner's
   ruling asked for first.
6. **Real-PostgreSQL Gate-14 suite** — DONE, and **mutation-proven**: a disposable probe branch that neutralised
   the gate without touching a test turned 8 of the suite's then-17 cases red through production paths. **Two
   caveats this ticket owns**: the probe was not preserved and no CI run is cited (ACBP-P6-006's labelled probe
   commit `fe85082` is the standard to copy), and the suite is 18 cases since the dispatch control landed.
7. **Review and docs** — DONE, and it took **four** passes, not one. **FINALIZATION IS NOT DONE**: setting the row `Done`, marking the PR ready and merging are owner gates and none has been taken. (This slice read `Review, docs, finalization — DONE` while the status line four paragraphs below said the merge gate was untaken — the same defect as the worst finding of the third pass, surviving in the slice list of the document that records it.)
   - The code review (six lenses → per-finding refutation → completeness critic) is recorded in
     **`docs/implementation/P7-002-REVIEW-COVERAGE.md`**, including the finding that matters most to future
     tickets: **this ticket silently disabled a merged trust-critical control** — see §9.14.
   - A **third pass over the documentation itself** then found **36 confirmed defects, 7 HIGH, every one in
     prose** — including this CDR still documenting the fix CI rejected (§9.14), §0/§1 asserting in the present
     tense a state of affairs this branch had already changed, and PROJECT-STATE plus the backlog row recording
     the ticket as **merged** when merging is an untaken owner gate. That pass is why §0 now carries a temporal
     header and §1's rows carry arrows.
   - The docs pass corrected **three** architecture documents: `EVENT-CATALOG.md:40`,
     `WORKFLOW-STATE-MACHINES.md §1`, and `REQUIREMENT-TRACEABILITY.csv`'s COMP-006 row — **which turned out to
     be a fifth false artefact**, certifying `Covered (MVP)` against two test suites that did not exist. §1.1
     names four; the count is five. Leaving any of them would preserve the exact mechanism that hid this gap for
     six phases.

**Status of the ticket as a whole: NOT MERGED and NOT DONE.** PR #74 is an open draft; merging is an owner gate.
The backlog row says so in prose rather than `Done` (P6-002's precedent). Slice 5 is unbuilt and two acceptance
clauses are unmet — *"deactivate-then-schedule negative green"* holds for `paused` only, and *"reactivation
documented"* needs §9.7 (and §9.8 for the held-work half). Both are owner decisions.

What IS true, and was not true before this branch: **a paused company can no longer start a run, enqueue a job,
run a job step, or dispatch a tool call** — proved against real PostgreSQL by the database rather than by a
return value: the *absence* of the `task_runs`, `jobs` and checkpoint rows, and for the dispatcher the
*presence* of a `tool_calls` row whose `denial_reason` is `company_not_active`, because TOOL-002 requires the
refusal itself to be recorded.
