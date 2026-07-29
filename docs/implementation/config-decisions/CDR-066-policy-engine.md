# CDR-066 — Deterministic policy engine (ACBP-P6-001)

Status: proposed by the implementing session. Governs **ACBP-P6-001**, which the owner ratified on 2026-07-27 as a
**three-way split**, each sub-scope separately reviewable. Governing ADR: **ADR-010** (Accepted, owner review
2026-07-18 — this is the "owner-conditioned DoR split review" the backlog row refers to). Requirements: **POL-001,
POL-005, POL-006, TOOL-003, APPR-001**. Architecture: `APPROVAL-AND-POLICY-ARCHITECTURE.md §4/§5`.
Security: **invariant 5** (the model can never mark its own action approved), **PRD principle 17**.

---

## §0 — RESOLVED: a `require_approval` decision could be bypassed

> **OWNER RULING — DIRECT, 2026-07-29.**
>
> **Provenance, stated explicitly because it matters who decided this.** The owner ruled this **directly, in
> session**, in reply to the flag written below. Their words, verbatim and complete:
>
> > "Option A — waiver only when policy is unavailable"
>
> This is **not** my inference from a prior decision, and not an extrapolation from an accepted ADR. The options and
> the recommendation below are mine; the choice between them is the owner's, made after reading them. The distinction
> is the same one CDR-051 §0.3 draws about the unruled third risk class: a decision has to stay traceable to whoever
> actually made it, and an author's recommendation must never end up recorded as an owner's ruling.
>
> Fixed in `packages/contracts/src/tools/dispatch.ts` on this branch, test-first: the failing test was written and
> observed failing (`expected authorized to deeply equal denied`) before the one-line change. All 81 tool-contract
> tests pass afterwards, including every pre-existing waiver and injection-boundary test — the Phase 5 informational
> path is unchanged.
>
> **It landed here rather than in P6-002** because it is a known bypass with a decided fix, and building three
> sub-scopes on top of it would mean shipping the engine while the gate it feeds could be waived. §0's "this binds
> P6-002" no longer applies; what remains for P6-002 is wiring the engine into the dispatcher.

The record below is kept as written, because the reasoning is what justifies the change.

**This was flagged, not decided.** It is raised here because it is precisely the shape the owner asked to be stopped
on: a path where the AI could act **without approval when it should not**.

### The path

`decideDispatch` (`packages/contracts/src/tools/dispatch.ts`, ACBP-P5-003b/CDR-054) grants a **Phase 5 waiver** so
informational-class tools can run before a policy engine exists:

```ts
const waivable = CLASSES_THAT_PROCEED_WITHOUT_A_GATE.includes(riskClass); // ['informational']
const waived   = waivable && facts.untrustedContext !== true;
...
if (approval === 'unavailable' && !waived) return deny(waivable ? 'untrusted_context' : 'approval_required');
```

The waiver was written to stand in for a **missing** policy answer, and its own comment says P6 "makes this dead
weight rather than dangerous — once a real engine answers `allow`/`deny`, the waiver branch is unreachable."

**That reasoning holds for the policy gate and fails for the approval gate.** The dispatcher's `GateAnswer` is
`allow | deny | unavailable` — it has **no way to express `require_approval`**, which is one of ADR-010's three
engine outputs. So when the engine decides `require_approval`, the policy gate must answer `allow` (it is not a
denial), and the *approval* gate is what should enforce it. But for an informational-class tool on a trusted path,
`waived` is `true`, so `approval === 'unavailable'` does **not** deny — and the call is authorized with no approval.

### Why this is reachable, not theoretical

`require_approval` is not risk-class-derived. ADR-010 §5's MVP dimensions include **spending limits (POL-001)** and
**usage limits (NFR-015)**, neither of which is gated on risk class. A company at its spend cap running an ordinary
`informational` research tool is exactly the case: policy says "a human needs to okay this", and the waiver lets it
through.

### Observed, not inferred

A temporary probe called the shipped `decideDispatch` directly and was deleted after being read. The values below
are what it returned, not what this document reasoned it would return:

| Facts | Observed decision |
|---|---|
| `informational`, trusted, policy `allow`, approval `unavailable` | **`{kind:'authorized', riskClass:'informational'}`** |
| same, `untrustedContext: true` | `{kind:'denied', reason:'untrusted_context'}` |
| same, `riskClass: 'external_reversible'` | `{kind:'denied', reason:'approval_required'}` |

