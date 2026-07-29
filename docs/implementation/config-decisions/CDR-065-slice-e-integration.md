# CDR-065 — Slice E integration: safe internal execution

**Ticket:** ACBP-P5-015 · **Requirements:** TASK-004, TASK-005, WORK-002, USAGE-001
**Governing ADRs:** ADR-012 (worker execution), ADR-013 (artifact provenance), ADR-016 (usage metering)
**Status:** Accepted (autonomous, within ticket scope)

---

## §1 What this ticket is

Slice E is the **M5 milestone exit**: the first end-to-end demonstration that a founder can take a task off
the board, see what it will cost before it runs, have a worker actually run it, receive a document, and then
ask for that document to be revised — with the audit trail and the credit ledger both telling the truth
about what happened.

The backlog states the journey exactly:

> pick research task → preflight → run → document → activity/audit/usage → revision

and requires the demo to pass **including the revision and the failure-detail demo**, with a
**no-hollow-success negative demo** in the security column.

Like Slices A–D, the journey is implemented **once** in `@acbp/test-support` and shared by the runnable demo
(`pnpm demo:slice-e`) and the CI integration suite, so the two cannot drift.

---

## §2 The composition question (the central decision)

### G1 — Who composes preflight → reserve → run → settle?

**Question.** P5-014 built `preflightRun`, `reserveCredit`, `settleRun` and `readCreditLedger`. P5-002 built the
run coordinator, P5-005 the worker runtime, P5-006/007/008 the workers, P5-011 artifacts, P5-013 failure
detail. Nothing in the product composes them into "run a task end to end". Should this ticket add that
composition to `@acbp/core`?

**Decision. NO. The journey composes them as the caller, and this CDR records that the composition is
caller responsibility today rather than a product guarantee.**

**Why.** Two pieces of canon say so directly, and neither is ambiguous:

- `WORKFLOW-STATE-MACHINES` §4 places the credit check on the `planned→queued` transition.
- `packages/core/src/tasks/task-management.ts:10` — written by P4-002 and merged — states that the execution
  transitions "are DEFINED-legal in the contract but their EFFECTS belong to later P5/P6 tickets".

P5-015 is a **Testing** ticket whose verification procedure is "run demo script". Adding the missing effect
wiring to `transitionTask` would be a behaviour change to a merged use case, outside this ticket's approved
scope, and it would pre-empt whichever P6 ticket owns it (P6-002 dispatcher enforcement and P6-009 usage
rollups are the candidates). Slices A–D each composed core use cases as the caller; this is the same shape.

**Consequence — and this is the part that must not be glossed.** Because the journey reserves the credit
itself, the demo proves *the pieces reconcile when composed correctly*. It does **not** prove the product
reserves a credit automatically when a task is queued. Any reader tempted to conclude "usage metering is
wired" from a green Slice E is reading more than the demo says. §5-G8 states what the ledger assertion is
actually worth, and the journey step text says so in the output rather than only here.

### G2 — Which connection runs what?

**Decision.** Every product use case runs through the restricted **`acbp_app`** connection under FORCE RLS.
The owner connection is used only to (a) inspect evidence and (b) set up a precondition the product genuinely
cannot yet reach. Inherited unchanged from CDR-044 §2-G3.

**Why.** A journey that ran the product as a superuser would prove nothing about tenant isolation, which is
the guarantee the whole platform rests on.

### G3 — Which edges are seamed?

**Decision.** Exactly three, all of them **outside** the trust boundary: the model **provider**
(`FakeModelProvider`, CDR-026 §3), the research **fetcher**, and **object storage**. Everything between them
is the real code path.

**Why.** A milestone exit is a claim about the platform, so its inputs must be fixed and reproducible. It is
also a claim that must run in CI with no key, no network and no spend. Seaming the provider/fetcher/storage
edges achieves both; seaming anything *inside* the boundary — authorization, RLS, the certification step,
the ledger — would hollow out the very thing being demonstrated.

