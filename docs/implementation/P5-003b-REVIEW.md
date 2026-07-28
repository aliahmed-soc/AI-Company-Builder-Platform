# ACBP-P5-003b — independent review record

Two full independent passes. **Both returned FAIL.** Design consequences are recorded in `CDR-054`.

Context worth stating up front: hosted CI on `9cb7d78` ran the 20-test dispatcher suite green on its **first** attempt,
zero skips (2260/2260). The real-database proof of the chokepoint therefore predates both passes rather than depending
on them — what follows is what reading found that a green suite did not.

---

## Pass 1 — the use case

Both findings are the same shape: **a value that looks present while carrying no meaning, accepted where a missing
value would have been refused.**

### HIGH-1 — a blank idempotency key silently suppressed an unrelated call

`params.idempotencyKey !== undefined` treated `''` as a real key. Two unrelated calls that both passed an empty string
would collide on the unique index, and the second would be reported as a **duplicate of the first** — a call suppressed
that was never a duplicate, and *another call's record returned as though it were this one's*.

**Fix.** Blank normalizes to absent. Proven with four dispatches across two blank shapes producing four rows, all with
a null key.

### HIGH-2 — a whitespace receipt satisfied the constraint TOOL-002 exists to enforce

TOOL-002 forbids claiming success for an external effect without a stored receipt. The use case tested
`.trim() === ''`, but the **database** tested only `receipt_ref is null` — so `'   '` passed the CHECK while evidencing
nothing. That is exactly the hollow success the rule exists to prevent, and the layer meant to hold when something
skips the use case was the layer that let it through.

**Fix.** `coalesce(btrim(receipt_ref), '') = ''` in the CHECK, and a blank receipt stored as NULL rather than kept as a
value that *looks* like evidence in the column the rule reads. Proven at both layers: the use case refuses it, and then
— bypassing the use case entirely — the constraint refuses the same update.

---

## Pass 2 — the record and the migration, against the fixed tree

### HIGH-3 — the record named the tool but not its VERSION

`EVENT-CATALOG` pairs them: *"tool_call_id, **tool_id+version**, risk_class, policy_eval_ref, approval_ref?,
idempotency_key"*. `tool_definitions` is versioned and the dispatcher resolves the **active, highest** version — so
without recording which one it used, re-registering a tool at v2 makes every earlier record ambiguous about which
definition, and therefore which risk class, actually applied.

On a table whose entire purpose is to be the evidence of what the chokepoint decided, that ambiguity **is** the defect.

**Fix.** `tool_version` as a column, a DTO field and audit metadata. Nullable, because an unregistered tool genuinely
has no version — and null says that rather than inventing a zero. The migration was unmerged, so this is an amendment
rather than a follow-up ALTER.

### MEDIUM-1 — two of the three CHECKs had no drift guard

Pass 1 shipped set-equality for `denial_reason` and stopped there. `outcome` and `risk_class` were still
one-directional: a value present in the constraint and absent from the contract would sail through, and on
`risk_class` that means **a class that dispatches without a rank**.

This is the third consecutive ticket where the same gap appeared — P5-003a pass 2, P5-002 pass 2, and now here — which
is itself the finding worth keeping: *shipping the guard for one constraint does not generalize on its own.*

**Fix.** Both now assert set equality, through a `constraintDef` helper that fails loudly on a renamed constraint
instead of comparing an empty set.

### Noted, and deliberately NOT changed

`tool_calls_risk_class_valid` names the four class literals, coupling it to the set `CDR-051 §0.1` flags as open. The
coupling is unavoidable for a constrained column, and `tool_definitions` already carries exactly the same one, so both
would change together. The receipt rule is the place where the coupling *was* avoidable — and there it keys off the
`external_effect` boolean instead of the class names, precisely so a re-shaping of the set needs no migration.

### Found clean

The order of operations against diagram 07; the idempotency pre-check sitting before the gates (re-running the gates
for a call that already happened could produce a *different* answer, and two contradictory records of one event); the
lost-race branch returning the winner's record rather than inventing a second; `complete` guarded on `requested`, which
is what stops an `unconfirmed` external effect from being upgraded after the fact; the absence of an FK on `tool_id`
(without which the required record of an unregistered-tool refusal could not be written); and the column-scoped UPDATE
leaving the digest, class, external flag and run linkage immutable.

---

## The standing limitation, restated so it is not mistaken for an oversight

**The allowlist is a parameter.** WORK-005 wants server-enforced least privilege and trust-critical #4 says allowlists
are *"versioned in worker definitions"* — which arrive in **P5-004**, a ticket that depends on this one. So the CHECK
is enforced here and unconditional (no allowlist supplied ⇒ deny), while the SOURCE becomes authoritative only once
P5-004 supplies it from a versioned worker definition. Deferring the source is sequencing; deferring the check would
have left the invariant unenforced on the surface built to enforce it.