So the exposure is **exactly** the informational class on a trusted path — narrow, and real. The other two rows are
worth keeping in view because they show the mechanism is otherwise sound: the moment either the class rises or the
provenance is untrusted, the requirement is enforced.

### What I am NOT doing

Not changing `decideDispatch`, and not choosing a mapping. `decideDispatch` is P5-003b's merged contract and the
dispatcher wiring is **ACBP-P6-002**'s scope; more importantly, every available fix is a decision about when a human
must be asked, which is the owner's to make.

### The options, with my recommendation

| # | Option | Effect |
|---|---|---|
| **A (recommended)** | Withdraw the waiver whenever a policy engine **answered at all**. The waiver applies only when `policy.kind === 'unavailable'`. | Smallest change; restores the waiver's own stated intent ("stands in for a missing answer"). Once P6-001c ships, the waiver is genuinely dead weight, as CDR-054 predicted. |
| B | Widen `GateAnswer` to carry `require_approval`, and make that value non-waivable. | Most explicit; changes a merged trust-critical contract and every caller. |
| C | Remove `CLASSES_THAT_PROCEED_WITHOUT_A_GATE` entirely once the engine exists. | Strictest; also removes the informational path Phase 5 relies on until P6-001c is wired, so it must land *with* P6-002, not before. |

**I recommended A; the owner ruled A.**

### What the fix actually changed

```ts
const waived = waivable && facts.untrustedContext !== true && policy === 'unavailable';
```

One added conjunct. Two consequences worth naming:

- **The Phase 5 path is untouched.** When no engine has answered (`policy === 'unavailable'`), an informational call
  on a trusted path is still authorized — every pre-existing waiver test passes unchanged.
- **`untrusted_context` became unreachable on the approval line, so it was removed there.** Reaching that line now
  implies policy answered `allow` (a denial returns earlier, and a waived call cannot reach it), so untrusted
  provenance can no longer be the cause and `approval_required` is the honest reason. That is a proof about the
  control flow, not a simplification — and it is why the branch was deleted rather than left as dead code.

### §0.1 — The unreachability claim, independently verified

Deleting a branch from a security check on the strength of my own reasoning is not good enough here, so **the
unreachability claim specifically** (not the fix in general) was put to an independent adversarial reviewer whose
brief was to *refute* it and to default to "refuted" on any doubt. **Verdict: CONFIRMED.**

**The claim.** Whenever `if (approval === 'unavailable' && !waived) return deny('approval_required')` returns, it is
necessarily true that `policy === 'allow'`.

**The proof.** `gate()` is total onto exactly `{allow, deny, unavailable}` — it returns `kind` only after a strict
`===` against a string literal, so no `String` object or `Symbol.toPrimitive` can slip through. Then, per policy value:

| `policy` | Can the approval-line denial fire? |
|---|---|
| `deny` | No — `policy_denied` returns first. |
| `unavailable` | No — either `!waived` returns `policy_unavailable`/`untrusted_context` first, or `waived === true`, which makes the approval line's `!waived` false. |
| `allow` | **Yes, and only here.** `waived` is then necessarily `false`, since its third conjunct requires `policy === 'unavailable'`. |

`waivable` and `untrustedContext` add nothing: both feed only `waived`, which is pinned to `policy === 'unavailable'`.

**Verified by exhaustive sweep, not just by argument.** 4 risk classes + 5 invalid `riskClass` values × 10 gate-input
shapes (including `undefined`, `null`, `{kind:1}`, `new String('allow')`, a getter) for both gates × 4 stop shapes ×
3 `untrustedContext` values × 4 allowlists: **378** `approval_required` hits, **zero** with `policy !== 'allow'`, and
every one invariant under flipping `untrustedContext`. Adversarial probes — a flipping getter on `policy.kind`, and a
`Proxy` returning different objects on successive reads — both failed to refute: `facts.policy` is read exactly once.

**The reviewer found something stronger than the claim.** Naming that denial `untrusted_context` would have been
*actively wrong*, not merely lossy. The reason's own definition (dispatch.ts lines 45–47) is "a call that WOULD have
proceeded on the trusted path" — and with `policy === 'allow'` it would **not** have, because the same call is denied
identically on the trusted path. And nothing is lost: `DispatchDecision` carries `riskClass`, from which the caller
can recover `waivable`. `untrusted_context` remains reachable and accurate at its other site (the policy line), where
`policy === 'unavailable'` and `!waived` together do imply `untrustedContext === true`.

