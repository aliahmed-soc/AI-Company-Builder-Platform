# CDR-068 — Approval engine and inbox (ACBP-P6-003)

**Requirements:** APPR-002, APPR-003, APPR-007, APPR-010 · **ADRs:** ADR-009 · **Architecture:**
`APPROVAL-AND-POLICY-ARCHITECTURE.md §1–§3`, `diagrams/08`, `API-CONTRACTS.md` (Approvals row)
**Security:** invariant 5 (a model can never approve its own action), trust-critical #5
**Depends on:** ACBP-P6-001 (merged), ACBP-P6-002 (merged — `338ae08`)

---

## §0 What this ticket carries that is not its own

Two obligations land here from ACBP-P6-002, and both are **acceptance conditions**, not extras.

### §0.1 — CLOSING THE CALLER-INJECTABLE APPROVAL PORT

P6-002 deleted `ToolGates.policy` because *a gate a caller may omit will eventually be omitted*. The same argument
applies verbatim to `ToolGates.approval`, and P6-002's adversarial review reported it as a bypass: a caller can pass
`{ gates: { approval: () => ({ kind: 'allow' }) } }` and satisfy an approval that policy **demanded**, with no
approval record consulted anywhere.

It was left open deliberately (CDR-067 §2-G10) for one reason only: **there was no approval store to consult.**
Deleting the port then would have made every `require_approval` an unconditional deny and left the
approve-and-proceed path unexecuted by any test — the D1 unreachable-path shape this repository has been bitten by
repeatedly. That reason expires the moment this ticket lands a store.

**`tools/check-approval-port.mjs` will fail the build as soon as it does.** It is already in `check:static`, it
detects the store by either the approvals module ceasing to be a scaffold or a migration creating an `approvals` /
`approval_*` table, and its message says the fix is to delete the port. So this is not an obligation a reader has to
remember — it is one the gate will insist on. **P6-003c closes it.**

### §0.2 — WIRING POLICY EVALUATION POINT 2

`APPROVAL-AND-POLICY-ARCHITECTURE §5` point 2 is *"approval requested → decision context correctness (policy version
recorded into the approval)"*, skippable **only** when point 1 concluded `not_required` and no approval exists.
P6-002 could not wire it because there was no approval request to hang it on. There is one here.

