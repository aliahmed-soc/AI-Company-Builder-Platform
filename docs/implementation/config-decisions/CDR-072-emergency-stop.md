# CDR-072 — Emergency stop and resume review (ACBP-P6-007)

Governing: ADMIN-001, ADMIN-002, COMP-006 (full); ADR-010; `diagrams/13-emergency-stop.mmd`;
`FAILURE-AND-RECOVERY.md` row 15; **invariant 14**; **launch gate 8**; **trust-critical #9 and #10**.

Canon's two trust-critical clauses, verbatim:

> **9. Paused company cannot start new autonomous work.** *(P6-007)*
> **10. Emergency stop blocks new external execution (all scopes, ≤5s).** *(P6-007)*

And the diagram's legend: *"seven stop scopes; dispatcher checks stop-state before EVERY tool call (invariant 14)"*,
with *"stop-system failure = block platform-wide (fail closed)"*.

---

> ## ⚠️ READ THIS BEFORE ANYTHING ELSE: SEVEN SCOPES ARE NAMED, **FIVE** ARE ENFORCEABLE
>
> `capability` and `integration` stops are **STORABLE AND INERT** in this release. The tool registry carries no
> identity for either, so no call can be matched against them. They are **refused at activation**, and a stored one
> makes the evaluation **unreadable → deny** rather than being silently ignored.
>
> **Nobody reading this document, the backlog row, `PROJECT-STATE`, the PR, or any read model may come away
> believing a stop can halt a capability or an integration.** It cannot. See §1-G10.
>
> Enforceable: `task` · `worker` · `company` · `external_actions_only` · `account_wide`
> Inert: ~~`capability`~~ · ~~`integration`~~

## §0 The thing that makes this ticket different

**A STOP THAT SILENTLY FAILS TO REACH ONE SCOPE IS WORSE THAN NO STOP AT ALL**, because the operator believes it
worked and stops watching. Every gate below is written against that failure rather than against the happy path.

Two consequences run through the whole design:

1. **The evidence must record which scopes actually halted**, not that a stop was requested. "The event fired" is
   not the requirement; "an operator can tell what is and is not running" is.
2. **There is no partial success.** A stop that cannot be established across its scope must report failure, not a
   success with a caveat nobody reads.

---

## §1 Gates

### G1 — THE `stop` PORT DIES IN THIS TICKET

`dispatcher.ts` currently takes stop through a caller-injectable port defaulting to `clear`, and its own comment
says exactly why that was acceptable:

> *"`stop` remains a port because its engine (P6-007) does not exist, and it defaults to `clear` rather than
> `unavailable`: with no stop mechanism in existence, no stop CAN be in force, so `clear` is simply true."*

**That default is true only until this ticket ships.** The moment a real stop engine exists, a caller-injectable
`stop` lets a caller assert `clear` and walk through a live emergency stop — the identical defect P6-003c closed
for approvals, where the dispatcher was made to consult the store itself so *"a caller cannot supply, override or
omit either answer"*.

So: the dispatcher reads stop state **from the store, itself**, `ToolGates` loses its last member, and a checker
mirroring `tools/check-approval-port.mjs` fails the build if the port returns. Deleting the port is not cleanup
here — it is the enforcement.

### G2 — Seven scopes, closed, from canon; and a stop check is a QUERY OVER SCOPES, not an equality

The scopes are the diagram's, exactly: **`task`, `worker`, `capability`, `integration`, `company`,
`external_actions_only`, `account_wide`**.

A call is blocked if **any** active stop covers it. That is deliberately a covering relation rather than a match:
an `account_wide` stop blocks a call whose task has no stop of its own, and `external_actions_only` blocks by the
tool's risk class rather than by identity. Implementing this as "is there a stop row whose scope equals this call's
scope" is the silent-miss failure §0 names, so the covering rule is a pure, exhaustively-tested function over
`(scope, target, call facts)`.

**SEVEN SCOPES MEANS SEVEN PROOFS, AND EACH PROOF HAS TWO HALVES.** For every scope:

- it **halts what it claims to halt** — the positive case; and
- it **does not halt what it should not** — the negative case.

Both halves are mandatory. A scope that over-halts is a different defect from one that under-halts, but it is
still a defect: an `external_actions_only` stop that also blocks internal drafting silently converts a targeted
safety control into a full outage, and the operator's mental model of what is running becomes wrong in the other
direction. A suite with only positive cases cannot distinguish "each scope covers exactly its own calls" from
"any stop blocks everything", and the second passes every positive assertion.

