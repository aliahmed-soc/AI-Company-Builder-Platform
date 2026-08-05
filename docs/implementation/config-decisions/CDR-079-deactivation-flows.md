# CDR-079 — Deactivation flows (ACBP-P7-002)

Governing: **ACC-004** (account deactivation stopping all autonomous work), **COMP-006 (final)** (company pause —
stops autonomous work, keeps data); ADR-006; `WORKFLOW-STATE-MACHINES.md §1`; `diagrams/08`;
**SECURITY-VERIFICATION-PLAN Gate 14** (*"Deactivation blocks new autonomous work"*); threat row *"zombie
autonomous work"*. Depends on **ACBP-P6-007** (emergency stop, Done).

---

## §0 The thing this ticket is actually for, and why it is not "add two states"

Gate 14 says **deactivation blocks new autonomous work**. The obvious reading is that `companies.status` gains
`deactivating` and `deactivated`, the CHECK constraint widens, and the gate that already refuses work for a
`paused` company starts refusing it for these too.

**There is no such gate.** Nothing in production reads a company's lifecycle status before doing autonomous work.

> **Pausing a company today is a label, not a control.**

`pauseCompany` writes `companies.status`, writes an audit event, projects an activity row, and returns. It never
touches `jobs`, `tasks`, `task_runs`, `worker_runs`, `tool_calls` or `emergency_stops`. Nothing downstream asks.

So the centre of gravity of this ticket is the **gate**, not the states. Adding `deactivated` to a vocabulary
nothing enforces would satisfy the acceptance criterion's wording and leave Gate 14's actual threat — zombie
autonomous work — exactly where it is.

## §1 The evidence, because a claim this large should not rest on a summary

| Where enforcement was expected | What is actually there |
|---|---|
| `canPickUpAutonomousWork(status)` — `contracts/company/company.ts:70` | Exists, correct, and has **zero production callers**. |
| Job / run pickup — `runs/coordinator.ts` + `task-run-repository.claimAttempt` | Preconditions are authz, attempt validity, task exists, `canStartRunForTask(task.state)`, attempt-not-claimed. **No company status.** |
| Tool dispatcher — `tools/dispatcher.ts` | **21 precondition gates** (membership, authz, run state, idempotency, registry, spend, policy, approval binding/decision, emergency stop, atomic consume, plus the pure `decideDispatch` set). **Company lifecycle is not among them**, and `DispatchRequestFacts` has no field for it. |
| Worker runtime — `workers/runtime.ts` | Checks the **worker's** state (`workerAcceptsTasks`), never the company's. |
| `elevateToCompanyScope` — `database/transaction.ts:128` | `select('id')` — **existence only**. |
| RLS / CHECK / partial indexes | Predicate on account and company **identity**. No policy references `companies.status`. |
| The one real status gate — `discovery/interview-session.ts:79` | `company.status !== 'active'` → refuse. Human-initiated discovery, **not** autonomous work. Nothing downstream repeats it. |

### §1.1 Two artefacts that made the gap look closed

Both are honest-looking, and both are why this survived from ACBP-P1-010 to Phase 7.

- **The predicate's own docstring**: *"this pure predicate is the single truth a scheduler/worker consults before
  opening a run … Pausing is the enforcement point (P1-010); the scheduler is later."* The first clause describes
  a consultation that never happens. The second was a truthful deferral when written, and stopped being true the
  moment schedulers, workers and a dispatcher existed — the same way CDR-072 §1 records the stop port's comment
  outliving its own justification.
- **A green integration test named `'pause blocks new autonomous-work pickup (invariant 16 groundwork)'`**, which
  calls the pure predicate on a value `getCompany` returned. It proves the predicate returns `false` for
  `'paused'`. It exercises **no pickup path**, and would stay green if every scheduler in the codebase ignored
  company status forever — which is precisely what they do.

  This is ACBP-P6-011's HIGH finding in a different costume: *a test aimed one layer below the thing it is named
  after, reading as thorough while proving nothing about the entry point.*

## §2 A canon conflict about WHEN, ruled rather than picked silently

| Source | Says |
|---|---|
| `MASTER-PRD` requirement table — ACC-004 | **Post-MVP** |
| `MASTER-PRD` journey J-20 "Deactivate company" | **Post-MVP** |
| `MASTER-PRD` requirement table — COMP-006 | **MVP** |
| `SECURITY-VERIFICATION-PLAN:23` | Deactivation at **M6–M7**, supporting **Gate 14** |
| Gate list | *"14. Deactivation blocks new autonomous work (COMP-006, ACC-004)"* — a **launch gate** |

**Ruled: build it now**, and the deciding fact is not the phase plan — it is that COMP-006 is **MVP**, is marked
`(final)` on this ticket, and its enforcement half has never existed. A launch gate cannot be satisfied by a
requirement whose control is absent, and the gap is in MVP scope regardless of what ACC-004's row says.

**Not silently reconciled**: the two Post-MVP cells are left untouched and flagged (§7.1). Editing canon to match
an implementation decision is how a conflict becomes invisible.

## §3 Design gates

- **G3.1 — ONE gate, consulted at the canonical points**, not a status check sprinkled through call sites. The
  two points canon names are **job/run pickup** and **the dispatcher** (`SECURITY-VERIFICATION-PLAN:23`:
  *"Lifecycle checks in job pickup + dispatcher"*). A per-call-site check is how the next path added forgets it.
