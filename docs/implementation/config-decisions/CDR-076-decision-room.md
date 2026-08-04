# CDR-076 — Decision Room and activity completion (ACBP-P6-008)

Governing: **DEC-001** (Decision Room hub, ten queues), **ACT-001** (company activity feed), **ACT-003**
(proposed-vs-executed distinction), **ACT-004** (usage and credit visibility); ADR-015 (audit source of record +
activity projection); `diagrams/11-activity-and-audit-flow.mmd`; PRD §11.4; **invariant 20** (a thing may be shown
as completed only if a run record exists); trust-critical **#18** (evidence joins).
Depends on **ACBP-P1-009** (activity projection + feed, Done) and **ACBP-P6-003** (approval engine + inbox, merged).

---

## §0 The finding that reorders this ticket

A Decision Room is a **read surface**, so the instinct is to treat it as low-risk. That instinct is wrong, and the
reason is worth stating before any design: **this surface can lie in two directions, and the second one is
invisible.**

**Lie 1 — hollow success.** A task row can say `state = 'completed'` while no `task_runs` row ever succeeded for it.
Rendering that as a result tells the founder work was done that nobody can evidence. This is invariant 20 and
trust-critical #18, and it is the failure the backlog names as *"hollow-success rendering impossible"*.

**Lie 2 — the empty queue that is empty because the query broke.** In a Decision Room, *"nothing needs your
decision"* is **a positive claim**, not the absence of one. A section that silently degrades to empty renders
**pixel-identical to a calm day**. The founder stops looking. This is the same shape of defect as ACBP-P6-007's
stop that silently fails to reach a scope: the control appears to work, so the operator stops watching.

**And there is a mechanism trap sitting directly under lie 2.** The obvious implementation of *"queue failure
degrades per-section"* (the backlog's own wording) is a `try/catch` around each section inside the one
company-scoped transaction. **In PostgreSQL that turns one broken section into nine empty ones**: the first failed
statement aborts the transaction, and every subsequent query dies with `25P02 current transaction is aborted`.
The rendered result would be *one* section marked unavailable and *nine* reading "all clear" — the single most
dangerous output this surface can produce, arrived at by writing exactly what the acceptance criterion says.

Hence the two structural rules this ticket is built around, both stated before any queue was written:

1. **An empty section and an unavailable section are different types**, not the same type with a different count
   (§3-G1). A count is `null` unless the section actually ran.
2. **Each section runs inside its own SAVEPOINT** (§3-G4), so a section that fails rolls back to its own savepoint
   and the other nine keep their snapshot. Proven by a test that injects a failing section and asserts the other
   nine are still `ok` — not by inspection.

## §1 What already exists — this is COMPOSITION, not greenfield

| Piece | Where | State |
|---|---|---|
| Activity projection + keyset feed | `activity_events`, `ActivityFeedRepository` (P1-009) | built; four company events only |
| Approval inbox | `ApprovalRepository.listPending`, `listApprovalInbox` (P6-003) | built |
| Approval decisions (append-only) | `approval_decisions` (P6-003) | built |
| Policy evaluations trail | `policy_evaluations` (P6-001) | built |
| Emergency stop + held work | `emergency_stops`, `held_work` (P6-007) | built |
| Task state machine (11 states) | `tasks`, `TASK_STATES`, `isTaskHold` (P4-002) | built |
| Run records | `task_runs` (5 states), `worker_runs` (P5-005) | built |
| Artifacts | `artifacts`, keyed to `run_id` (P5-011) | built |
| Strategy options + immutable decisions | `strategy_*`, `decisions` (P3-001…005) | built |
| Interview Q&A | `interview_questions` / `interview_answers` (P2-002) | built |
| Company-scoped usage | `usage_events`, dual-keyed account+company (P5-014/P6-009) | built |
| `acbp_app` SELECT grants on all of the above | migrations 0013…0050 | **already granted — verified** |

**Consequence (§3-G7): this ticket adds NO migration, NO table, NO SECURITY DEFINER function.** Every read it needs
is already granted and already RLS-confined. A read-only ticket that ships a migration would be adding blast radius
for nothing.