The matrix is therefore **seven scopes × {covered, not-covered}**, driven off the closed scope list so adding a
scope without adding its two cases fails rather than passes quietly.

**AND THE MATRIX MUST RUN THROUGH THE DISPATCHER, NOT ONLY THE PURE FUNCTION — A MEASURED DEFECT, NOT A
PRECAUTION.** The covering relation being correct is *not* the same claim as the scope being enforced. A scope can
be exhaustively right in `evaluateStops` and still never fire, because the dispatcher cannot populate the identity
it matches on. That is not hypothetical: the first implementation resolved `task` and `worker` with
`select task_run_id, worker_id from worker_runs where id = <runId>`, and `runId` is a **`task_runs.id`**. The join
key matched nothing, ever — and `task_run_id` is not a task id either, so it could not have matched even had the
join been right. **Both scopes were storable, activatable, visible in the read model, and halted nothing**, while
the pure suite stayed green throughout. Two of five enforceable scopes silently enforcing nothing is §0 exactly,
and it survived to hosted CI inside the ticket written to prevent it.

It was caught by a **fixture guard that THREW instead of returning null**. Without that throw the `task` and
`worker` cases would have compared null against null and gone green — certifying two dead scopes as enforced. A
passing matrix is the most convincing way to ship this bug, so any helper resolving an identity the assertion
depends on must fail loudly when it cannot produce one.

### G3 — UNAVAILABILITY IS NOT "CLEAR", and the dispatcher already knows it

`decideDispatch` already distinguishes `emergency_stopped` from `stop_unavailable`, with canon's own note that
*"no stop is recorded" is a complete answer; "I could not check" is not*. Both already exist in the `tool_calls`
denial-reason CHECK (migrations 0036/0037).

This ticket must keep that distinction **true rather than merely present**: a failure to read stop state resolves
to `stop_unavailable` → denied, never to `clear`. Diagram 13's `failmode` node is the requirement —
*"Controller unavailable → fail closed: block execution platform-wide"* — and it gets a test that removes the
store's readability and asserts denial, not an assertion that the code "handles errors".

### G4 — The ≤5s halt is a PROPAGATION property, and the honest way to hold it is to have nothing to propagate

Launch gate 8 is *"seven-scope ≤5s halt"*. The tempting design is a cache with a refresh interval tuned under
five seconds, which converts a correctness property into a timing bet.

**Instead: the dispatcher reads stop state inside the same transaction as the call it is authorizing.** A stop
committed before that read is visible to it, so propagation is bounded by transaction visibility rather than by a
poll.

**THAT DESIGN ARGUMENT IS NOT THE EVIDENCE, AND MUST NOT BE MISTAKEN FOR IT.** "Satisfied by construction" is a
claim about the code as I understand it today; gate 8 is a claim about the system. So the gate-8 case **measures
elapsed time**: record a monotonic clock reading immediately after the stop activation commits, dispatch, assert
the call is denied `emergency_stopped`, read the clock again, and assert the delta is **under 5000 ms** — for
**every one of the seven scopes**, because a per-scope regression is exactly the silent miss §0 is about. An
assertion that it "eventually stopped" would pass on a design that took a minute.

**NO SLEEPS, AND A HARD RULE ABOUT WAIT BUDGETS.** If any helper here polls or waits, its wait budget must be
**strictly less** than the enclosing test timeout. A budget that meets or exceeds its own timeout makes the timeout
the only reachable outcome: the harness kills the test before the helper can report *what* it was waiting for, and
the single most useful line — the real diagnosis — is never printed. Wait budget strictly below timeout, and the
helper reports its own failure with the state it observed.

**If a later ticket introduces caching for load reasons, propagation stops being bounded by transaction visibility
and the timing case becomes the only thing standing between gate 8 and a regression.** Recorded here so that trade
is made deliberately rather than discovered.

### G5 — Stop evidence names the scopes, and the blocked calls are evidence too

`emergency_stop.activated` records **which scope and which target**, so the audit answers "what is halted", not
"someone pressed something". `FAILURE-AND-RECOVERY` row 15 also lists *blocked calls* as evidence: a call denied
`emergency_stopped` already writes a `tool_calls` row carrying its denial reason (TOOL-002), which is what lets an
operator see the stop actually biting.

