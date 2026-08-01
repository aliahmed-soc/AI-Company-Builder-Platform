# CDR-067 — Dispatcher enforcement integration (ACBP-P6-002)

**Requirements:** TOOL-003, APPR-009 · **ADRs:** ADR-009, ADR-010 · **Architecture:**
`APPROVAL-AND-POLICY-ARCHITECTURE.md §5` · **Security:** invariant 6, trust-critical #8
**Depends on:** ACBP-P6-001 (a/b/c)

> **Branch note, corrected.** An earlier revision of this line said P6-001a/b/c were "all merged on local
> verification". They are not: `main` is at Phase 5 completion, and P6-001a/b/c sit on this same branch ahead of it.
> One branch therefore carries two tickets, which is a deviation from one-ticket-one-PR. Recorded rather than
> repaired, because splitting it now means rewriting pushed history.

---

## §1 What this ticket is

P6-001 built an engine nothing calls. This wires it to the chokepoint, so a tool call is actually gated by policy.

The backlog's acceptance criterion is *"pre-execution re-check catches revocation/expiry/stop/limit changes"*, and
its required tests are *"gate-timing race tests (trust-critical)"*.

### The scope boundary, stated up front

That criterion names four things that change between evaluation points. **Only one of them has an engine today:**

| Change | Engine | Status |
|---|---|---|
| **policy**, `risk_class` dimension only | P6-001 | **wired here** — see the correction below |
| stop-state | P6-007 emergency stop | not built — port stays seamed |
| revocation | P6-004 payload binding/revocation | not built — port stays seamed |
| expiry | P6-004 | not built — port stays seamed |

**CORRECTED AFTER REVIEW PASS 2 — the earlier wording said "limit (policy) … wired here", and that was wrong in a
way worth spelling out.** The dispatcher supplies the engine exactly ONE observation: `risk_class`, from
`tool_definitions`. A rule on any other dimension — `spending_limit`, `usage_limit`, `working_hours`,
`emergency_stop`, `allowed_tools` — has no observation to read, is therefore **unevaluable**, and by CDR-066 §3-G9
contributes `deny`. So a company whose policy carried a spend cap would have **every tool call refused**, not
approval-gated. Fail-closed and therefore not a hole, and latent today because no product path writes rules until
P6-010 — but the previous sentence claimed a capability that does not exist, and §2-G7's motivating example ("a spend
cap requires approval for an ordinary research run") is **unreachable on the wired path** for the same reason. That
example is kept there because it is the correct motivation for the RULING; it is not a description of today's
behaviour. `policy-enforcement.integration.test.ts` now pins the real behaviour with a `spending_limit` rule.

So P6-002 wires the **policy** gate for the risk-class dimension and proves the **re-check timing mechanism** end to
end. The mechanism is what
later catches revocation, expiry and stop; it is the same code path, fed by different ports. Recorded as sequencing
rather than omission — the same reading CDR-051 §1 took of P5-003's declared dependency.