## §2 The ten queues, and where each one honestly comes from

DEC-001 names ten queues. Three of them have no dedicated entity in this repository, and the temptation is to
invent a plausible composition. **A queue built from an invented rule is worse than a queue that says it is
narrow**, because nobody can later tell which rows were product intent and which were an implementer's guess.

| # | Queue (DEC-001) | Source predicate (company-scoped) | Verdict |
|---|---|---|---|
| 1 | needs your decision | `approval_requests.status='pending'` (not expired at read time) + `held_work.status='held'` | direct |
| 2 | recommended next actions | `tasks.state='planned'` (planner-proposed, never executed), by `priority` | **narrowed — see G9** |
| 3 | questions from the AI team | `interview_questions` with no `interview_answers` row | **narrowed — see G9** |
| 4 | options under consideration | `strategy_options` of the latest generation with **no** `decisions` row, + the AI recommendation marker | direct |
| 5 | approved and queued | `tasks.state='queued'` + `approval_requests.status='decided'` not yet consumed | direct |
| 6 | executing | `tasks.state='running'` joined to their `task_runs.state='running'` | direct |
| 7 | results | `tasks.state='completed'` **AND** a company-pinned `task_runs.state='succeeded'` exists | **evidence join — G3** |
| 8 | blocked work | `tasks.state` in the four hold states + `held_work.status='held'` | direct |
| 9 | failed work | `tasks.state='failed'` + latest run's `failure_category` | direct |
| 10 | recent decisions | `approval_decisions` ∪ `decisions` (strategy), newest first | direct |

## §3 Decisions

**G1 — A section is `ok` | `restricted` | `unavailable`, and the count is `null` unless it is `ok`.**
An empty `ok` section is a positive claim ("there is nothing here"). `restricted` means the caller lacks the
authority to be told. `unavailable` means this surface does not know. These are three different sentences and the
DTO refuses to collapse them: `items` is empty and `count` is `null` for the latter two, so a consumer that
mistakes one for the other cannot render "0" from a section that never ran.

**G2 — Authorization: one new action, no widened authority.**
Room entry checks a new `decision_room:read`, granted to `['owner', 'viewer']` — **the same authority class as the
already-shipped `activity:read`**, so nothing a member could not already read becomes readable. Each section
additionally re-checks its own existing domain action (`approval:read`, `stop:read`, `usage:read`), unchanged and
un-widened. A section the caller cannot read returns `restricted`. No existing action's role set is edited by this
ticket.

**G3 — Invariant 20 is enforced by the join, not by a filter that can be forgotten.**
The results section is built from an INNER JOIN onto a succeeded, company-pinned `task_runs` row. A completed task
with no succeeded run **cannot be expressed** in the result DTO — that is what makes hollow-success rendering
impossible rather than merely discouraged. **But it is not silently dropped either**, because a disappeared
completion is its own dishonesty: it is counted in `integrity.unverifiedCompletions`. Zero is the expected value;
a non-zero value is a data-integrity signal, and it is surfaced rather than swallowed.

**G4 — SAVEPOINT per section (the §0 mechanism), and what is deliberately NOT caught.**
Every section body runs between a fixed-literal `savepoint` and its `release`; a throwing section issues
`rollback to savepoint` and is marked `unavailable`, leaving the transaction usable for the remaining sections.
Savepoint names are compile-time constants — never derived from input, so no interpolation exists to inject into.
**Not caught into `unavailable`:** (a) authorization outcomes, which are decided BEFORE any query runs and are
`restricted`; and (b) failure to resolve the company scope itself, which fails the entire request — that is the
tenant boundary, and degrading it to a partial page would be a fail-open.

**G5 — One snapshot, one honest `asOf`.**
All ten sections read inside ONE company-scoped transaction, so the counts are mutually consistent (a task cannot
appear in both `executing` and `results` because two sections read different instants). `asOf` is the PostgreSQL
transaction read timestamp, never application wall-clock — the same rule ACTIVITY.md already applies to the feed.