**This is the review-pass-2 lesson from P6-006 applied in advance**: a requirement satisfied nominally (an event
exists) can be unmet in substance (the event cannot answer the question). The test asserts the stored payload
names the scope, not merely that the event fired.

**IMPLEMENTED, AND THE FIRST DRAFT WAS THE NOMINAL VERSION.** The activation event named its scope from the start,
but the *blocked call* — the other half of `FAILURE-AND-RECOVERY` row 15's evidence — recorded only
`denial_reason: 'emergency_stopped'`. That is the same defect one level down: an account-wide halt and a single
stopped task produced **identical** refusal records, so the trail could not answer how far the stop actually
reached. `tool.call_requested` now carries `stop_scopes` — comma-joined scope NAMES from the closed vocabulary,
taken from the evaluation that decided the call rather than re-derived, present only on an `emergency_stopped`
refusal, and never carrying a target id into audit metadata.

Two scopes can never appear in it: `capability` and `integration` are not enforceable in this release and deny as
`stop_unavailable`, which is a *different* reason precisely so the two cases stay distinguishable in the record.

**And the enforcement itself is now proven per scope through the live dispatcher**, not only through the pure
covering relation. Each of the five enforceable scopes has a covering case and a non-covering one; the misses
include a cross-account and a sibling-company stop, because an over-broad tenancy predicate would turn one
company's halt into a platform outage that still reads as a correct stop. Without the misses, a dispatcher that
denied everything would satisfy all five positives.

### G6 — Safe-stop follows OQ-14's documented default; in-flight work is HELD, never lost

OQ-14 is **non-blocking with an MVP default already documented**: *"finish the current tool call, halt before the
next, hold the task visibly."* So this is not an owner question — it is a recorded decision to implement.

The held-work queue is *"visible, nothing lost"* (diagram 13). A held item is a record, not a deletion.

#### ⚠️ OPEN — an `account_wide` stop holds only the raising company's work (found in review, flagged not guessed)

**The halt is account-wide; the held-work queue is not.** The stop row carries `company_id NULL` and the dual-scope
RLS predicate makes it visible to every company in the account, so the dispatcher denies their calls correctly —
that half is proven by the enforcement matrix. But `held_work.company_id` is `NOT NULL` with a tenant-pinned FK to
`tasks`, and activation runs inside **one** company's scope, so only that company's in-flight tasks get rows.

Two consequences, neither cosmetic:

1. `held_count` on `emergency_stop.activated` and `pending_review_count` on `emergency_stop.cleared` count **one
   company**, not the account. They are not false — the events are company-stamped — but a reader can over-read
   them as the account-wide total.
2. **ADMIN-002's mandatory review never sees the other companies' in-flight tasks.** When the stop is cleared their
   next tool call simply succeeds, so for those companies work resumes with no confirm-or-discard decision.

> ### 🔴 CORRECTION — THIS SECTION STATED A NARROWER, MORE COMFORTABLE DEFECT AS FACT
>
> Point 2 above originally ended: *"'Nothing auto-fires on resume' currently holds **for the company the stop was
> raised from**."* **That was false, and it was written by the author of the defect.** The property held nowhere.
>
> An independent review pass found the real scope: `held_work.status` is written by `reviewHeldWork` and **read by
> nothing**. The dispatcher consults only `emergency_stops`; activation never changed `tasks.state`. So the moment
> the stop cleared, every held task's next tool call was authorized — whether its review said `held`, `confirmed`,
> or **`discarded`**. An operator explicitly discarding an item got the identical outcome to never reviewing at all.
> The confirm-or-discard decision was a bookkeeping row with no consequence, in the raising company as much as in
> any sibling.
>
> **The lesson is the shape of the error, not the error.** Having found a real gap (the sibling companies), the
> author described its blast radius as the smallest reading that was still bad news, and recorded that reading as
> established fact in three places — this CDR, `PROJECT-STATE.md`, and a direct report to the owner. A partial
> diagnosis stated confidently is worse than an open question, because it closes the question. **Wrong
> documentation is worse than missing documentation.**
>
> The sibling-company scoping described above is still true and still open. It is a *second* defect, not the one
> point 2 claimed to describe.

#### ✅ PM RULING (owner's authority) — OPTION B + OPTION C's LABELLING. NOT OPTION A.