**Explicitly not seamed:** `certifyResearchDocument` (WORK-002's citation guarantee), the injection screen
(NFR-021), the credit CHECK constraints, and every audit write.

---

## §3 What "safe internal execution" means here

### G4 — the safety claims the journey must actually demonstrate

"Safe **internal** execution" is the slice where the AI does work that touches nothing outside the platform:
it reads sources, thinks, and writes a document. The demo therefore has to show the safety properties that
make that acceptable without an approval gate (approvals are Phase 6):

| # | Claim | Where it comes from |
|---|---|---|
| 1 | The cost and side-effect class are visible **before** the run | TASK-004, preflight |
| 2 | Retrieved content cannot issue instructions | NFR-021, injection screen |
| 3 | Every claim in the document is cited or explicitly labelled unverified | WORK-002, certification |
| 4 | The artifact records which run produced it | TASK-005, ADR-013 provenance |
| 5 | A failure produces **no artifact** and an honest category | TASK-006, no-hollow-success |
| 6 | The trail carries no content, only scalars | ADR-015, NFR-008 |

Claim 5 is the negative demo the backlog's security column asks for, and it is the one most worth having:
the failure mode it guards against is a run that reports success while having produced nothing, or having
produced a document with the failed parts silently dropped.

### G5 — the side-effect class shown by preflight

**Decision.** The journey asserts the class is a member of canon's **closed** `RiskClass` set *and* equals
`informational`, citing CDR-058 §4 — not a literal invented here.

**Why this is safe to pin, when D8 was not.** `preflightRun` itself documents the value and the reason:
a run's tools are not bound until P5-006/007/008 make the class derivable, and `informational` is "the honest
value while nothing external can happen". That is a decision already recorded in CDR-058 §4, so asserting it
is checking the product against its own accepted contract. D8 was the opposite case — a test asserting
`internal_only`, a fifth name that exists nowhere in the closed set.

**Still flagged, not resolved.** The owner's open question on canon's **third risk class (CDR-051 §0.3)**
remains unruled. It does not block this assertion (`informational` is not the disputed class), and this ticket
does not touch it.

### G5b — the reservation must precede the work

**Decision.** The journey reserves the credit **before** invoking the worker, and the negative set proves an
unaffordable account stops the work: with the balance spent down, `reserveCredit` returns
`insufficient_credits` and the journey asserts **no artifact was produced**.

**Why this needs asserting rather than assuming.** `reserveCredit` takes a `taskRunId`, and `startRun` creates
the run row and moves it to `running` inside one transaction — so there is no moment at which a run exists in
`queued` for a separate caller to reserve against. The shipped, tested sequence (P5-014's own suite does
exactly this) is therefore `startRun` → `reserveCredit`, and the run is briefly `running` before it is paid
for. That is bookkeeping, not a spend leak — **provided the caller reserves before doing the expensive
thing**. Nothing in the type system enforces that ordering, which is precisely why it is a journey assertion.

### G5c — the one synthetic step, named plainly

**Decision.** The journey moves the task `planned→queued` on the **owner** connection, and says so in the step
output.

**Why.** `queued` is the only startable state (`LEGAL_TRANSITIONS.queued = ['running','cancelled']`), and
`planned→queued` is legal in the contract but **implemented by no use case** — `@acbp/core/tasks` exports
`createTask` and `planTask` and nothing else. This is the same situation Slice D faced with `failed` and
handled the same way (CDR-044 §2-G3): the owner connection establishes a state the product cannot yet reach,
and every guarantee is then proven through the product.

**What this costs the demo, stated honestly.** The credit check that canon places *on the transition* is not
demonstrated as an automatic consequence of queueing, because no code does that yet. What is demonstrated is
that preflight, reservation, execution, settlement and the ledger compose correctly when a caller drives them
in the right order. See §2-G1.

---

## §4 The negative set

### G6 — no-hollow-success

**Decision.** The negative demo drives a **real failure through the real path** (the seamed provider returns
a failure, or the certification step rejects a fabricated citation) and asserts all four of:

1. the run's result status is **not** `ok`;
2. **no artifact row exists** for that run;
3. the run row carries a **failure category** (never blank — TASK-006);
4. the failure carries a **retry state** derived from `describeRunFailure`, so the trail and the read agree
   (TASK-010, ACT-005).

**Why assertion 2 specifically.** A run can fail *after* the worker has produced partial output. `runResearch`
documents "a failure anywhere persists nothing", and that is precisely the kind of claim that rots untested:
it holds today because of how the chain is ordered, and nothing but a test stops a later refactor from
persisting first and certifying second. This is the guard-test rule from `AUTONOMOUS-RUN-LOG.md` — the demo
must fail if the guarantee is removed.

### G7 — the certification negative

**Decision.** The negative set includes a model output that cites a URL the fetcher never returned, and
asserts the run is refused as `uncertified` with nothing persisted.

**Why.** This is WORK-002's actual promise. A research document whose citations were never checked is worse
than no document, because a founder will act on it.

---

## §5 Reconciliation and scope honesty

### G8 — what "ledger reconciles" is worth

**Decision.** The journey asserts the ledger's entries for the company **sum to the balance the product
reports**, and that a settled run leaves the reservation and its settlement consistent — reading both through
`readCreditLedger` rather than by hand-summing rows on the owner connection.

**Why hand-summing would be wrong.** The reconciliation claim is about *the product's own arithmetic*. If the
journey computed the expected total itself and compared it to its own computation, it would agree with itself
by construction. D9 in the defect ledger was a *passing* test that asserted a double charge, because the test
was written to agree with the code.

### G9 — activity/audit/usage scope

**Decision.** Slice E reconciles the **audit trail** (P1-008, ACT-002) and the **credit ledger** (P5-014). It
does **not** demonstrate the ACT-004 activity *views* or the USAGE-001 *rollups* — and, corrected after the
first real run, it does not demonstrate execution in the **activity feed** either, because nothing projects
there.

**The finding, recorded rather than papered over.** `ACTIVITY_TYPES` is exactly
`['company.created', 'company.updated', 'company.paused', 'company.resumed']`. **No task, run, artifact or
credit event projects into the founder-facing activity feed.** The first draft of journey step 10 asserted the
feed was non-empty and reported that "activity and audit both record the run"; it passed — on the
`company.created` event left behind by SEEDING. The claim was false and the assertion was too weak to notice.

The step now asserts the truth in both directions: the run is fully audited, and the feed contains **no**
execution event. Asserting the absence is deliberate — if the taxonomy is later widened, the step goes red and
forces this claim to be re-examined instead of quietly becoming an overstatement again. (P5-013 already
widened `ACTIVITY_TYPES` once without a matching migration; the contract carries its own note about the
revert, and `activityTypesMatchDatabase` is the guard.)

**Consequence for the product, not just the demo:** a founder today cannot see an execution run in their
activity feed at all. That is `ACBP-P6-008`'s scope (Decision Room and activity completion, ACT-001/003/004
views), with `ACBP-P6-009` owning the usage rollups. Both are still `Planned`. The backlog row's own wording
is "Ledger reconciles in demo" — the ledger, which exists, not the rollup, which does not.

### G10 — revision closes the journey

**Decision.** The journey ends by requesting a revision of the produced document (P5-012) and reading the
lineage back, asserting **both versions are retained** and the new task is linked to the original artifact.

**Why.** J-13's own words are "new linked task created (lineage to original) → re-execution → both versions
retained". The retention half is the part a demo can lose silently, so it is asserted rather than assumed.
Per CDR-064 G4 the revision request charges **no** credit — the new task meters when it is queued — and the
journey's ledger assertion must therefore *not* expect a second charge at request time.

---

## §6 Consequences

- A new shared journey `runSliceEJourney` in `@acbp/test-support`, a demo script `pnpm demo:slice-e`, and a
  real-PostgreSQL CI integration suite, all driving the same journey.
- No production code changes. No migration. No new contract.
- The gap named in §2-G1 is now written down where the next reader will find it instead of re-deriving it.
