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

Written first. §1-G2 is the only behaviour change; G1/G3 are evidence. Updated against what was built before the
ticket is called finished.
