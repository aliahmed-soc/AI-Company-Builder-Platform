# CDR-040 — Task generation and chat steering (ACBP-P4-003)

Design record for ACBP-P4-003. Canon-derived; every non-obvious reading is documented in §8 rather than guessed.

## 1. What this builds (canon)

**PLAN-001** (`product-specification/REQUIREMENTS.csv`, Must / MVP, deps `COMP-002;STRAT-003`) — verbatim:

> "The system reviews company state and generates prioritized tasks with descriptions and types."
> Acceptance: "Planning produces 3+ prioritized tasks linked to the selected strategy; **each has type and
> description**; planning is visible in the activity feed."
> Fail: "Planning failure is visible with reason; **no phantom tasks**."

**PLAN-002** (Must / MVP, deps PLAN-001):

> "Users can direct planning through a chat/planning surface (e.g., ask for tasks toward a goal)."
> Acceptance: "A natural-language planning request produces **relevant tasks or an honest refusal**; **intent and
> effect are previewed before task creation**."
> Fail: "**Ambiguous requests trigger clarification, not guessed execution**."

**Traced to milestones** is pinned by ROAD-001, J-09 ("every initial task traces to a milestone") and MILESTONE-PLAN's
M4 exit criterion. It is already **structural**: migration 0026 added the tenant-pinned
`tasks_milestone_fk (milestone_id, company_id) → milestones(id, company_id)`, so a generated task's milestone must
exist and belong to the same company.

**Task types** — a closed initial set (`MASTER-PRD-v1.md`): market research; competitor research; customer-segment
analysis; business-model comparison; business-plan generation; landing-page copy; internal product requirements.

## 2. The preview is the `draft` state (canon-native, not a new mechanism)

PLAN-002 requires "intent and effect are previewed **before task creation**". Canon already has the mechanism:

- `diagrams/06-planning-and-task-loop.mmd`: `[*] → draft : planning generates (PLAN-001) or user steers via chat
  (PLAN-002)`, then `draft → planned : traces to milestone`.
- `WORKFLOW-STATE-MACHINES.md` §4 `draft→planned`: actor "system (planning) / user"; effect **"appears on board"**;
  audit `task.created`.
- `CDR-033 §4`: a **draft is not on the board and writes no audit**.

So: generation and steering both mint tasks in `draft` — visible to the owner, absent from the board, no audit event.
**Confirming the preview is the existing `planTask` `draft→planned` transition**, which emits `task.created`. P4-003
introduces no new preview object, no client-echoed payload, and no new confirm path.

## 3. The gate

**Reuse `classifyPlanningGate` unchanged** (exported from `@acbp/core/planning` for exactly this; already reused by
`editRoadmap`). The company's **latest** decision must be non-reject — never "a decision exists", because STRAT-006
records rejections too (CDR-038 §6-G1, CDR-039 §7-G1/§7-G9).

**Additionally gate on a current roadmap existing.** Every generated task must carry a `milestone_id`, and milestones
only exist inside a roadmap version; with no roadmap there is nothing to trace to, and M4's exit criterion could not
hold. Result: `no_roadmap`.