**Attribution matters here and is recorded deliberately: the options and the recommendation were the implementing
engineer's; the CHOICE is the PM's, on the owner's authority.** This is a decision record, not a design the
implementation talked itself into.

The three options as they were put to the PM:

| | Mechanism | Buys | Costs |
|---|---|---|---|
| **A** fan out per company | Activation repoints `app.current_company` per company in the account (a supported primitive — `transaction-scope.adversarial` §TX-SCOPE-MUTATION records that raw `SET LOCAL` is available to trusted internal code; the guard is against cross-ACCOUNT forgery, not intra-account scoping), re-resolves the actor's role per company, writes `held_work` + pauses tasks | Queue and pause state COMPLETE at activation; `held_count` means what a reader assumes | O(companies × tasks) statements **before commit**, on the control whose promise is speed; and it widens the actor's authority across companies |
| **B** hold lazily at dispatch | When the dispatcher refuses with `emergency_stopped`, it writes the `held_work` row and pauses the task, in the company scope already established for that call | No scope switching, no new SECURITY DEFINER, no schema change; the property that matters becomes true | A halted task that never attempts a call is never held; the queue is "so far", not total; **a write on the refusal path** |
| **C** accept + surface | Activation stays single-company; the counts and read model state plainly that an account-wide queue covers the raising company only | Zero risk, zero latency, smallest diff | Leaves the BROADEST control with the WEAKEST evidence |

**RULING RATIONALE (PM):** *A pays its cost in critical-path latency on the one control whose entire promise is
speed, and it widens authorization across companies in a way that deserves its own decision rather than riding
along inside a stop implementation. B makes the consequential property true — nothing resumes unreviewed if it was
actually doing anything — at near-zero architectural cost. C alone leaves the broadest control with the weakest
evidence.*

**THE OBJECTION AGAINST THE CHOSEN OPTION, RECORDED BECAUSE IT IS THE REAL ONE.** B puts a write on the
dispatcher's **refusal path** and gives the chokepoint a **task-lifecycle responsibility it does not have today**.
The dispatcher's job is to *decide*; making it also *mutate task state* widens the most security-sensitive function
in the codebase. This was raised by the engineer against their own recommendation, and it was **weighed and
accepted, not overlooked**. **If a later ticket finds that responsibility causing trouble, C is the coherent
retreat** — drop the dispatcher write, keep the labelling, and the sibling-company gap becomes a documented,
accepted limitation instead of a fixed one.

**Three conditions are REQUIRED, not optional** (PM):

1. **The counts must state what they measure.** `held_count` at activation is a **floor, not a total**. Both the
   `emergency_stop.activated` payload and `readStopState` must say so explicitly. This is the piece that stops the
   fix becoming a NEW false assurance — this ticket already shipped exactly that over-reading defect once.
2. **The "a task that is halted but never attempts a tool call is never held" boundary must be stated LOUDLY**
   wherever the review queue is described, in the same style as the seven-named/five-enforceable loudness. Someone
   reading the queue must not be able to believe it is exhaustive.
3. **Idempotency on the refusal path is load-bearing and must be PROVEN**, not argued: `ON CONFLICT DO NOTHING`
   against `held_work_stop_task_uq` has to hold under repeated refusals against a real database.

#### ✅ PM RULING (owner's authority) — IN-FLIGHT SAFE-STOP AT ACTIVATION

**The canon finding is the engineer's; the choice of where the write lands is the PM's.**

**The finding.** Pausing the TASK does not stop the RUN. An independent review found a paused task still executing
tools after the stop cleared — nothing on the dispatch path reads `tasks.state`, so the pause only blocks
completion. Searching canon before proposing a mechanism (the J-13 pattern) showed canon does **not** put this at
the dispatcher. `WORKFLOW-STATE-MACHINES.md` §4 assigns the stop checks to **different actors**:

| line | transition | actor | the stop check |
|---|---|---|---|
| 54 | `queued→running` | **worker** | *"…**stop-state clear**; company active"* |
| 89 | `proposed→authorized` | **dispatcher** | *"…approval verify/consume where gated + **stop-state** + integration status"* |
| 15 | company `active→paused` | owner | Effects: *"no new job pickup (invariant 16); **in-flight safe-stop**"* |

