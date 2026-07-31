# CDR-072 — Emergency stop and resume review (ACBP-P6-007)

Governing: ADMIN-001, ADMIN-002, COMP-006 (full); ADR-010; `diagrams/13-emergency-stop.mmd`;
`FAILURE-AND-RECOVERY.md` row 15; **invariant 14**; **launch gate 8**; **trust-critical #9 and #10**.

Canon's two trust-critical clauses, verbatim:

> **9. Paused company cannot start new autonomous work.** *(P6-007)*
> **10. Emergency stop blocks new external execution (all scopes, ≤5s).** *(P6-007)*

And the diagram's legend: *"seven stop scopes; dispatcher checks stop-state before EVERY tool call (invariant 14)"*,
with *"stop-system failure = block platform-wide (fail closed)"*.

---

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

### G6 — Safe-stop follows OQ-14's documented default; in-flight work is HELD, never lost

OQ-14 is **non-blocking with an MVP default already documented**: *"finish the current tool call, halt before the
next, hold the task visibly."* So this is not an owner question — it is a recorded decision to implement.

The held-work queue is *"visible, nothing lost"* (diagram 13). A held item is a record, not a deletion.

### G7 — Resume requires REVIEW, and nothing auto-fires

ADMIN-002: clearing a stop opens a **mandatory** review — confirm or discard each held item — and
**expired approvals are NOT resurrected** (which P6-004 already guarantees: consumption and expiry are properties
of the approval row, and a held item cannot revive one). *"Nothing auto-fires on resume"* is the clause; a resume
that silently re-ran held work would be the same betrayal as a stop that missed a scope.

### G8 — A STOP THAT PARTIALLY WRITES MUST NOT POLITELY REFUSE

The class P6-006's review pass 1 found, applied before it can bite: `runInCompanyScope` runs its callback **inside**
the account transaction, so a `return { status: 'refused' }` after a write **commits that write**.

For a stop this is worse than it was for autonomy levels. A stop activation that wrote some rows, hit a problem,
and returned a typed refusal would leave the system **partially stopped while telling the operator it did not
stop** — the exact inverse of the §0 failure and just as dangerous, because the operator's belief and the system's
state disagree in a way neither will surface.

So: within an activation or a resume, any failure after the first write **throws**, rolling the transaction back to
a state someone actually chose. Refusals that happen *before* any write stay typed refusals. Proven the way P6-006
proved it — force the failure, assert the call rejects **and** that no partial stop state survives.

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