Both the decision and the **roadmap head** are re-verified inside the persist transaction (the P4-001 pattern): a
decision recorded during the model call → `stale_decision`; a roadmap edit during the model call → `stale_roadmap`
(otherwise the tasks would be pinned to a version ROAD-002's flagging has already superseded).

## 4. STRAT-005 — the phase boundary, enforced here

STRAT-005: "Phase-only approval **generates tasks solely for that phase**; later phases remain visibly 'not
approved'." Fail: "**Work generation respects the approval boundary; violations are blocked server-side**."

`CDR-037 §5` recorded that P3-004's `phase_scope` is a **flag only** and explicitly deferred the enforcement to "P4-003
(the planning boundary)"; `IMPLEMENTATION-ROADMAP-v1.md` lists STRAT-005 under Phase 4 as "phase boundary respected in
generation"; the traceability matrix maps STRAT-005 to `ACBP-P3-004;ACBP-P4-003`. **This ticket owns it.**

Implementation: read the decision's selection (`phase_scope`), then restrict the milestone set the model may plan
against — and re-check server-side that every returned milestone ordinal is inside that set. A task naming an
out-of-scope milestone is refused, not silently re-pointed (§8-G3 defines "first phase").

## 5. Storage — migration 0027 (ALTER only; no new table)

Two additive columns on the existing `tasks` table, both required by canon rather than invented:

| Column | Canon | Shape |
| --- | --- | --- |
| `task_type` | PLAN-001 "each has **type** and description" | `text NULL`, CHECK null-or-one-of the seven PRD types |
| `priority` | PLAN-001 "generates **prioritized** tasks" | `integer NULL`, CHECK null-or-`>= 0` — a **rank**, no scale |

Both nullable: manual `createTask` supplies neither, and every existing row has neither (TASK-002: "missing fields
render explicitly as missing"). Both are **insert-only** — the column-level UPDATE grant stays exactly
`(state, updated_at)`, which the adversarial catalog pins. Consequence, stated plainly: J-10's "adjust priorities" is
**not reachable** by this ticket and is left to a later one rather than widening a pinned grant (§8-G9).

No new table ⇒ no reset-list sweep. The surfaces that do change are `TasksTable`, the catalog's forbidden-column list
for `tasks`, and a migration-applied assertion.

## 6. Generation — model call, metering, honesty

Both use cases are **metered model calls**; metering is the gateway's own job (it writes the `usage_events` row in a
short transaction and withholds output if metering fails), so neither use case writes usage code. The gateway is
injected; the live provider remains the pre-existing deferred gate (CDR-026 §0) and tests use `FakeModelProvider`.

Two new closed template families — `planning.tasks` (slots `['roadmap']`) and `planning.task_steering` (slots
`['roadmap', 'steering_request']`). Two rather than one because the registry asserts declared slots ⇔ placeholders
exactly, so a single family cannot carry an optional steering slot. Both `taskClass: 'generation'`.

**Honesty (CDR-029's rule, which CDR-039 §4 already applied):** a gateway **failure** or a **malformed/unparseable**
output persists **NOTHING** — `generation_failed`, zero task rows, zero audit events. That is precisely the backlog's
"Planning failure visible; **no phantom tasks**". `partial` is parsed strictly (absent → complete; non-boolean →
reject, never coerced). Per CDR-039 §7-G10, the defensive re-entry re-applies the **persistability** invariants (item
counts, bounds, milestone-ordinal resolvability, the ≥3 rule), not just types.

**Three distinct SUCCESSFUL non-generating outcomes for steering** — this distinction *is* the PLAN-002 acceptance
surface, and conflating any of them with `generation_failed` would report an honest model answer as a system fault:

- `clarification_needed` + a bounded question → "Ambiguous requests trigger clarification, not guessed execution."
- `refused` + a bounded reason → "relevant tasks **or an honest refusal**."
- `generation_failed` → the gateway/parse failure only.

## 7. Authz + audit

- **`task:generate`** (new closed action) → `owner|viewer`, the generation-class precedent (`understanding:generate`,
  `strategy:generate`, `roadmap:generate`). It covers both autonomous generation and steering — both spend metered
  model budget. Confirming a preview reuses the existing `task:create` via `planTask`; unchanged.
- **No new audit event.** `task.created` (already registered, produced by `task.plan`) fires per **confirmed** task —
  which is the audit trail. EVENT-CATALOG registers no planning-run event, and its `roadmap.generated` row names the
  task module only as a *consumer*. P4-006 owns the run/snapshot linkage (PLAN-004). Registering an event later is
  additive; repurposing an emitted event's meaning is not (the CDR-039 §7-G2 rationale). See §8-G5.

## 8. Ratified design decisions (canon-derived; documented, not guessed)

- **G1 — `priority` is an integer RANK, not a scale.** PLAN-001 says "prioritized"; canon defines no scale, and there
  is no "priorit*" hit anywhere in `docs/architecture/`. An invented `high|medium|low` is fabricated precision
  (ADR-019) — the same reasoning as CDR-039 §7-G6 (ordinal sequencing, never invented dates). A coarse enum can be
  added later; removing one cannot.
- **G2 — the seven task types are a closed CHECK, nullable.** The PRD calls them "initial task types", so the set may
  grow; deny-by-default matches every other enum in the schema, and widening a CHECK later is additive.
- **G3 — "first phase" = the FIRST GOAL (`ordinal = 0`) and its milestones**; if the roadmap has no goals, the single
  lowest-ordinal milestone. Canon defines no "phase" object — `CDR-037 §5` says so explicitly — and STRAT-005's
  failure clause ("violations are blocked server-side") argues for the narrowest honest reading. Loosening later is
  additive.
- **G4 — the preview is persisted `draft` rows, not a stateless echo.** Canon routes both paths through `draft`
  (§2), so this invents nothing; it also avoids trusting a client-echoed payload on confirm. Cost, stated: unconfirmed
  drafts linger until P4-005's delete control lands — acceptable, since a draft is invisible on the board.
- **G5 — no new audit event** (§7). The backlog's `Audit = "roadmap.generated audited"` for this row is read as
  inherited boilerplate: that event is P4-001's, is subject-typed `roadmap`, and its metadata is already fixed.
- **G6 — generation into a `partial` roadmap is ALLOWED.** Canon is silent. A partial roadmap's milestones are real
  and FK-valid, and ROAD-001's failure clause says "retry available", not "downstream blocked".
- **G7 — no duplicate suppression on repeat generation.** "No phantom tasks" is about failures persisting nothing, not
  about idempotency. Repeated generation appends new drafts, matching the append-only house style.
- **G8 — no `tasks.origin` column and no persisted intent text.** Canon requires the intent be *previewed*, not
  stored; persisting the interpreted intent is squarely P4-006's "input snapshot". The generated/steered distinction
  can ride as a scalar in logs if ever needed.
- **G9 — `priority` is insert-only.** Widening the pinned `(state, updated_at)` column grant to make J-10's
  "adjust priorities" reachable is out of scope here and would weaken a constraint the adversarial catalog asserts.
- **G10 — ≥3 tasks is enforced for autonomous generation only.** PLAN-001's acceptance is "3+ prioritized tasks";
  PLAN-002's is "relevant tasks **or** an honest refusal", where a single relevant task is a legitimate answer. The
  ≥3 rule is a persistability invariant for `generateTasks` unless the model honestly flags `partial` (the CDR-039
  §7-G11 one-sided-plan precedent).

## 9. Slice plan

1. CDR-040 + contracts (task types, the two output parsers + defensive re-entries, the two template families,
   `task:generate`) + unit tests.
2. Migration 0027 (`task_type`, `priority`) + schema/repo/DTO + the catalog forbidden-column update + real-PG.
3. Core `generateTasks` (PLAN-001) + the STRAT-005 phase boundary + real-PG.
4. Core `steerTaskPlanning` (PLAN-002) with all three honest outcomes + real-PG.
5. Docs + independent review (fix every finding) + finalization.

## 10. Out of scope / deferred

Task dependencies + board views (**P4-004**); task detail / repeat / delete / reject controls (**P4-005**); the
planning input snapshot and per-task rationale (**P4-006**, PLAN-004 — no rationale is persisted here); the Slice D
E2E demo (**P4-007**); execution, task runs and the activity feed (**Phase 5** — PLAN-001's "visible in the activity
feed" depends on ACT-001..005, and activity fan-out is deferred throughout EVENT-CATALOG); any HTTP route or UI
(CDR-026 §0); any new SECURITY DEFINER, role, or BYPASSRLS.