For work **already running**, canon's answer is a safe stop, not another gate read. And the mechanism already
existed, simply never called from here: `task_runs.stop_requested_at` via `TaskRunRepository.requestStop`, which
`decideStepAdmission` checks **first** — *"an owner's request outranks every automatic rule and is not a failure"* —
ending the run as `stopped` rather than failed. That is OQ-14's *"finish the current tool call, halt before the
next"* exactly. Only `cancelRun` called it.

**RULING — the safe-stop is requested at ACTIVATION, alongside the `running → paused` transition, NOT on the
dispatcher's refusal path.** PM reasoning, recorded because it is not self-evident:

- Activation **already** enumerates and pauses the running tasks it caught. Those are exactly the runs needing a
  safe-stop; the information is in hand and no new lookup is required.
- It keeps the refusal path to **one** write rather than two. The objection recorded against Option B was the
  chokepoint accumulating responsibilities, and a second write there compounds precisely that unease.
- A safe-stop at activation reaches an in-flight run **that may never make another tool call** — which the
  refusal-path version structurally cannot, since it only fires when something tries to act. That is the same
  "never attempts, never held" gap, and activation closes it for the runs that matter most.

**The lazy dispatcher hold stays as ruled** — it covers work not yet running at activation. This is **additive**.

**What is NOT done, and stays undone deliberately:** the dispatcher still does not read `tasks.state`. A `paused`
task whose run somehow continues is not refused *for being paused*; it is refused because the stop is active, and
once the stop clears the safe-stop has already ended its run. The chokepoint's read set is unchanged.

### G7 — Resume requires REVIEW, and nothing auto-fires

ADMIN-002: clearing a stop opens a **mandatory** review — confirm or discard each held item — and
**expired approvals are NOT resurrected** (which P6-004 already guarantees: consumption and expiry are properties
of the approval row, and a held item cannot revive one). *"Nothing auto-fires on resume"* is the clause; a resume
that silently re-ran held work would be the same betrayal as a stop that missed a scope.

> #### 🔴 THIS GATE WAS NOT IMPLEMENTED, AND CANON ALREADY SAID WHERE IT LIVES
>
> **What was actually built:** `held_work.status` written by `reviewHeldWork`, read by nothing. No enforcement.
> The clause above was stated as satisfied and was not.
>
> **CANON FINDING, not a design choice.** The mechanism was searched for before proposing one, and the documents
> already specify it — the same pattern as J-13 settling the revision question and the autonomy default turning out
> to be the ruled company baseline.
>
> `WORKFLOW-STATE-MACHINES.md` §4 lists the task states as the core lifecycle *"with holds `waiting_for_input`,
> `waiting_for_approval`, `blocked_by_policy`, **`paused`**"*, and gives the transition row verbatim:
>
> | From → To | Actor | Pre | Effects | Audit | Usage | Retry |
> |---|---|---|---|---|---|---|
> | running→paused / paused→running | **system (company pause / emergency stop)** | **scope stop active** | held visibly; **resume requires review (ADMIN-002)** | audited | metered to stop | resumes from checkpoint |
>
> The same section's `queued→running` row already carries **`stop-state clear`** as a precondition, and
> `diagrams/13-emergency-stop.mmd` closes it: `clear stop` → *"MANDATORY resume review (ADMIN-002): confirm/discard
> each held item"* → *"**Confirmed items** resume from checkpoints"* — confirmed items, not all items.
>
> So enforcement belongs to the **task state machine**, which already owns the question "may this task proceed",
> and `paused` is already a legal state with `running → paused` and `paused → running` both already in the
> implemented `LEGAL_TRANSITIONS` table (shipped by P4-002 verbatim from WORKFLOW §4). Nothing new is being
> invented; a specified transition simply had no producer.
>
> **What that means concretely:** activation transitions covered in-flight tasks `running → paused`; a `paused`
> task returns to `running` only when its held-work review is `confirmed`; a `discarded` item never resumes.
>
> **Why NOT the alternative** (having the dispatcher consult `held_work` on every call): it widens the chokepoint's
> read surface and adds a failure mode — an unreadable `held_work` would have to fail closed and would then block
> everything, which is a new outage source bolted onto the control that exists to prevent uncontrolled behaviour.
> Canon points at the state machine; the state machine is also the narrower change.

### G8 — A STOP THAT PARTIALLY WRITES MUST NOT POLITELY REFUSE

The class P6-006's review pass 1 found, applied before it can bite: `runInCompanyScope` runs its callback **inside**
the account transaction, so a `return { status: 'refused' }` after a write **commits that write**.