**This does not weaken the chokepoint meanwhile.** `stop` and `approval` keep their fail-closed defaults, and after
CDR-066 §0's fix the waiver requires `policy === 'unavailable'` — so a call whose policy demanded an approval is
refused when none can be produced, for every risk class including the waivable one (§2-G7 for what changed here, and
CDR-066 §0.3 for the assertions that carry the owner's ruling under the new semantics).

### The OTHER acceptance clause: "three evaluation points wired" — ONE of three is wired here

`APPROVAL-AND-POLICY-ARCHITECTURE §5` names three points. Stating plainly which are done:

| # | When | Status after P6-002 |
|---|---|---|
| 1 | Action proposed (task queue / plan accept) | **not wired** — needs a decision this ticket may not make (below) |
| 2 | Approval requested | **not wireable** — there is no approval request until P6-003/P6-004 |
| 3 | Immediately before execution (dispatcher) | **WIRED** — and it is the one canon marks *"Never — mandatory (invariant 6)"* |

**PM RULING, 2026-07-30 — not the owner's.** Do not wire point 1 in P6-002, on the two grounds below, and record the
safety argument **explicitly** rather than leaving it implied in the fact that nothing broke.

**THE SAFETY ARGUMENT, stated plainly because it is the whole licence for shipping one point of three.** Points 1 and
2 sit strictly *earlier* than point 3 on every path. Their absence cannot let an action through, because nothing executes without
passing point 3 — which is unconditional, internal, and now proven against a real supersession. Canon's own column
agrees: point 1's purpose is *"early honest feedback; avoids wasted work"* and point 2's is *"decision context
correctness"*; only point 3 is the enforcement point. A missing advisory check costs a user wasted effort. A missing
enforcement check lets the AI act unapproved. Only the second is a safety failure, and it is the one that is closed.

**Why point 1 is not wired here.** Two things are undecided, and both change behaviour outside this ticket:
1. **What is observable at plan-accept.** The observations the engine consumes are tool-shaped (`risk_class` comes
   from `tool_definitions`). A task being planned has no tool identity yet, so a point-1 evaluation today would see
   the baseline and almost nothing else — it would answer, but about nothing.
2. **What a point-1 refusal DOES.** Refusing to *plan* a task is a change to P4-002's state machine and to what
   `planTask` is allowed to reject. Under the owner-ruled baseline (CDR-066 §3-G10) planning is internal work that
   is allowed by default, so a point-1 gate that refused planning would deny work the company's own policy permits.

That is a new decision about authorization semantics, which the operating charter makes an **owner gate**. It is
recorded here rather than guessed at, and **ACBP-P6-002 is therefore not complete against its acceptance row** — the
remaining clause is points 1 and 2. Point 2 additionally cannot be attempted before P6-003/P6-004 exist.

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

### G5 — the timing property is proven with a real supersession, and the property asserted is CONSISTENCY

**Decision.** `policy-enforcement.integration.test.ts` supersedes the active policy with a new version that denies —
a real `UPDATE … status='superseded'` plus a real new active row — while a dispatch is in flight, and asserts that
the call authorized under version 1 cites an evaluation **pinned to version 1**, while the next call sees version 2
and is refused by it.

**Determinism without timing.** The supersession is issued inside an owner transaction that is left **uncommitted**;
the dispatch runs to completion against the snapshot it can see; only then does the supersession commit. No sleeps, no
racing threads, and the interleaving is the same on every run.

**The property is not "the new version wins".** Under snapshot semantics a dispatch that began before the
supersession committed *correctly* uses version 1, and asserting otherwise would be asserting a bug. The property
that matters is that **the record and the decision can never disagree**: a call authorized under one version must not
cite an evaluation from another, because then no reader could ever establish what actually permitted it. The test
asserts both calls' `policy_eval_id` values and both evaluations' versions, so cross-wiring fails it.

**Why a real supersession rather than a stubbed second answer.** A stub would prove the dispatcher calls the engine.
What the criterion claims is that a change made *between* points is caught, which requires the change to be real: a
new version, a superseded old one, and a decision that differs.

**What this does NOT prove.** It does not prove a re-check at two *different* evaluation points catches a change
between them — that needs point 1 wired, which §1 records as owner-gated. It proves the mechanism: the pre-execution
evaluation reads the policy in force at the moment it runs, and records which one that was.

### G7 — POLICY is the authority on whether an approval is needed (**PM RULING**, not the owner's)

**Attribution, stated as plainly as CDR-066 §0's.** The options and the recommendation came from the PM, and **the
choice is the PM's own** — this was decided by me, the acting engineer/PM on this ticket, and NOT ruled by the owner.
Dated 2026-07-29. It is recorded as a PM ruling so a future reader does not mistake it for owner authority; if the
owner disagrees, this is the paragraph to overturn, and G9's closure must be preserved when doing so.

**Decision.** Demand an approval answer **only** when the policy engine returned `require_approval`. Previously the
dispatcher demanded one for every non-waived call regardless of what policy said.

**Rationale recorded, because this is a LOOSENING of a security check:**
- ADR-010's `allow` output is meaningless if the dispatcher ignores it. So is `require_approval`: if every call needs
  an approval anyway, the middle output carries no information.
- This never skips an approval that policy demanded — that is the whole condition, and it is mutation-proven three
  ways (§2-G8, and the table in CDR-066 §0.3).
- The rejected alternative — demand an approval for every call regardless — would leave the allow-and-proceed path
  unexecuted by any test for two more tickets, which is the same unreachable-path shape as the D1 defect.

### G8 — the requirement is DERIVED, and neither the answer nor the requirement is forgeable

**Decision.** `require_approval` is a fourth `kind` on the policy answer (`PolicyGateAnswer`), not a separate
`approvalRequired` boolean on the facts, and `ToolGates` has **no `policy` port**.

**Why the shape carries the guarantee.** A gate a caller may omit will eventually be omitted, and the omission would
be invisible because the old default (`unavailable`) *looks* like a deliberate fail-closed answer. A fact a caller may
supply will eventually be forged. Neither is expressible: the dispatcher builds the answer from the engine inside its
own scope, and the requirement is inseparable from the answer that produced it.

**Proven three ways**, as required before this loosening could land:
1. **Mutation** — drop the policy clause from the requirement: 6 tests red, including *"policy REQUIRE_APPROVAL with
   no approval answer refuses"* and *"never waived, not even for the least restrictive class"*.
2. **Mutation** — force the requirement always-true: 6 red, proving `allow` does not spuriously demand.
3. **Forgery, at COMPILE TIME** — **four** `@ts-expect-error` assertions, covering `approvalRequired`,
   `approval_required`, `waived`, and an invented `kind` on the policy answer. If any of those ever becomes
   expressible, the expected error disappears and **the typecheck fails** — stronger than a runtime test, and it needs
   no tooling. Two companion runtime tests confirm an extra property is ignored rather than honoured.

   **Corrected after review pass 2**, which caught this paragraph claiming *three* assertions including one against a
   `policy` gate. There is no such assertion and there cannot be: §2-G10's own residual table records why — excess
   property checking does not fire through a variable, so `gates: { policy: … }` typechecks and is simply ignored. The
   protection against an injected policy answer is structural (there is no port to read), not a compile-time
   assertion, and saying otherwise overstated it in exactly the direction that matters.

### G9 — THE HOLE THE LOOSENING OPENED, AND ITS CLOSURE

**This is the finding the loosening's review was commissioned to hunt, and it was found by a test, not by review.**

Making the approval demand conditional on policy meant that when policy answered `allow`, `facts.untrustedContext`
had **no effect whatsoever**. The NFR-021 injection boundary went dead: content laundered through a tool would have
reached further tools on a plain `allow`. Before the loosening, untrusted provenance refused a call by *withdrawing
the waiver*, which only worked because an approval was demanded of every non-waived call — so the boundary was
resting on the very behaviour the loosening removed.

Caught by `injection-corpus.integration.test.ts` (7 failures) during the full sweep. Review had not caught it.

**The closure.** `AI-AND-WORKER-ARCHITECTURE §4` requires *heightened policy scrutiny* on a call proposed while
processing untrusted content, and heightened can only mean MORE refusal — so untrusted provenance now **requires an
approval in its own right**. It cannot grant one: an explicit `deny` from either gate still refuses.

**Consequences worth recording:**
- `approvalRequired` is a **disjunction**, so the two clauses must be mutated separately. Dropping the untrusted
  clause turns 2 contracts tests red and 7 real-PG corpus tests red; dropping the policy clause turns 6 red. Neither
  clause can stand in for the other.
- The proof that `!waived` is redundant on the approval line had to be redone for the union: `require_approval` fails
  INV-3's `policy === 'unavailable'` conjunct, and `untrusted` is itself one of `waived`'s conjuncts negated. A proof
  that held for one disjunct would not have held for both.
- Adding the clause introduced a **second read** of `facts.untrustedContext`, and the INV-2 read-counting test failed
  on it with `expected 2 to be 1`. The fact is now a single const beside `policy`. INV-2 earned its keep on a change
  it was not written for.

**The general lesson, recorded because it recurs:** a security property can rest on a mechanism that is not its own.
Removing the mechanism removed the property silently, and nothing in the loosening's own tests mentioned untrusted
content. The corpus suite existed because a previous ticket built it; without it this ships.

### G6 — INV-2 is now directly tested (correcting CDR-066 §0.2)

CDR-066 recorded INV-2, the single-read property, as untestable. It is not: read count is observable through a
getter. Both INV-2 and INV-4 now have explicit tests, and the first INV-2 test was **vacuous** until a mutation
exposed it — see CDR-066 §0.2's correction block for the detail. The inline note at the code site was updated to
match, so it no longer tells a future reader the property is unprotected.

### G10 — the loosening's independent adversarial review, and what it changed

**Commissioned before merge, with exactly one question:** *find any path where a call proceeds without an approval
that policy demanded.* Not a general review — the reviewer was briefed to attack that one claim, given ten specific
attack lines, told not to trust the comments (which are extensive and confident), and told to say plainly if it found
nothing rather than invent a finding.

**On the question asked: `decideDispatch` held.** Every attack line came back clean — all ten returns classified (the
only `authorized` return is textually and logically last), `policyGate()` total against thirteen hostile shapes
including a Proxy and a flip-flopping getter, the waiver provably unable to apply to `require_approval` for any risk
class, and no runtime forgery of the requirement.

**Fixed here, both raised by the review:**

| Finding | Why it mattered | Fix |
|---|---|---|
| `toPolicyGateAnswer` forwarded `result.decision` **unvalidated** — the one link from stored policy to gate not total over `unknown` | The landing value for an unreadable decision was `unavailable`, and `unavailable` is the ONE gate value the waiver spares. So the failure mode was not a wrong denial: it was *an informational call proceeding on a decision nobody could read* | one call to `resolvePolicyDecision`; 4 unit tests incl. a decision the vocabulary might gain later; mutation-proven |
| the **idempotency short circuit** returns before the policy evaluation — "the one place the chokepoint is genuinely not a chokepoint" | (a) a prior **denied** call was reported as `duplicate`, and a caller written `if (denied) abort; else proceed;` reads a laundered refusal as permission; (b) the key was **not bound to the arguments**, so the same key with different args returned the prior call's record and digest for arguments never gated or recorded | denied prior → return the denial from the existing record; digest mismatch → new `idempotency_conflict` status carrying **no** call; 3 tests, all three guards mutation-proven |

`run_id` is deliberately still not compared: reusing a key on a later attempt of the same work is what a retry after
a resume looks like, and refusing that would break the feature.

**NOT fixed, and why — the reviewer's headline finding.** It reported *"BYPASS FOUND"* on `gates.approval`: a caller
can pass `{ gates: { approval: () => ({ kind: 'allow' }) } }` and satisfy an approval that policy demanded, with no
approval record existing anywhere. Assessing it honestly:

- **It is real as stated**, and after this ticket's loosening the approval gate is the *sole* enforcement of
  `require_approval` — so the module's own argument for deleting the `policy` port ("a gate a caller may omit will
  eventually be omitted") now applies verbatim to `approval`.
- **It is not introduced by the loosening.** Before it, the same lambda satisfied the universal demand. Not a
  regression; a pre-existing property of a port the code documents as a port.
- **It is not reachable today.** The reviewer searched for a second door and found none: `tool_calls` is written in
  exactly one non-test place, `dispatchToolCall`/`decideDispatch` have zero non-test callers repo-wide, and no tool
  implementation exists to execute.
- **Closing it now is worse than leaving it.** There is no approval store to consult — `approvals/` is an empty
  scaffold. Deleting the port would make every `require_approval` an unconditional deny, which is fail-closed but
  leaves the approve-and-proceed path unexecuted by any test until P6-003/P6-004 — the same unreachable-path shape as
  the D1 defect, and the exact failure the PM ruling in §2-G7 was chosen to avoid.

**PM RULING, 2026-07-30 — not the owner's.** Leave the port open, *and make the record load-bearing rather than
written down.* The reasoning above stands on its own, but the ruling adds a condition: a note in a CDR is what gets
forgotten, and something that shows up in a run does not.

**The teeth: `tools/check-approval-port.mjs`, in `check:static` and therefore in every `pnpm run check`.** It fails
the build the moment an approval store exists while `ToolGates` still declares `approval?:`. "A store exists" means
either `packages/core/src/approvals/index.ts` stops being a scaffold, or any migration creates an `approvals` /
`approval_*` table (Kysely builder or raw SQL). The failure message names the fix — delete the port, do not delete
the check.

Three properties make it more than a comment:
- **It cannot rot into a permanent pass.** It carries a negative self-test on every detector, and if `ToolGates` is
  renamed or removed it exits **2** — distinctly from both "clean" and "violation" — saying it can no longer see what
  it guards.
- **It is itself tested.** `tools/tests/check-approval-port.test.mjs` runs the real checker as a subprocess against
  six fixture trees, asserting the allowed state, all three store-detection forms, the closed state, and the
  can't-see-target exit.
- **It was proven against the real tree**, not just fixtures: making the actual approvals module non-scaffold turns
  the gate red with the message above; restored byte-identical, gate green again.

**So this is a required closure, not a resolved one:** P6-003/P6-004 must consult the approval store internally and
**delete the `approval` port**, the way `policy` was deleted here. **Closing it is an ACCEPTANCE CONDITION of
ACBP-P6-003, not an optional extra.** The same argument applies to `gates.stop` and P6-007 — that port has no marker
yet, because no stop store exists to detect; P6-007 should add the equivalent detector when it lands.

**BOTH CLOSURES ARE NOW DONE.** `gates.approval` was deleted by ACBP-P6-003c, and `gates.stop` by ACBP-P6-007 —
`ToolGates` has no members left and is kept only as the host both checkers inspect, carrying a DO-NOT-ADD-A-GATE
note. `tools/check-stop-port.mjs` is the equivalent detector this paragraph asked for, mirroring
`check-approval-port.mjs` including its four measured evasions, and both run in `check:static`.

**Other residual risks the reviewer logged, with disposition:**

| Risk | Disposition |
|---|---|
| a throwing gate or engine produces no denial row and no audit event — fail-closed but invisible | real gap against TOOL-002's 100%-recorded and TOOL-003's owner notification; needs a decision about recording outside the rolled-back transaction, which is a new design question → **not this ticket** |
| stale authorization on replay: a still-`requested` prior call replayed after policy tightened returns `duplicate` without re-gating | genuine tension — re-gating protects against stale policy, short-circuiting protects against double execution. Resolving it needs the execution-report design → **flagged, not guessed** |
| `findActive` takes no row lock, so a policy committed after the read decides nothing but the record stays honest | benign TOCTOU bounded by one transaction; the recorded evaluation names the version that actually decided, which is the property §2-G5 asserts |
| `workers/runtime.ts` executes a caller-supplied closure | forward obligation for P5-006/007/008, not a live door — no tool implementation exists |
| a stale `gates: { policy: … }` still typechecks at call sites (excess-property checking does not fire through a variable) and is silently ignored | fail-closed direction — the engine is consulted regardless — but the silence is the shape the design warns about; the three stale test call sites should be cleaned up |

**Method note worth keeping.** The reviewer found the two fixed items by reading code against comments and by probing
`toPolicyGateAnswer` with values the type system says cannot occur. Neither was findable by reading the diff. Both
were in code this ticket touched but did not change.

---

## §3 Consequences

- `ToolGates.policy` is gone; `stop` and `approval` remain (their engines are later tickets).
- Migration 0046: one nullable, tenant-pinned column on `tool_calls`.
- `evaluateCompanyPolicy` keeps its signature; its body moves to `evaluatePolicyInScope`.
- No new authz action and no new audit event — P6-001c registered what this needs.