- **G3.2 — FAIL CLOSED.** A status the gate cannot read or does not recognise refuses work. The precedents are
  already here and agree: CDR-066 §3-G9 (an unevaluable dimension contributes `deny`) and CDR-072 §1-G3
  (*"no stop is recorded" is a complete answer; "I could not check" is not*). An unknown lifecycle state is the
  same class of answer.
- **G3.3 — PAUSE AND DEACTIVATION SHARE THE GATE.** They differ in reversibility, not in what they forbid. Two
  mechanisms that both mean "this company may not do autonomous work" would eventually disagree, and the one
  that mattered would be whichever the caller happened to consult — the reasoning CDR-078 §3-G2 used to refuse a
  second secret detector.
- **G3.4 — IN-FLIGHT WORK SAFE-STOPS; IT IS NOT KILLED.** OQ-14's MVP default is *"complete current tool call,
  then halt"*. The machinery for that exists (ACBP-P6-007's emergency stop, with its held-work review). This
  ticket **reuses** it rather than inventing a second halt path.
- **G3.5 — DEACTIVATION IS TWO-PHASE**, per canon's own table: `active/paused → deactivating` (owner, on
  confirmation) blocks work **immediately**, and `deactivating → deactivated ⏹` is a **system** transition after
  teardown checks, **resumable**. Collapsing them would make "work stopped" depend on teardown succeeding.
- **G3.6 — DATA IS RETAINED.** Deactivation is not deletion. COMP-007/ACC-005 own deletion, with two-step
  confirmation and cooling-off, and are **not this ticket** (§4).
- **G3.7 — ACCOUNT DEACTIVATION MUST NOT DEPEND ON A CASCADE COMPLETING.** ACC-004 stops *all* autonomous work
  for an account. If the enforcement were "deactivate the account, then walk its companies", a half-finished walk
  leaves companies running while the account reads deactivated. The gate therefore answers from **both** levels,
  so an account-level state is sufficient on its own.
- **G3.8 — TRANSITIONS ARE AUDITED, and the refusals are observable.** A gate that silently drops work is
  indistinguishable from a quiet week (CDR-074 §5.2's lesson about counting zero).
- **G3.9 — REACTIVATION: `paused → active` EXISTS AND IS THE DOCUMENTED PATH. `deactivated` IS TERMINAL (⏹).**
  J-20 asks for a documented reactivation path; canon marks `deactivated` terminal. Those are reconciled by
  documenting the real answer rather than inventing a transition canon forbids — see §7.2, which is an owner
  decision, not an engineering default.

## §4 Scope boundaries

- **No deletion or purge** — COMP-007 / ACC-005, with their own two-step confirmation, cooling-off and staged
  purge. A separate requirement id and a separate ticket.
- **No public-artifact offlining.** Canon's own Effects column marks it *"(future)"*.
- **No HTTP surface.** The core use case is the boundary this ticket delivers, matching CDR-078 §4. The
  **enforcement** half needs no route to be real — it lives in the dispatcher and the run coordinator, which are
  production paths — but the **initiating transition** will have no HTTP caller when this merges, and that is
  disclosed here rather than implied away (§7.3).
- **No new halt mechanism** (§3-G4).

## §5 What "done" has to mean here

Gate 14's threat is **zombie autonomous work**, so the acceptance test is behavioural, not structural:
deactivate, then attempt to schedule and to dispatch, and be refused **by production code paths** — not by a pure
predicate a test called directly. The existing invariant-16 test is the counter-example this ticket exists to
stop repeating, and it will be **rewritten to drive the real paths**, with its original assertion kept only where
it is genuinely a unit test of the predicate.

## §6 Slices

1. **CDR + branch + draft PR** (this).
2. **Contracts**: the widened lifecycle vocabulary, the legal-transition table including the two-phase
   deactivation, and the fail-closed gate as a pure total function over `(companyStatus, accountStatus)`.
3. **Migration**: widen `companies_status_valid`; decide and widen the account vocabulary (§7.4).
4. **Enforcement**: wire the gate into the run coordinator and the dispatcher; rewrite the invariant-16 test to
   drive real paths.
5. **The transitions**: `deactivateCompany`, the system `deactivating → deactivated` step, account deactivation,
   audit events, safe-stop via the existing stop machinery.
6. **Real-PostgreSQL Gate-14 suite** + independent review + mutation testing + docs + finalization.

## §7 Open owner decisions

1. **The two Post-MVP cells** (§2) — ACC-004's requirement row and journey J-20 both say Post-MVP while Gate 14
   is a launch gate. Correct them, or record that the gate list supersedes them.
2. **What "reactivation" means for a DEACTIVATED company** (§3-G9). Canon marks the state terminal, so there is
   no transition to build; the honest options are a support-mediated restore, or "create a new company". Which
   one gets documented is a product decision, and this ticket will not default it.
3. **The initiating transition will have no HTTP caller on merge** (§4). Not worked around by wiring a route,
   which would put a lifecycle mutation on an unreviewed surface; disclosed so it is visible.
4. **The account vocabulary.** `accounts.status` is `active | suspended | closed` and `DATA-ARCHITECTURE:9`
   describes `active→suspended→closed`; `WORKFLOW-STATE-MACHINES` has **no account section at all**. Whether
   ACC-004's "deactivated" is `suspended`, `closed`, or a new value is a canon gap, and it changes what billing
   and support mean for the account. Proposed default, to be confirmed: **reuse `suspended`** for
   owner-initiated deactivation (reversible, data retained) and leave `closed` for the post-deletion terminal
   state — but this is flagged, not assumed.
