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

### §0.3 — THE OWNER'S OPTION A RULING IS STILL HONOURED (traceability, added ACBP-P6-002)

**The test that used to carry this ruling was superseded. Here is exactly what carries it now.**

The original proof was a test asserting: policy `allow` + approval `unavailable` + `informational` + trusted must
**DENY**. Under P6-002 that case now **authorizes**, which looks like the ruling being undone. It is not — the
ruling is enforced somewhere stronger, and this section exists so a future reader can trace it without re-deriving
the history.

**What the ruling actually protects.** Option A was chosen to stop the Phase 5 waiver from swallowing an approval
that policy had demanded. The *root cause* was that `GateAnswer` could not express `require_approval`, so an engine
demanding approval had to answer `allow`, and the waiver then treated that call as needing no approval.

**Why the old test had to change.** With `PolicyGateAnswer` (CDR-067 §2-G7) the engine's demand travels intact, so
policy `allow` now genuinely means *"no approval needed"* — and denying it would refuse actions the company's own
policy permits. The old assertion was pinning the *workaround*, not the guarantee.

**The live assertions that carry the ruling now**, all in `packages/contracts/src/tools/dispatch.test.ts`:

| Guarantee | Test |
|---|---|
| A demanded approval is never skipped — **for the waivable class too** | *"policy REQUIRE_APPROVAL is never waived, not even for the least restrictive class"* |
| A demanded approval is never skipped, general case | *"policy REQUIRE_APPROVAL with no approval answer refuses — the demand is never skipped"* |
| The waiver still requires `policy === 'unavailable'` (INV-3) | *"the waiver survives exactly where it was meant to: policy unavailable AND approval unavailable"* |
| An explicit refusal wins even when no approval was required | *"an EXPLICIT approval deny still refuses even when policy did not require one"* |

**The replacement is strictly broader.** The old test covered one class (`informational`) in one configuration. The
first row above covers the *waivable* class — the only one the waiver could ever have spared — and the
`require_approval` case is additionally asserted across **every** risk class. The conjunct the owner ruled on
(`policy === 'unavailable'` inside `waived`) is untouched and still tested; it is simply no longer the *only* thing
standing between a demanded approval and an unapproved action.

**Mutation-proven, not assumed.** `approvalRequired` is now a disjunction — `policy === 'require_approval' ||
untrusted` — and the ruling is carried by the FIRST disjunct, so that is the one whose removal must be fatal:

| Mutation of `approvalRequired` | Result |
|---|---|
| drop the policy disjunct (`= untrusted`) | **6 red**, including both never-skipped rows above and all three forgery assertions |
| `= false` | **10 red** |
| `= true` | 6 red (the other direction: `allow` must not spuriously demand) |

Measured on ACBP-P6-002, each mutation restored byte-identical (`sha256:71d682f50ecdd055`). The ruling's guarantee
fails loudly if removed, and it fails on the *policy* clause specifically — the untrusted clause cannot stand in for
it, which is why both disjuncts are mutated separately rather than the line as a whole.

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

**Test coverage of these invariants.** INV-3 is pinned by *"an ENGINE-ALLOWED informational call still needs an
approval answer"* — it fails the moment the conjunct is removed. INV-1 is exercised by the ordering tests.

> **CORRECTION (ACBP-P6-002).** This section previously said *"INV-2 is not covered by any test, because it is a
> property of the code's shape rather than its behaviour."* **That was wrong.** Read COUNT is observable from
> outside: a getter that counts reads asserts the single-read property directly. INV-2 and INV-4 now have explicit
> tests in `dispatch.test.ts`.
>
> **And the first version of the INV-2 test was vacuous** — found by mutation, not by review. It used an
> `informational` class with no engine, where `waived` is true, so `!waived` short-circuits *before* any second read
> can happen; a deliberately re-reading implementation passed it. The fixture now uses a **non-waivable** class with
> policy allowing and approval absent, which is the state that actually reaches the approval line. The mutation that
> proves it: adding a second `gate(facts.policy)` that changes **no** decision fails the test with
> `expected 2 to be 1`. A behaviour-preserving mutation being caught is the whole point — that is precisely the drift
> INV-2 exists to prevent, and nothing about the decisions would have revealed it.

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

### G9 — the rule set carries an explicit, required BASELINE

**Decision.** `PolicyRuleSet` has a required `baseline: PolicyDecision`. The evaluator seeds the combination with it,
so rules can only push the result *more* restrictive. An absent or unreadable baseline makes the whole rule set
unreadable, which denies. **No default baseline value is shipped.**