**G6 — The stream is poll-backed and says so in its own payload.**
No transactional outbox and no LISTEN/NOTIFY exists (P1-009 deferred the outbox deliberately). A stream that
implied push would be claiming a mechanism this system does not have, so the SSE contract declares
`deliveryMode: 'poll_backed'` and promises only *"you will learn of a change within one interval"*. It re-reads the
digest on a bounded interval, emits only when the digest changes, sends heartbeat comments otherwise, and stops at
a bounded maximum lifetime. **It re-authorizes on every tick**: a member whose access is revoked mid-stream has
their stream closed at the next tick rather than continuing to receive their former company's counts. The stream
carries the digest and the counts only — never queue payloads.

**G7 — No migration.** See §1. Verified: every table read here already grants SELECT to `acbp_app` and is already
RLS-confined to `app.current_account` + `app.current_company`.

**G8 — ACT-004 is COMPANY usage, gated on the existing owner-only `usage:read`.**
`usage_events` is dual-keyed to account **and** company, so a company-scoped read returns this company's usage and
nothing else. **No account-wide total appears in a company-scoped room** — surfacing sibling-company spend inside
one company's page would be a tenant-visibility regression dressed as a feature. Viewers get `restricted`, because
`usage:read` is owner-only today and this ticket does not widen it.

**G9 — Two queues are NARROWED, and the exclusions are named rather than quietly omitted.**
*Recommended next actions* = tasks in `planned` only. The strategy recommendation is NOT merged in here; it belongs
to queue 4, where the options it recommends live. *Questions from the AI team* = unanswered interview questions
only. **Deliberately excluded, with reasons:** `understanding_items.item_class='open_question'` (a gap in a
document, surfaced in the understanding review, not a prompt awaiting a reply) and `planning_runs.outcome =
'clarification'` (a run outcome, not a persisted question — surfacing it would require inventing an entity and
inventing its resolution semantics). If the owner wants either, it is a one-predicate addition; what is not
acceptable is shipping them silently and calling DEC-001 fully covered.

**G10 — Redaction.** Items carry ids, tenant-authored titles, states, timestamps and coarse actor types only. No
raw model output, no tool payloads, no approval payload hashes, no correlation/causation/idempotency ids, no
account ids. Same posture as the P1-009 feed DTO.

## §4 What this ticket does NOT do

- **No rendered UI.** Every shipped ticket in this repository is API-first and `apps/web` contains API routes only;
  a UI here would be the first, and would be unreviewable against the trust criteria in the same pass. *"Hollow
  success rendering impossible"* is therefore enforced **at the DTO boundary** (G3) — the strongest available
  place, since no renderer can display what the contract cannot represent.
- ~~**No new activity taxonomy.**~~ **Superseded within this ticket — see §7.** This bullet deferred the widening
  as "a separate change with its own CHECK-constraint migration". That was wrong about the ticket, not about the
  work: ACBP-P6-008 is titled *"Decision Room and activity completion"*, `docs/agent/PROJECT-STATE.md` records
  that no execution event reaches the founder-facing feed and names this ticket as the owner of the fix, and the
  Slice E journey asserts the absence with a message that says P6-008's scope has moved if it ever becomes
  visible. Deferring it would have been a silent reduction of named scope. §7 records what was built instead.
- **No writes.** The Decision Room decides nothing and mutates nothing; decisions are taken through the existing
  approval, stop and strategy endpoints.
- **No dead-letter job queue section.** `jobs` is an infrastructure table, not a tenant surface; exposing it would
  put worker internals into a founder-facing page.

## §5 Verification plan (what must be proven, not asserted)