Point 2's purpose is precise and worth stating so it is not mistaken for a duplicate of point 3: the approval record
must carry **the policy version the decision was made under** (`§2`'s binding table), so a decision can be re-read
against the rules that were in force when a human made it. Point 3 re-checks at execution; point 2 is what makes the
decision itself explicable.

**Point 1 remains an OWNER GATE** (CDR-067 §1) and is not in this ticket.

---

## §1 The sub-scope split

P6-003's backlog row spans a data model, an engine, an API and a Decision Room inbox. That is too much for one
reviewable slice, and one part of it is gated. Split as P6-001 was, for the same reason: each sub-scope has to be
provable on its own.

| Sub-scope | Owns | Gate? |
|---|---|---|
| **P6-003a** | contracts: request content completeness (APPR-002), the five decision paths (APPR-007), previews (APPR-010), approval scopes, actor-type restriction expressed in the TYPES | no |
| **P6-003b** | migration: `approval_requests` + append-only `approval_decisions`, company-owned dual-keyed FORCE RLS, actor-type rejected at the schema level | no |
| **P6-003c** | the service + API: create request, decide (five paths), read inbox; **§0.1 close the port**; **§0.2 wire point 2** | no |
| **P6-003d** | the Decision Room inbox UI, and *"all content fields render"* | **OWNER GATE — all frontend work** |

**What P6-003 does NOT own.** Payload-hash binding, expiry, revocation and single-use consumption are **ADR-009 §2
and ACBP-P6-004**. This ticket creates and decides approval requests; it does not make an approval a
cryptographically bound, consumable token. The distinction matters for §0.1: closing the port means the dispatcher
reads a real decision from the store instead of a caller's lambda — it does **not** yet mean the decision is
hash-bound to the payload. P6-004 adds that, and until it does, an approval authorizes the action it names rather
than the exact bytes.

Recorded as sequencing, not omission — and flagged because the difference is easy to overstate in a commit message.

---

## §2 P6-003a gates

### G1 — the actor-type restriction is a TYPE, not a check

**Decision.** The decision-writing contract accepts only a human or delegated actor. A worker/model/system actor is
**not expressible** in the type that records a decision, and the database rejects it independently (P6-003b).

**Why both.** Invariant 5 is the chain's *non-negotiable* property and canon states the mechanism outright:
*"approval decisions are writable only through the approval API, which rejects non-human/non-delegated actor types at
the schema level; worker/model actors have no code path to it."* A runtime `if` is a code path — it can be forgotten
at a second call site. A type that cannot express a worker actor cannot be forgotten, and the schema check catches
anything that reaches the database by another route. P6-002's experience is the precedent: the guarantees that held
under adversarial review were the structural ones, and the one gap review found was a value forwarded unvalidated.

### G2 — an INCOMPLETE request is not a request

**Decision.** APPR-002's content set is required at construction; a request missing any field is refused, not stored
with nulls.

**Why.** The requirement's own failure clause is *"Full-content requirement blocks incomplete requests."* A stored
request with missing content is a request a human cannot evaluate, and the inbox would render a blank where the
consequence should be. Refusing at construction makes "every stored request is decidable" a property of the table
rather than a hope about callers.

### G3 — five decision paths, closed, and each one records what it did

**Decision.** `approve | reject | edit_then_approve | schedule | batch_approve` — the five `API-CONTRACTS` names, as
a closed vocabulary. `edit_then_approve` produces a **new** bound payload and supersedes the old request; it never
mutates it (§2's material-change rule, invariant 7).

**Why closed and why now.** The required test row is *"Five-decision-path tests"*, and a decision vocabulary that can
grow silently is one where a future sixth path inherits whatever the `else` branch happens to do. Same reasoning as
CDR-066 §3-G1 for policy decisions.

### G4 — a preview is a CLAIM about execution, and it has to be checkable

**Decision.** A preview is stored with the request, and for previewable types the preview and the execution payload
must derive from the **same** normalized structure — so "preview equals execution" is a test that can fail.

**Why.** APPR-010's verification is *"Preview-equals-execution tests"*. A preview generated by a separate code path
is a preview that can drift from what runs, and a human approving a drifted preview has approved something that will
not happen. This is the same defect class as CDR-067 §2-G9: a property resting on a mechanism that is not its own.

### G5 — the data model supports all four scopes; only two ship

**Decision.** The scope vocabulary carries all four of §3's scopes; MVP accepts `one_action` and `limited_batch` only,
and the two post-MVP scopes are refused at the service boundary with an honest reason.

**Why.** Canon is explicit that *"the data model supports all four so later levels are additive"* while MVP is
autonomy levels 1–2. Modelling all four and refusing two is additive later; modelling two and widening the column is
a migration and a backfill.

### G6 — no default expiry VALUES are invented here

**Decision.** Expiration is APPR-005 and P6-004. This ticket stores no expiry defaults and ships no per-risk-class
timeouts.

**Why.** Same discipline as CDR-066 §3-G8 and AOQ-14: a limit value that looks like a decision but was never ruled is
worse than an absent one, because the next reader treats it as ratified.

---

## §3 Status

This document was written first, as the design record. It is now updated against what was actually built, because a
design record that still describes intentions after the code lands is the same failure as a claim without a test.

**IMPLEMENTED AND MERGED: P6-003a (contracts), P6-003b (migration 0047), P6-003c (repository, service, port
closure, evaluation point 2).** Both carried obligations are met — `gates.approval` is deleted, and the policy
version the human decides under is recorded onto the request at point 2.

**NOT IMPLEMENTED: §2-G4, preview-equals-execution (APPR-010).** `preview` is free text validated only for
blankness, with no relationship to `data`, so the drift this gate exists to prevent is currently possible: a human
approving a drifted preview has approved something that will not happen. This is NOT the payload-hash binding
deferred to ACBP-P6-004 — that is the other half, and conflating them is how the gap survived review once already.
A **failing-by-design marker test** in `packages/contracts/src/approvals/request.test.ts` asserts the gap so it
appears in every run rather than resting here; implementing the derivation breaks that test on purpose and brings
whoever does it back to this section.

**~~NOT IMPLEMENTED: scope enforcement and single-use consumption.~~ CLOSED BY ACBP-P6-004** (CDR-069). `scope` was
stored and shown to the deciding human but not applied at the gate — one `approve` on a `one_action` request
authorized unlimited calls for the run's lifetime. Single-use consumption is that enforcement; the two were always
the same problem. `member_request_ids` is still enumerated and never read, so a `batch_approve` authorizes only its
own request — under-permissive, and therefore not a hole.

**NOT DONE: P6-003d, the approval inbox UI** — frontend, behind the owner's standing gate.

Two independent review passes ran before merge; the second mutation-tested the branch and found 15 of 35 source
mutations surviving. The defects that exposed, and their fixes, are recorded in `docs/agent/PROJECT-STATE.md`.
