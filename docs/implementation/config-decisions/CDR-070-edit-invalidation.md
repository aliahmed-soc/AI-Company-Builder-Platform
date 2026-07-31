# CDR-070 — Edit invalidation and edit-then-approve rebinding (ACBP-P6-005)

Governing: ADR-009; `APPROVAL-AND-POLICY-ARCHITECTURE.md` §2; APPR-004/007; trust-critical #6; **launch gate 4**.

The clause this ticket exists for, verbatim from `TEST-AND-VERIFICATION-STRATEGY.md` §Trust-critical:

> **6. Editing a material approved payload invalidates approval.** *(P6-005)*

and `REQUIREMENT-TRACEABILITY.csv` APPR-007's mechanism: **"Edit rebinds hash"**. M6's user-visible criterion is
*"modified approved payload requires reapproval"*.

This is a **Testing** ticket, and the evidence is the deliverable. But writing the proof surfaced one thing that
was assumed rather than enforced, and §1-G2 closes it.

---

## §1 Gates

### G1 — The proof is a MATRIX over the bound elements, not a single case

`APPROVAL-AND-POLICY-ARCHITECTURE.md` §2's material-change rule names four things: **payload, tool, destination,
cost bound**. P6-004 binds three of them (destination has no representation yet and lives inside the payload), and
the binding also covers the tool VERSION.

A single "changed payload is refused" test would pass while three of the four elements did nothing — which is not
hypothetical: P6-004's review found the tool-version component inert precisely because nothing varied it. So gate
4's evidence is one case per bound element, each changing exactly one thing, plus the unchanged control that proves
the suite is not simply refusing everything.

**A CONTROL IS MANDATORY IN EVERY GROUP.** A negative suite with no positive case cannot distinguish "correctly
refuses a modified payload" from "refuses everything", and the second would also pass every assertion.

### G2 — `edit_then_approve` must PROVE its successor carries the edit; it currently only claims it

`decideApproval` accepts `supersededByRequestId` and checks nothing about it. Any pending request in the company
satisfies it — including one bound to a completely different action. So the chain a human relies on…

> *"not those 500 recipients — these 3"* → the old approval dies → the new one carries the 3

…holds only because callers are expected to behave. APPR-007 states the mechanism as **"Edit rebinds hash"**, and
an unverified rebinding is not a rebinding.

**The successor must be bound to exactly the edited payload**, verified with the same
`computePayloadBinding` the gate uses: recompute from `editedData` against the successor's own tool, version and
cost bound, and require it to equal the successor's stored `payload_hash`. It must also be **pending**, and for the
**same run and tool** — an "edit" that changes the tool is not an edit, it is a different action, and the
material-change rule already says a changed tool invalidates.

This makes the human's sentence true by construction: a decision that says "I edited it to X" cannot be recorded
unless a live request is bound to X.

### G3 — Invalidation is proven AT THE DISPATCHER, not only in the contract

`bindingMatches` returning `false` is a unit fact. Gate 4's claim is about EXECUTION: the modified action does not
run. Every matrix case therefore ends at `dispatchToolCall` and asserts `denied`, and asserts the approval was **not
consumed** — a refusal that burned the approval would deny the modified call and the legitimate one alike.

### G4 — No new schema, no new events

Everything needed exists: the binding columns, the append-only decision, `superseded_by_request_id`, and
`approval.approved` carrying `edit_then_approve` in its path metadata. A Testing ticket that grows a table is a
Testing ticket that has changed scope.

---

## §2 Status

Written first; updated here against what was built.

**ALL FOUR GATES BUILT.** §1-G2 was the only behaviour change and it closed a real gap — `supersededByRequestId`
was accepted with no check at all, so "Edit rebinds hash" was a caller convention rather than a platform guarantee.
G1/G3 are the gate-4 evidence; G4 held (no schema, no events).

### Where the gate-4 evidence lives

| Claim | Evidence |
|---|---|
| A changed PAYLOAD does not run | `packages/core/src/tools/policy-enforcement.integration.test.ts` — `describe('gate 4 …')`, two cases |
| A changed TOOL does not run | same block |
| A changed TOOL VERSION does not run | same block — the element P6-004 shipped inert |
| A changed COST BOUND breaks the binding | same block, asserted at the CONTRACT (see the limit below) |
| The unchanged action still runs | same block — the mandatory control |
| A refusal does not BURN the approval | asserted in every negative case, and proven by running the legitimate call after each |
| An edit REBINDS to a live request carrying it | `packages/core/src/approvals/approval-service.integration.test.ts` — four cases incl. the control |

### The one element proven at the contract, not the dispatcher

The COST BOUND is bound by the hash and asserted there, because `dispatchToolCall` has no cost input and
recomputes with the request's own stored bound — CDR-069 §3 records this. Canon's *"execution exceeding bound limit
fails closed"* is the worker runtime's check at execution (P5-005). The binding is ready for it; the dispatcher
cannot be the place that catches cost drift.

### What this ticket did NOT change

No schema, no new audit events, no new authz action. `edited_data` is still not APPLIED anywhere — the successor
request carries the edited payload because a human raised it that way, and §1-G2 now verifies that it does. Nothing
here plumbs an edit into an execution automatically, and nothing should until there is a decision about who authors
the successor.