**Why this was needed — found by mutation testing, not by design.** G2 says an empty set of outcomes denies, and I
took that to mean an all-quiet rule set denies. But rules only ever *restrict*: a rule that does not fire contributes
nothing. With no baseline, the engine could therefore **never return `allow`** — which contradicts ADR-010, where
`allow` is one of three outputs, and would make a company with no restrictions unable to do anything at all.

The baseline resolves it without inventing permission: what a company may do unsupervised is a **configured**
statement belonging to whoever sets the policy, exactly like the limit values in G8. Making it required rather than
defaulted means the question cannot be answered by omission.

**A second thing mutation testing caught, worth recording.** Before the baseline existed, "an unevaluable rule
contributes `deny`" and "an unevaluable rule is silently skipped" were **indistinguishable** in every test — both
ended at `deny`, one because the guard worked and one because the empty-set rule caught it. A mutation that deleted
the guard passed the whole suite. Only a *permissive* baseline separates them, because only then does skipping a
rule actually let the action through.

There are **three** distinct ways a rule becomes unevaluable — malformed rule, missing/unwrapped observation, and an
undecidable condition — and each needed its own permissive-baseline test. Covering two of the three was not enough:
a mutation targeting the third still passed. All three are now individually proven by mutation.

### G10 — the newly-provisioned company baseline (OWNER-RULED)

> **OWNER RULING — DIRECT, 2026-07-29.**
>
> **Provenance, on the same discipline as §0.** The question was raised by the PM (me) as an open flag; the options
> and the recommendation to keep it configured rather than defaulted were mine. **The choice of value is the
> owner's**, ruled directly in session. Their words:
>
> > "informational and internal-reversible actions are allowed by default; anything at a higher risk class requires
> > approval; nothing is denied outright by the baseline alone (specific deny rules can still be added on top)."
>
> **Owner's recorded reasoning, verbatim:** *"a new company should be able to do useful internal work — research,
> drafting, planning — on day one without configuration, but nothing that reaches outside the platform or spends
> money should happen without a human saying yes. This matches the risk-class ordering already in the system and the
> approve-before-external-write posture in canon."*

**How it is expressed — and note that it needed no contract change.** The ruling is a `baseline` of `allow` plus
exactly one rule:

```ts
{ dimension: 'risk_class', condition: 'risk_at_least', operand: 'external_reversible', decision: 'require_approval' }
```

`risk_at_least` compares on the ordered set, so it fires for `external_reversible` and `sensitive_irreversible` and
not below — which is precisely "anything at a higher risk class". No rule yields `deny`, so nothing is refused
outright by the baseline alone, exactly as ruled; a company may add deny rules on top and they win under POL-005.

**An unclassified action requires approval, and that falls out rather than being special-cased.** `resolveRiskClass`
maps anything unclassified to the most restrictive class (TOOL-001), which is above the threshold, so the rule fires.

**Shipped as executable data, not prose.** `DEFAULT_NEW_COMPANY_POLICY` is a tested constant. A ruling that lived
only in this document would be re-implemented by P6-001b/c from a paragraph, and a paragraph is exactly the kind of
thing that gets implemented *slightly* wrong — the wrong threshold class here would silently let external writes
through unapproved.

**The one place CDR-051 §0.3's unruled name appears.** The threshold operand must name a class, so it names
`external_reversible`. Because the comparison is ordinal (G7), collapsing that split back to canon's plain
`external` would be a **rename of this operand only** — it would not change which actions are gated. Recorded so the
dependency is visible rather than discovered later.

**AOQ-14 is untouched.** This rules the *baseline posture*. The **specific limit values** — spending, message,
usage, working-hours — remain unruled and unshipped. `DEFAULT_NEW_COMPANY_POLICY` contains no numeric threshold on
any limit dimension, and a test asserts that it does not.

---

## §4 What P6-001a explicitly does NOT do

- It does not decide **when** it is called. The three mandatory evaluation points
  (`APPROVAL-AND-POLICY-ARCHITECTURE §5`) are enforced by their call sites; point 3 is P6-002's.
- It does not read or write a database, and defines no table.
- It does not resolve §0. Nothing here widens what may execute.

---

## §5 P6-001b — policy storage and append-only evaluation records

Amends §2's scope boundary as promised in §1. Acceptance clause: ***"forbidden beats approval"*** (POL-005).

Canon fixes both shapes in `DATA-ARCHITECTURE`'s entity table:

> | Policy | **C (+G defaults)** | policy_id, version | evaluated per action | **active→superseded** | V | limits config | **Permanent versions** | policy changes audited |
> | Policy evaluation | C | evaluation_id | links tool call/approval; policy version | recorded (terminal) | **A/I** | — | ≥ audit retention | POL-006 |