| # | Claim | How it is measured |
|---|---|---|
| 1 | Ten queues, correct counts | Real-PG suite seeds each queue's exact preconditions and asserts membership + count |
| 2 | Hollow success impossible | A `completed` task with no succeeded run is seeded; asserted absent from results **and** counted in `integrity.unverifiedCompletions` |
| 3 | One failing section does not empty the others | A section is forced to throw; the other nine asserted `ok` (this is the §0 test) |
| 4 | Empty ≠ unavailable | Asserted at the type level and in tests: `count === null` when not `ok` |
| 5 | Never the wrong company | Two-tenant adversarial: company B's rows never appear in company A's room |
| 6 | Restricted, not empty | A viewer's usage section is `restricted`; an outsider is denied at the room |
| 7 | Stream dies on revocation | Membership revoked mid-stream → stream closes at the next tick |
| 8 | One snapshot | A task cannot appear in two mutually exclusive sections of the same response |

## §6 Residual risks (accepted, and stated at their limit)

- **Poll-backed latency.** Change notification is bounded by the tick interval, not instantaneous. Labelled in the
  payload (G6); a true push needs the deferred outbox.
- **`integrity.unverifiedCompletions` is a count, not a diagnosis.** It says *how many*, not *which* or *why* —
  identifying them is an operational query, not a founder-facing surface.
- **Per-section savepoints cost one round trip each.** Accepted deliberately: the alternative is the §0 failure.
- **The narrowing in G9 means queues 2 and 3 under-report** relative to the broadest possible reading of DEC-001.
  Under-reporting is the safe direction (it never claims work that is not there), and the exclusions are named.
- **A `restricted` section tells the caller the section exists.** That is intended: the shape of the room is not
  secret, only its contents.

## §7 Activity completion — the taxonomy widening (ACT-001, ACT-003, ACT-005)

**The gap.** Until this ticket the founder-facing feed rendered exactly four `company.*` events. Every task and
every approval was fully audited and completely invisible to the founder whose company performed it: they could
read that their company had been created and nothing about the work done inside it. ACBP-P5-013 tried to close
part of it, widened `ACTIVITY_TYPES` alone, and reverted — no migration moved the CHECK, nothing called the
projector, and the projector is fail-closed, so the first correct wiring would have made every run failure roll
back its own audit write.

**What shipped.** Seven types, and all four required changes made together for each:

| Type | Marking | Summary (the ONLY fields projected) |
|---|---|---|
| `task.created` | executed | `has_milestone` |
| `task.started` | executed | `attempt` |
| `task.completed` | executed | `artifact_count`, `no_artifact_rationale` |
| `task.failed` | executed | `attempt`, `failure_category`, `retry_state` |
| `approval.requested` | **proposed** | `tool_id`, `risk_class`, `scope`, `estimated_cost_credits` |
| `approval.approved` | executed | `decision_path`, `decider_type` |
| `approval.rejected` | executed | `decider_type` |

**Decisions inside the widening.**

- **ACT-003 became real.** `executionStateFor` was a constant returning `'executed'`; the marking was true by
  accident of the taxonomy. `approval.requested` is the first genuine proposal in the feed, which is what lets a
  founder distinguish *"the platform asked to send three emails"* from *"the platform sent three emails"*.
- **`run_id` is projected nowhere.** The feed is a human-readable trail, not a join key; the audit event keeps
  the linkage for whoever is entitled to follow it.
- **Rejections project.** A feed that showed approvals and dropped refusals would read as though the platform
  had never been told no.
- **Reaped failures project too** (`worker_lost`, from the reclaim sweep). A feed honest about failures a worker
  reported and silent about the ones where the worker vanished would hide the more alarming kind.
- **No backfill.** Migration 0053 widens the CHECK going forward only. The historical audit rows exist, but a
  projection is a redacted view built by an allowlist that did not exist when they were written; replaying them
  would present today's redaction rules as though they had governed yesterday's events.
- **Fail-closed is preserved and now proven.** If the feed row cannot be written the state change is undone —
  `activity-execution.integration.test.ts` forces a projector failure on `planTask` and asserts the task stays
  `draft` with no audit row.

**The tripwire fired as designed.** Three contract tests and the Slice E journey step asserted the OLD truth
(*"task.failed is NOT projectable"*, *"every company event is an executed fact"*, *"execution has NOT reached the
feed"*). All four were rewritten to assert the new one, which is the outcome those assertions existed to force.