### §0.2 — Invariants this proof depends on (do not break these)

The point of recording these is that the proof is **conditional**. Each of the following is load-bearing; an upstream
edit that breaks one silently reopens the bypass closed above.

| # | Invariant | What breaks if it goes |
|---|---|---|
| **INV-1** | The `policy === 'deny'` and `policy === 'unavailable' && !waived` checks stay **above** the approval check, and the latter keeps its `!waived` guard | Moving the `unavailable` check below the approval gate, or dropping `!waived`, breaks the case split immediately |
| **INV-2** | `policy` stays **one `const` from one read** of `facts.policy` (same for `facts.untrustedContext` inside `waived`) | Inlining `gate(facts.policy)` at a second site lets a lazy or hostile `facts` object make the two reads disagree |
| **INV-3** | `waived` keeps `policy === 'unavailable'` as a conjunct | This *is* the §0 fix; removing it restores the bypass |
| **INV-4** | `gate()` stays total onto the three kinds, with `'unavailable'` as the fallback | A fourth return value breaks the exhaustive case split |
| **INV-5** | *(not a constraint — a reassurance)* the proof does **not** depend on the contents of `CLASSES_THAT_PROCEED_WITHOUT_A_GATE` | Adding classes to the waiver set cannot break this claim; verified across all four risk classes |

**Test coverage of these invariants, honestly stated.** INV-3 is pinned by the test *"an ENGINE-ALLOWED informational
call still needs an approval answer"* — it fails the moment the conjunct is removed. INV-1 and INV-4 are exercised
indirectly by the existing ordering and junk-input tests. **INV-2 is not covered by any test**, because it is a
property of the code's *shape* rather than its behaviour: a second read only diverges under a hostile `facts` object,
which no production caller constructs. It is recorded here as a review checkpoint rather than left to be
rediscovered.

---

## §1 The ratified split

The backlog's acceptance criteria are three clauses, and the split gives each one its own sub-scope, so each is
separately reviewable and separately provable.

| Sub-scope | Owns | Acceptance clause |
| --- | --- | --- |
| **P6-001a** — deterministic evaluation core | The CLOSED decision vocabulary; the versioned rule representation; the pure, total evaluator; most-restrictive-wins; unknown ⇒ most restrictive | *"Same inputs same decision"* |
| **P6-001b** — policy storage + append-only evaluation records | `policies` (company-scoped, versioned, immutable per version) and `policy_evaluations` (append-only, POL-006); repositories; RLS; the forbidden-list data | *"Forbidden beats approval"* (POL-005) |
| **P6-001c** — the engine service + fail-closed unavailability | `evaluatePolicy`: resolve the company's active policy version, evaluate, record the evaluation, return the decision; every unavailability path denies | *"Unavailability denies"* (TOOL-003) |

This CDR governs all three; **§2–§4 are P6-001a's scope**, and b/c amend it when they land.

---

## §2 What P6-001a owns

**A pure module, and deliberately so.** `decideDispatch` is the precedent and it is a good one: its own header says
*"a gate that can only be exercised through a database is a gate that is mostly untested. Here every combination is
a function call."* The determinism clause — *same inputs, same decision* — is only honestly testable if the evaluator
**is** a function of its inputs. So P6-001a ships zero database access and zero I/O.

In scope: the decision vocabulary, the rule representation and its versioning, the evaluator, the combination rule,
and the fail-closed defaults.

Out of scope: persistence (**b**), loading a company's policy (**c**), the dispatcher wiring (**P6-002**), approval
records (**P6-003/004/005**), autonomy levels (**P6-006**), emergency stop (**P6-007**).

---

## §3 Gates

### G1 — the decision vocabulary is CLOSED and ORDERED

