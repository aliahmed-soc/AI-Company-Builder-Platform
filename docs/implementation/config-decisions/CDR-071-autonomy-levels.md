# CDR-071 — Autonomy levels 1–2 (ACBP-P6-006)

Governing: ADR-010; `MASTER-PRD-v1.md` §12 (action-risk model) and §11.5; APPR-008; PRD principle 2
(*"Informed autonomy — autonomy is only legitimate when granted knowingly"*).

Backlog objective, verbatim: **"Level setting drives approval defaults per risk class; levels 3-5 visible
disabled"**, with the failure clause **"Invalid config = most restrictive"** and **"Level changes audited"**.

---

## §0 What canon already settles, so this CDR does not re-decide it

**§12's table is explicit for levels 1 and 2 across all four risk classes.** There is no ambiguity to resolve
and therefore nothing here to interpret:

| Risk class | L1 | L2 |
|---|---|---|
| Informational | propose only | execute without approval |
| Internal & reversible | propose | execute; results reviewable |
| External | explicit per-action approval | explicit per-action approval |
| Sensitive / irreversible | explicit per-action approval at **every** level | same |

Plus §12's closing line: **"unclassified tools default to sensitive/irreversible"**, which is already implemented
as `MOST_RESTRICTIVE_RISK_CLASS` and needs no rule of its own.

**The unruled CDR-051 §0.3 class split does not block this ticket.** The implementation calls canon's third class
`external_reversible`; canon calls it `External` and says it is *"often irreversible in effect"*. That question
stays flagged and unruled. It cannot change any behaviour here, because **external and sensitive require explicit
per-action approval at both L1 and L2** — the two levels this ticket ships. Whichever way the split is later
ruled, the L1/L2 table above is unchanged.

---

## §1 The finding that shapes this ticket

**`DEFAULT_NEW_COMPANY_POLICY` ALREADY IS LEVEL 2, AND IT IS OWNER-RULED.** The constant in
`packages/contracts/src/policy/evaluate.ts` carries the owner's decision of **2026-07-29**:

> *"informational and internal-reversible actions are allowed by default; anything at a higher risk class requires
> approval; nothing is denied outright by the baseline alone."*

That is §12's L2 row, behaviour for behaviour. So this ticket is **not** introducing autonomy semantics into a
system that had none — it is *naming* a posture the platform already has, and adding the one that is stricter.

Consequences, all of which keep the change additive:

- The **L2 rule set is the existing constant**, not a new one written from prose. Re-deriving it would risk
  shipping a second, subtly different definition of what executes without asking.
- **L1 is the new thing**: propose-only, every risk class requires approval.
- Nothing about an existing company's behaviour changes when this merges. See §2-G3.

---

## §2 Gates

### G1 — The level is a PROFILE that selects rules, never a dimension rules test

`POLICY_DIMENSIONS` is closed and taken from ADR-010 §5. Autonomy level is not in it and must not be added.
A dimension is something an observed fact is compared against; the autonomy level is the *configuration that
decides which rules exist*. Modelling it as a dimension would let a company's rule set contain a rule about its
own autonomy level, which is a loop with no defined meaning.

It is therefore a **column on `policies`**, the table that already versions a company's rule set.

### G2 — The level COMPOSES with stored rules, most-restrictive-wins; it never replaces them

**This is the gate that matters most, because getting it wrong lets the AI act without approval.**

A policy row has both a level and stored `rules`. If the level merely *selected* a rule set, then a company at
L1 whose stored rules were the permissive set would have two contradictory answers to "does this need approval",
and the wrong one is the one that executes.

So the level's rules are evaluated **in addition to** the stored rules, and the result is combined with the
existing most-restrictive ordering (`combinePolicyVerdicts` / `resolvePolicyDecision`). Consequences, stated as
guarantees:

- **A level can only ever tighten, never loosen.** Adding L1 to any policy cannot make something execute that
  did not execute before.
- A company at **L1 cannot execute anything without approval regardless of what its stored rules say.**
- The evaluator stays pure and total; this is composition of verdicts it already knows how to combine.

### G3 — Existing companies are backfilled to LEVEL 2, and that is deliberate

Existing `policies` rows predate the column. Their current effective behaviour **is** L2, because that is what
the owner-ruled default constant does.

**Backfilling them to L1 would silently tighten every existing company.** That reads as the "safer" choice and is
not: it would override an accepted owner decision (canonical source priority #1) under cover of caution, and
change behaviour in a ticket whose objective is to add a setting. The safer-reading rule applies to what is
**unknown**; the default posture is not unknown, it is ruled.

So: backfill `2`, `NOT NULL` thereafter, and **no existing company's behaviour changes on merge.**

**FLAGGED FOR THE OWNER, because it is the one judgment call here about what the AI may do unasked:** new
companies will continue to start at **level 2**, meaning research and internal drafting execute without asking on
day one, exactly as ruled on 2026-07-29. If the owner wants new companies to start at L1 instead, that is a
one-line change to the default and this CDR is where to record it.

### G4 — An unreadable or out-of-range level resolves to LEVEL 1, and that IS most restrictive

Distinct from G3 and the reasoning is different. A missing, non-integer, out-of-range or otherwise unusable
stored level is **not a configuration anyone chose** — it is corrupt data. The backlog's own clause is *"invalid
config = most restrictive"*, and the most restrictive level is 1.

This mirrors `MOST_RESTRICTIVE_RISK_CLASS` and, like it, is **derived from the level list rather than written as
a literal**, so it cannot drift if the set is revisited.

**It is mutation-tested, not asserted in a comment.** Breaking the collapse must turn tests red; if it does not,
the guard is decoration.

### G5 — Levels 3–5 are STORABLE but REFUSED, and the refusal is the deliverable

Following the P6-004 precedent, where all four canon approval scopes are storable so later levels are additive
while the service accepts only the two MVP ones (migration 0047's own comment says so).

- The CHECK constraint admits **1–5**, so no migration is needed when later levels ship.
- The service accepts **1 and 2 only**; 3, 4 and 5 return a **typed refusal naming the level as not available in
  MVP** — never a thrown error, never a silent clamp. A silent clamp to 2 would be the worst outcome: a founder
  who asked for level 4 would believe they had it.
- `MASTER-PRD-v1.md` §11.5 and §12 are the authority for 1–2 being the MVP set.

**The "visible disabled" READ MODEL is in scope; the SURFACE that renders it is not.** This ticket ships the
data a UI would need — which levels exist, which are available, and the plain-language consequence of each
(PRD principle 2 requires the consequence, not just the number). **It ships no UI.** That is an owner gate and
the owner's bar for the interface is high; nothing will be scaffolded here to "iterate on later".

### G6 — Level changes are audited, and the existing event already does it

A level change is a **new policy version**, because the level lives on the versioned `policies` row. That path
already emits `policy.changed` and already supersedes the prior row. No new audit event, and no second way to
change a policy.

If a level change did not produce a new version, the evaluation record would name a version whose meaning had
since changed — which is precisely what ADR-010's "versioned" requirement exists to prevent.

### G7 — No default limit VALUES, again

AOQ-14 is untouched. This ticket adds no numeric threshold on any limit dimension. The autonomy level is a
posture, not a limit, and `evaluate.ts` already carries a test asserting the absence of numeric thresholds — that
test must stay green.

---

## §3 Status

_Written first. Updated against what is built, including anything it got wrong._