### G11 — `policies` is versioned and permanent, and exactly one version is active

**Decision.** `policies` carries `version`, `baseline`, `rules` (jsonb) and a `status` of `active | superseded`.
`UNIQUE (company_id, version)`; a **partial unique index on `(company_id) WHERE status = 'active'`** allows at most
one active version per company. Grants are SELECT + INSERT + a **column-scoped `UPDATE (status, superseded_at)`**.
**No DELETE.**

**Why an explicit status rather than "highest version wins".** Deriving the active version from `max(version)` would
be strictly append-only and tempting, but canon names the lifecycle `active→superseded`, and a derived answer cannot
express "this company currently has no active policy" — which is a state P6-001c must be able to see and refuse on.
The column-scoped UPDATE is the P5-001a precedent: the narrowest grant that permits the one legal transition.

**Why no DELETE.** *"Permanent versions."* An evaluation record cites the version that decided it; deleting that
version would leave the audit trail pointing at nothing, which is the one thing POL-006 exists to prevent.

**The `(+G defaults)` half.** The global default is `DEFAULT_NEW_COMPANY_POLICY` (G10) — code, not a table. A
company gets a row seeded from it at provisioning. No global policy table is created: one row per company is simpler
than a global table plus per-company overrides, and the override-resolution logic is precisely where a policy engine
can quietly become permissive.

### G12 — `policy_evaluations` is append-only, and its version link cannot drift

**Decision.** SELECT + INSERT only — **no UPDATE, no DELETE at all**, not even column-scoped. The row stores the
decision, the escalate flag, the three rule-id lists, the evaluating instant, and **both** `policy_id` and
`policy_version`.

**Why store the version when there is already an FK.** POL-006 wants a record that stands on its own. But a
denormalized copy that can disagree with its source is worse than no copy, so the FK is **composite over
`(policy_id, policy_version, company_id)`** against a matching unique on `policies`. The database then refuses a row
whose stated version is not the version of the policy it names — the copy cannot drift, by construction.

**Why the evaluating instant is stored.** G3 made the clock an input so the evaluator is a function. The record must
therefore say *which* instant was passed, or a working-hours decision cannot be re-derived from its own record.

### G13 — the evaluation point is recorded, from canon's closed set

**Decision.** `evaluation_point` is one of `proposed | approval_requested | pre_execution`, taken from
`APPROVAL-AND-POLICY-ARCHITECTURE §5`'s three mandatory points. `tool_call_id` is nullable and tenant-pinned.

**Why nullable.** Only point 3 has a tool call; points 1 and 2 evaluate an action that has not been dispatched. A
non-null constraint would make the two earlier points unrecordable, and §5 marks point 1 as *not skippable*.

**The approval link is DEFERRED, as sequencing not omission.** Canon says an evaluation "links tool call/approval",
and approval records are **ACBP-P6-003**. Adding a nullable FK-less `approval_id` now would be the hole CDR-049
refused for `jobs.company_id`. P6-003 adds the column and its tenant-pinned FK together.

### G14 — "forbidden beats approval" is proven end-to-end, not just in the pure layer

**Decision.** The real-PostgreSQL suite stores a policy containing **both** a `deny` rule and a `require_approval`
rule, evaluates through the persisted rule set, and asserts the recorded decision is `deny`.

**Why this is not redundant with P6-001a's unit test.** The pure combination is already proven. What this adds is
that the *stored* representation round-trips faithfully: a rule set that loses its deny rule in serialisation, or an
evaluation row that records the wrong winner, would pass every unit test in the package and still let a forbidden
action through. The acceptance clause is about the system, so the proof runs against the system.

---

## §6 P6-001c — the engine service and fail-closed unavailability

Acceptance clause: ***"unavailability denies"*** (TOOL-003).

### G15 — "no active policy" is an ANSWER (deny), not an unavailability

**This is the load-bearing decision of P6-001c, and it was nearly the wrong way round.**

The obvious shape is: no active policy ⇒ the engine cannot answer ⇒ `unavailable`. That is **unsafe**, and the
reason is the Phase 5 waiver. After the §0 fix, `waived = waivable && !untrustedContext && policy === 'unavailable'`
— so an `unavailable` policy answer on an informational-class tool over a trusted path is **still waived**, and the
call proceeds with no policy and no approval. A company with no policy configured would run AI actions ungoverned.

**Decision.** The two are separated:

| Situation | Result | Why |
|---|---|---|
| The engine ran and the company has **no active policy** | **`deny`** | The engine *answered*: there are no rules. G2 already says an empty rule set denies — a policy that says nothing has permitted nothing. |
| The engine ran and the stored rule set is **unreadable** | **`deny`** | Same reasoning; the evaluator is total and refuses (G4). |
| The engine **could not run at all** (scope failure, database unreachable) | `unavailable` | This is TOOL-003's actual case: *"policy engine unreachable ⇒ deny (fail closed)"*, and the dispatcher denies on it for every non-waived class. |

`unavailable` is now reserved for "no answer was produced", which is what the waiver was ever meant to stand in for.
Anything the engine actually determined comes back as a decision.

**Why this did not need an owner gate.** Both candidate readings were available and one is strictly safer; the
charter's instruction in that situation is to take the safer reversible interpretation and document it. Choosing
`unavailable` would have been the choice that lets the AI act unapproved, so it is the one that would have needed
asking. **Flagged prominently here so the owner can overrule it** — the reversal is a one-line change in
`evaluateCompanyPolicy` plus this table.

### G16 — a no-policy refusal gets its OWN event, and records no evaluation row

**Decision.** When a company has no active policy — or its rule set cannot be read — the refusal emits
**`policy.unavailable`** (subject: the **company**) and writes **no** `policy_evaluations` row. `policy.blocked`
(subject: the evaluation) is reserved for refusals a real evaluation produced.

**Why no row.** `policy_evaluations.policy_id` is NOT NULL behind the version-pinning composite FK (G12). Making it
nullable to accommodate this case would weaken the pin for every *real* evaluation — the guarantee that a recorded
version is the version that decided. And there is nothing honest to record: an evaluation row exists to say *which
rules* produced a decision, and here there were none.

**Why a separate event — corrected during implementation.** The first draft made `policy.blocked`'s evaluation id
optional so it could cover both cases. The audit registry rejected it: `makeEvent` requires a non-empty subject, by
design. That refusal was right, and it exposed a real modelling error rather than an inconvenience — an event whose
subject is sometimes absent is two events wearing one name, and a reader could not tell *"the rules said no"* from
*"there were no rules to ask"*. They are different operational problems: one is the policy working, the other is the
policy missing. TOOL-003 attaches an owner notification specifically to the second
(*"blocks execution (fail closed), with owner notification"*), which is exactly why it needs its own event to hang
off.

### G17 — evaluation rides `run:execute`; initialization is owner-only `policy:manage`

**Decision.** `evaluateCompanyPolicy` checks `run:execute` — the same action `preflightRun` and the dispatcher use,
because evaluation happens on the execution path on behalf of a run. `initializeCompanyPolicy` checks a new
**owner-only** `policy:manage`.

**Why a separate action.** Deciding what a company is allowed to do is not the same authority as doing it. A worker
holds `run:execute`; a worker that could also rewrite the policy it is about to be judged by would make the whole
chain circular — invariant 5's shape, one layer down.

### G18 — three audit events, two of them canon's own

**Decision.** `policy.evaluated` (every evaluation) and `policy.blocked` (every `deny`) are transcribed from
`EVENT-CATALOG` L221–222. `policy.changed` is added for policy creation, from `DATA-ARCHITECTURE`'s *"policy changes
audited"* — canon states the requirement without naming the event, so the name is derived from its own phrase.

**Both the row and the event, deliberately.** The event carries `evaluation_id` plus scalars and *points at* the
row; the row carries the detail. They are written in ONE transaction (audit-or-nothing, ADR-015), so they cannot
disagree through partial failure — this is not the CDR-064 G1 "same fact in two places" problem, because the event
does not restate the detail, it references it.

### G19 — what P6-001c does NOT own

Editing limits — spending, message, usage, working hours — is **ACBP-P6-010** (Limits and alerts). P6-001c seeds
the owner-ruled default (G10) so the engine is reachable at all, and stops there. This keeps AOQ-14's values out of
this ticket exactly as G8 requires.

**An obligation this places on ACBP-P6-002:** when it maps `EvaluateCompanyPolicyResult` onto the dispatcher's
`GateAnswer`, `unavailable` and `forbidden` must both map to `{kind: 'unavailable'}` and never to `{kind: 'allow'}`.
The dispatcher already fails closed on that value, so the safe mapping is also the obvious one — recorded because
the failure mode is silent.

---

## §7 Consequences

- A new pure module in `@acbp/contracts` (zero-dep, no framework, no provider) plus its unit tests.
- No migration, no core use case, no API surface, no authz action, no audit event — all of those belong to b/c.
- The §0 gate is recorded as binding on **ACBP-P6-002**, which cannot be completed until the owner rules.