For a stop this is worse than it was for autonomy levels. A stop activation that wrote some rows, hit a problem,
and returned a typed refusal would leave the system **partially stopped while telling the operator it did not
stop** — the exact inverse of the §0 failure and just as dangerous, because the operator's belief and the system's
state disagree in a way neither will surface.

So: within an activation or a resume, any failure after the first write **throws**, rolling the transaction back to
a state someone actually chose. Refusals that happen *before* any write stay typed refusals.

> **CORRECTION — the proof clause was aspirational and was written in the past tense.** This paragraph originally
> ended *"Proven the way P6-006 proved it — force the failure, assert the call rejects **and** that no partial stop
> state survives."* **No such test existed.** The independent review found the wider fact behind it: the whole stop
> controller had zero tests and zero callers, so every service-level guard here — including this one — was unproven.
> The rule is correctly implemented (the review traced all three functions and found no typed refusal after a
> write); it was simply never demonstrated. Restated as an obligation rather than an achievement, and discharged by
> the stop-service suite this ticket now owes.

### G10 — A SCOPE THE DISPATCHER CANNOT RESOLVE IS REFUSED AT ACTIVATION, NEVER SILENTLY INERT

**Found while wiring the dispatcher, and it changes what this ticket may ship.** The covering relation needs an
identity per scope. The tool registry carries `risk_class` and `external_effect` — and **nothing that identifies a
capability or an integration**. `tool_registrations` has no such column, and neither does any call fact.

So `capability` and `integration` stops **cannot be matched against any call today**. Shipping them as activatable
would create a stop the operator activates, sees recorded, believes is in force — and which can never match a
single call. That is CDR-072 §0's failure in its purest form, and it would be introduced *by this ticket*.

**The safer reading, taken deliberately:** those two scopes are **storable but not activatable**. The service
refuses them with a typed reason naming them as not yet enforceable, exactly as ACBP-P6-006 refuses autonomy levels
3–5 by name rather than clamping them. The schema admits all seven so later work stays additive; the enforcement
surface admits only the five the dispatcher can actually honour.

**AND A STORED INERT STOP DENIES — it is not merely un-activatable.** Without that, a `capability` row that
reached the table some other way would be compared against a `capabilityId` the dispatcher can never populate,
fail to match, and read as **clear**: a stop the operator activated, sitting in the database, silently permitting
everything. `evaluateStops` therefore returns `unreadable / scope_not_enforceable` for any inert scope, and it
does so BEFORE returning any covering match, so an inert row cannot hide behind a working one. Three tests pin
this, including one proving the inert stop is not rescued by a call that happens to carry a matching identity.

**REVERSIBLE IN ONE LINE.** When the registry gains a capability/integration identity, remove those scopes from
`NOT_YET_ENFORCEABLE_STOP_SCOPES` and add their two matrix cases. A test asserts the enforceable set and the
covering relation agree, and another asserts the 7/5/2 split by count — so the day the registry gains the field,
an omission surfaces as a failure rather than persisting as a quiet seven that behaves as five.

**FLAGGED FOR THE OWNER**, because it narrows a canon-named control: `diagrams/13` lists seven scopes and this
ticket makes five of them usable. The alternative — accepting activation for a scope that halts nothing — is worse
than the narrowing, but it is the owner's call whether the registry work should be pulled forward so all seven ship
together.

### G9 — Owner-only, and the stop must be easier to ACTIVATE than to clear

Activating a stop is a safety action; clearing one is an authorization. Both are owner-only (`ADMIN-001`), but the
asymmetry matters: nothing about activation may fail closed *into* running. If a stop activation cannot be
recorded, the caller is told it failed — and because unavailability denies (G3), the system is already refusing.

---

## §2 Slices

1. Contracts: the seven scopes, the covering relation, the stop-state answer type, audit events, authz actions.
2. Migration: stop-state records + held-work queue, dual-keyed FORCE RLS, append-only where canon says so.
3. Core: activate / clear / read; the dispatcher reads the store itself; **delete the `stop` port** + its checker.
4. Resume review: confirm/discard per held item; no auto-fire; expired approvals stay expired.
5. Real-PostgreSQL evidence, mutation testing of every guard, docs, two review passes.

---

## §3 Status

_Written first. Updated against what is built, including anything it got wrong._
