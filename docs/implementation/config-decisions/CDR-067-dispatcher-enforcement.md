# CDR-067 — Dispatcher enforcement integration (ACBP-P6-002)

**Requirements:** TOOL-003, APPR-009 · **ADRs:** ADR-009, ADR-010 · **Architecture:**
`APPROVAL-AND-POLICY-ARCHITECTURE.md §5` · **Security:** invariant 6, trust-critical #8
**Depends on:** ACBP-P6-001 (a/b/c, all merged on local verification)

---

## §1 What this ticket is

P6-001 built an engine nothing calls. This wires it to the chokepoint, so a tool call is actually gated by policy.

The backlog's acceptance criterion is *"pre-execution re-check catches revocation/expiry/stop/limit changes"*, and
its required tests are *"gate-timing race tests (trust-critical)"*.

### The scope boundary, stated up front

That criterion names four things that change between evaluation points. **Only one of them has an engine today:**

| Change | Engine | Status |
|---|---|---|
| **limit** (policy) | P6-001 | **wired here** |
| stop-state | P6-007 emergency stop | not built — port stays seamed |
| revocation | P6-004 payload binding/revocation | not built — port stays seamed |
| expiry | P6-004 | not built — port stays seamed |

So P6-002 wires the **policy** gate and proves the **re-check timing mechanism** end to end. The mechanism is what
later catches revocation, expiry and stop; it is the same code path, fed by different ports. Recorded as sequencing
rather than omission — the same reading CDR-051 §1 took of P5-003's declared dependency.

**This does not weaken the chokepoint meanwhile.** `stop` and `approval` keep their fail-closed Phase 5 defaults, and
after CDR-066 §0's fix an answered policy withdraws the waiver, so the approval gate now genuinely refuses whenever
policy has spoken.

---

## §2 Gates

### G1 — the policy gate is built INTERNALLY, not injected

**Decision.** `dispatchToolCall` consults the engine itself. `ToolGates.policy` is removed as an injection point;
callers can no longer supply, override or omit a policy answer.

**Why.** `COMPONENT-CATALOG` calls this component *"Trusted — the enforcement chokepoint"* and §5 marks point 3
**never skippable**. A gate a caller may omit is a gate that will eventually be omitted — and the omission would be
invisible, because the Phase 5 default (`unavailable`) *looks* like a deliberate fail-closed answer. Building it in
means "did anyone wire the policy gate here?" stops being a question.

`stop` and `approval` remain injectable ports because their engines do not exist yet; they become internal in P6-007
and P6-003/004 respectively, by this same argument.

### G2 — the engine is called inside the dispatcher's EXISTING scope

**Decision.** `evaluatePolicyInScope(scope, …)` is extracted from `evaluateCompanyPolicy`, which becomes a thin
wrapper that opens a scope and calls it. The dispatcher — already inside `runInCompanyScope` with the same
`run:execute` authorization — calls the extracted function directly.

**Why.** Calling `evaluateCompanyPolicy` from inside the dispatcher would open a transaction inside a transaction.
Beyond the mechanics, one scope means the evaluation, the call record and every audit event commit or roll back
**together**: a tool call recorded as authorized whose policy evaluation was rolled back would be a record asserting
an authorization that never happened.

### G3 — the TOOL CALL links the evaluation, not the reverse

**Decision.** Migration 0046 adds `tool_calls.policy_eval_id`, nullable, tenant-pinned by a composite FK to
`policy_evaluations (id, company_id)`.

**Why this direction.** `DATA-ARCHITECTURE` L340 says a tool call *"links policy eval + approval"*, and L289 records
`policy_eval_ref` as **deferred, "as sequencing rather than omission — the engines are Phase 6's"**. This is the
ticket those lines were waiting for.

It is also the only direction the ordering permits: the evaluation must complete *before* the decision, and the
decision determines the call row's `outcome`, so the call is inserted after the evaluation exists. The reverse link
(`policy_evaluations.tool_call_id`) stays null on this path and its comment says why — an evaluation at point 3
precedes the call record it authorizes.

**Nullable, deliberately.** When there is no usable policy there is no evaluation row (CDR-066 §6-G16), and the call
is still recorded — as a denial. A NOT NULL column would make the refusal unrecordable, which is the one outcome
TOOL-002 most wants recorded.

### G4 — every dispatch evaluates, including ones refused for other reasons

**Decision.** Policy is evaluated before `decideDispatch`, unconditionally — even for an unregistered or
un-allowlisted tool that will be refused on a different ground.

**Why.** `decideDispatch` takes the policy answer as an *input*, so it cannot be evaluated lazily without inverting
the decision function. And the ticket's audit behaviour is *"all checks audited"*: a record that the policy was
consulted about an action is true and useful, even when something else refused first. The alternative — skip the
evaluation when an earlier condition already fails — optimises away exactly the evidence an auditor asks for.

### G5 — the timing property is the acceptance criterion, and it is proven with a real policy change

**Decision.** The enforcement suite evaluates at point 1 (`proposed`), then supersedes the policy with a new version
that denies, then dispatches — and asserts the **pre-execution** evaluation catches the change and refuses.

**Why a real supersession rather than a stubbed second answer.** A stub would prove the dispatcher calls the engine
twice. What the criterion actually claims is that a change made *between* the points is caught, which requires the
change to be real: a new version, a superseded old one, and a decision that differs. Anything less tests the
plumbing while leaving the property untested.

### G6 — INV-2 is now directly tested (correcting CDR-066 §0.2)

CDR-066 recorded INV-2, the single-read property, as untestable. It is not: read count is observable through a
getter. Both INV-2 and INV-4 now have explicit tests, and the first INV-2 test was **vacuous** until a mutation
exposed it — see CDR-066 §0.2's correction block for the detail. The inline note at the code site was updated to
match, so it no longer tells a future reader the property is unprotected.

---

## §3 Consequences

- `ToolGates.policy` is gone; `stop` and `approval` remain (their engines are later tickets).
- Migration 0046: one nullable, tenant-pinned column on `tool_calls`.
- `evaluateCompanyPolicy` keeps its signature; its body moves to `evaluatePolicyInScope`.
- No new authz action and no new audit event — P6-001c registered what this needs.