**Decision.** `POLICY_DECISIONS = ['allow', 'require_approval', 'deny']`, ordered **least → most restrictive**, with
the order exported as the contract. `deny` carries an optional `escalate` flag (ADR-010's `deny(escalate?)`) as a
**field**, not a fourth value.

**Why ordered.** POL-005's "most restrictive wins" is meaningless without an order, and the same reasoning already
governs `RISK_CLASSES` (CDR-051 §2-G3). Making the order the contract means the combination rule is a comparison,
not a pile of conditionals that can disagree with each other.

**Why `escalate` is a field.** A fourth value would make every consumer's exhaustive switch treat escalation as a
different *outcome*, when it is the same outcome (the action does not happen) with a different *notification*.

### G2 — combination is most-restrictive-wins, and it is total

**Decision.** Combining N rule outcomes returns the maximum on the G1 order. An **empty** set of outcomes returns
`deny`, not `allow`.

**Why empty ⇒ deny.** This is the rule-gap risk ADR-010 §10 names ("unclassified → most restrictive; default-deny
posture"). A policy with no applicable rule has not permitted anything; it has failed to say. Returning `allow` for
"no rule matched" is how a default-open engine gets built by accident, one omitted rule at a time.

### G3 — determinism means the evaluator has no ambient inputs

**Decision.** The evaluator is a pure function. **The clock, usage counters, stop-state, integration status and
autonomy level are all INPUTS**, never read inside. No `Date.now()`, no randomness, no I/O.

**Why this is the whole acceptance clause.** "Same inputs same decision" is trivially true of a function with no
hidden state and unprovable of one with any. Working-hours rules (POL-004) are the temptation here — an evaluator
that read the clock itself would be untestable at 3am and would give two different answers to the same recorded
evaluation. The caller supplies the instant; the evaluation record stores it (b).

### G4 — total over `unknown`, and every unrecognised input is refused

**Decision.** The evaluator accepts `unknown` and is total. Malformed rules, unrecognised decision strings, absent
required facts, and NaN/negative counters all resolve to **the most restrictive applicable outcome**, never to
`allow`.

**Why.** `decideDispatch`'s `gate()` helper already sets this precedent verbatim: *"Treating an unrecognised value as
`allow` is the one mistake this module must never make."* The policy engine is the same class of component and the
same rule applies.

### G5 — model classifications are untrusted inputs, and are typed as such

**Decision.** Facts carry an explicit provenance marker distinguishing **registry/structured** values from
**model-suggested** ones. Where a trust-critical determination (risk class, spend, destination, forbidden match)
has only a model-suggested value available, the evaluator takes the **most restrictive** applicable path.

**Why typed rather than documented.** ADR-010 §5 and PRD principle 17 both require this, and a rule that lives only
in prose is a rule that the next caller passes a model string into. Making provenance part of the input type means
the compiler asks the question at every call site.

### G6 — every decision names the rule-set version it was made under

**Decision.** The evaluator takes a versioned rule set and returns the version in its result.

**Why.** `APPROVAL-AND-POLICY-ARCHITECTURE §2` binds "the policy snapshot the decision was made under" into every
approval record, and POL-006 makes evaluations append-only. An evaluation that cannot say which rules produced it
cannot be audited after the rules change — which is exactly when someone will ask.

### G7 — rules never hardcode the third risk-class name

**Decision.** Rules that vary by risk class express themselves as **comparisons on the ordered set**
(`atLeastAsRestrictiveAs`), never as equality against a literal like `'external_reversible'`.

**Why.** **CDR-051 §0.3 remains open and unruled**: canon's third class is plain `external`, this repo split it into
`external_reversible`, and the owner ruled only on the fourth class. Writing comparisons rather than literals means
that if the owner later collapses the split, it is a **rename**, not a change in which actions get gated. This ticket
does not touch that question.

### G8 — no default limit VALUES are invented here

**Decision.** P6-001a ships the rule *representation* and the *evaluator*. It ships **no initial spending, message,
usage or working-hours limits**.

**Why.** ADR-010 §15 records exactly one open question — **AOQ-14, "initial default limits"** — and it is the
owner's. Shipping a plausible-looking default would answer it silently, and a default limit is a statement about
when a founder's money gets spent without asking them. The evaluator is complete without any: a company with no
configured limit rule simply has no limit rule, and G2 governs what an empty rule set means.

---

## §4 What P6-001a explicitly does NOT do

- It does not decide **when** it is called. The three mandatory evaluation points
  (`APPROVAL-AND-POLICY-ARCHITECTURE §5`) are enforced by their call sites; point 3 is P6-002's.
- It does not read or write a database, and defines no table.
- It does not resolve §0. Nothing here widens what may execute.

---

## §5 Consequences

- A new pure module in `@acbp/contracts` (zero-dep, no framework, no provider) plus its unit tests.
- No migration, no core use case, no API surface, no authz action, no audit event — all of those belong to b/c.
- The §0 gate is recorded as binding on **ACBP-P6-002**, which cannot be completed until the owner rules.
