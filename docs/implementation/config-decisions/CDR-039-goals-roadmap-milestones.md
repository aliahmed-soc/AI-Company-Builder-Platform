# CDR-039 — Goals, roadmap and milestones (ACBP-P4-001)

Design record for ACBP-P4-001. Canon-derived; every non-obvious reading is documented in §7 rather than guessed.

## 1. What this builds (canon)

**ROAD-001** (`product-specification/REQUIREMENTS.csv`, Must / MVP, deps `STRAT-003`) — verbatim:

> "Selecting a strategy generates goals, a roadmap, milestones, and initial tasks, stored as living documents."
> Acceptance: "Roadmap contains goals, milestones with target sequencing, and generated tasks trace to milestones."
> Fail: "Generation failure preserves the approved strategy and retries; **partial roadmaps are labeled**."

**ROAD-002** (Should / MVP, deps ROAD-001):

> "Roadmaps are versioned and editable; changes flag affected tasks and record rationale." Acceptance: "Edits create
> versions with author and reason; affected open tasks are flagged for review." Fail: "**Version write failure blocks
> the edit rather than losing history**."

**J-09** (`MASTER-PRD-v1.md`): "goals → roadmap → milestones → initial tasks traceable to milestones (ROAD-001). Fail:
partial generation labeled partial; retry available. Accept: every initial task traces to a milestone; roadmap
versioned (ROAD-002)." **J-08**: "decision recorded before any planning."

**DATA-ARCHITECTURE** — Goal, Roadmap (`roadmap_id, version`, "from Decision"), Milestone ("Tasks trace to it"); all
company-owned and **`V`** (versioned). **API-CONTRACTS** — Goals/Roadmaps: "get, edit (versioned)", "edits +
expected_version + reason", **"Owner (edit)"**, version-guarded. **EVENT-CATALOG** — `roadmap.generated`.

**Storage note.** ADR-016 (generated-artifact object storage) is **blocked** on the provider selection (ACBP-P0-005 /
IOQ-05). Roadmap content therefore stays in **Postgres**, following the `understanding_documents` (0019) precedent.
Adopting object storage later is additive; depending on it now would make this ticket owner-gated.

## 2. The planning gate (load-bearing)

J-08's "decision recorded before any planning" is enforced here, and **the predicate is not "a decision exists"**.
STRAT-006 requires a decision record for a **rejection** too, so P3-005 stores an immutable `decisions.mode` snapshot
precisely for this gate (`CDR-038 §6-G1`). Cross-checked against `WORKFLOW-STATE-MACHINES.md`, where only
`ready_for_review→selected` carries the effect "planning unlocked" while `→rejected` "routes to understanding review".

**The gate:** the company's **latest** decision (append-only, latest-wins — CDR-038 §6-G5) must exist and have
`mode <> 'reject'`. It is **re-verified inside the persist transaction** (the P3-001 optimistic-concurrency
precedent): if the latest decision changed during the model call, nothing is persisted and the caller gets
`stale_decision`. The generated `roadmaps` row carries `decision_id NOT NULL`, so the gate is auditable after the fact
and DATA-ARCHITECTURE's "Roadmap … from Decision" is structural.

Result union (the P3-001 shape): `ok | forbidden | no_decision | decision_rejected | stale_decision |
generation_failed`. `no_decision` and `decision_rejected` are distinguished because an honest, actionable reason beats
a generic refusal — both are same-company facts, so neither leaks.

## 3. Storage — migration 0026 (additive; four tables + one additive constraint)

Migrations 0001–0025 untouched; no new SECURITY DEFINER (the closed allowlist stays exactly three), no new role, no
BYPASSRLS, no policy change. All four tables are company-owned, dual-keyed, `ENABLE`+`FORCE` RLS, fail-closed
`select`/`insert` policies, grants **SELECT+INSERT only**.

- **`roadmaps`** — versioned append-only (the `understanding_documents` 0019 precedent). `version` +
  `UNIQUE(company_id, version)`; `decision_id` FK; `status` {`complete`, `partial`}; `origin` {`generated`, `edited`};
  `supersedes_roadmap_id`; `edit_reason` (CHECK: null iff generated, non-blank bounded iff edited — ROAD-002 "record
  rationale"); `model_flagged_partial`; `created_by_user_id` (ROAD-002 "with author"). **A new version is a NEW ROW,
  never an in-place edit**, which is what makes ROAD-002's "version write failure blocks the edit rather than losing
  history" structural rather than procedural.
- **`goals`** — immutable. `roadmap_id` FK cascade; `ordinal` + `UNIQUE(roadmap_id, ordinal)`; bounded
  `title`/`description`; `status` {`active`, `achieved`, `dropped`}. Plus an additive `UNIQUE(id, roadmap_id)` so the
  milestone composite FK below can reference it (the 0023/0025 trick).
- **`milestones`** — immutable. `roadmap_id` FK cascade; **nullable** `goal_id` with a composite FK
  `(goal_id, roadmap_id) → goals(id, roadmap_id)` so a milestone can never point at a goal from a different roadmap
  **version**; `ordinal` + `UNIQUE(roadmap_id, ordinal)` (ROAD-001 "target sequencing"); `status` {`planned`,
  `reached`, `dropped`}.
- **`task_review_flags`** — immutable (ROAD-002 "changes flag affected tasks"). `task_id` FK cascade; `roadmap_id` FK
  cascade (the **new** version that caused the flag); bounded `reason`; `UNIQUE(task_id, roadmap_id)` so a re-flag is
  idempotent. **Why a table and not a `needs_review` column on `tasks`:** `tasks` grants only
  `UPDATE(state, updated_at)` and the adversarial catalog suite pins that exact grant set; an append-only flag table
  matches the `understanding_item_reviews` (0020) precedent and avoids widening an existing grant.
- **One additive change to an existing table**, reversed by `down()` (the 0025 precedent):
  `tasks_milestone_fk (milestone_id) → milestones(id) ON DELETE SET NULL`. This closes the P4-002 review NOTE
  ("`milestone_id` has no FK/validation … flagged for P4-001"), making ROAD-001's "tasks trace to milestones"
  enforceable rather than advisory. The cascade action runs as the table owner, so the app role's missing
  `UPDATE(milestone_id)` grant is not an obstacle.

**Versioning ↔ tasks.** A task's `milestone_id` points at a milestone belonging to **one** roadmap version. When a
ROAD-002 edit creates version *N+1*, existing tasks still reference version *N* — which is exactly why ROAD-002 says
**flag** affected tasks rather than silently re-point them. The flag table is that mechanism, and the older version
stays intact ("Versions retained").

## 4. Generation — model call, metering, and the partial-honesty rule

Roadmap generation is a **metered model call** (backlog: "Model usage metered"). The gateway is injected (never the
implementation), the call runs **between** scoped transactions, and **metering is the gateway's job** — it writes the
`usage_events` row in its own short transaction and withholds output if metering fails; this use case writes no usage
code. A new closed template family `planning.roadmap` + template `planning.roadmap@1` (taskClass `generation`) and a
`planning.roadmap.output@1` validator that fails closed on an unknown schema ref. `FakeModelProvider` in tests; the
live provider remains the pre-existing deferred gate (CDR-026 §0).

**Partial honesty (CDR-029's rule, applied verbatim):** a gateway **failure** or a **malformed/unparseable** output
persists **NOTHING** — `generation_failed`, no roadmap row (a failure must never masquerade as a partial roadmap).
`status = 'partial'` is reserved for a **successfully parsed** output that the model itself flags `partial: true`,
parsed deny-by-default (absent → complete; non-boolean → reject, no coercion). ROAD-001's "generation failure
preserves the approved strategy and retries" is automatic: everything upstream (decision, selection, options,
understanding) is immutable, and a retry is simply another call producing a new version — no retry machinery needed.

## 5. Authz + audit

- **`roadmap:generate`** `owner|viewer` and **`roadmap:read`** `owner|viewer` — the generation-class precedent
  (`understanding:generate`, `strategy:generate`).
- **`roadmap:edit`** **`owner`-only** — API-CONTRACTS says "Owner (edit)"; the `understanding:confirm` /
  `strategy:select` / `decision:record` owner-only precedent.
- **`roadmap.generated`** (new) — subject = the roadmap id; scalar metadata `{roadmap_version, goal_count,
  milestone_count, status, model_flagged_partial}`. EVENT-CATALOG's `task_ids[]` **cannot** be metadata (arrays are
  forbidden there), so it becomes a count — the `strategy.generated` / `decision.recorded` precedent (CDR-038 §6-G4).
  P4-001 generates no tasks, so the task count is P4-003's concern.
- **`roadmap.edited`** (new; §7-G2) — subject = the **new** version's id; scalar metadata `{roadmap_version,
  supersedes_version, affected_task_count, has_reason}`. **Never** the reason text, titles, or descriptions.

Both events are written in the **same transaction** as their rows (ADR-015 audit-or-nothing) — that is what makes
ROAD-002's "version write failure blocks the edit" true end to end.

## 6. Slice plan

1. CDR-039 + contracts (roadmap output parse/validate, DTOs, template family + `planning.roadmap@1`, the three authz
   actions, the two audit events + the Planning partition domain) + unit tests.
2. Migration 0026 + repo/schema/index + every reset list and catalog surface + a real-PG suite.
3. Core `generateRoadmap` (ROAD-001) — the gate, the gateway, partial honesty, persist+audit in one transaction — plus
   the read surface and a real-PG suite.
4. `editRoadmap` (ROAD-002) — new version + affected-task flags + `roadmap.edited`, all in one transaction.
5. Docs + independent review (fix every finding) + finalization.

ROAD-001 (Must) lands before ROAD-002 (Should) so that a mid-ticket stop still leaves a coherent, canon-satisfying
"Must" behind (§7-G8).

## 7. Ratified design decisions (canon-derived; documented, not guessed)

- **G1 — the gate is "the LATEST decision is non-reject", not "there exists a non-reject decision".** Canon pins
  `mode <> 'reject'` (CDR-038 §6-G1) and latest-wins reads (§6-G5) but is silent on whether a later rejection
  re-blocks an already-generated plan. Latest-wins is the stricter reading and mirrors the understanding precedent
  (`confirmed && !corrected`, where a later correction re-blocks downstream work). Loosening later is additive;
  tightening later is not.
- **G2 — a ROAD-002 edit emits a new `roadmap.edited` event, not `roadmap.generated`.** EVENT-CATALOG registers only
  `roadmap.generated`, but reusing it for a hand-authored version would misreport an owner edit as a model generation.
  Registering an additional event is additive; repurposing an emitted event's meaning later is not.
- **G3 — P4-001 does NOT generate tasks.** ROAD-001 and J-09 both say "…and initial tasks", but the backlog gives
  P4-001 `Data = goals;roadmaps;milestones` (no tasks) and assigns "Planning generates prioritized tasks traced to
  milestones" to **P4-003** (PLAN-001), whose acceptance is "3+ prioritized tasks traced". The backlog outranks PRD
  acceptance criteria in the canonical source order, and the split is coherent: P4-001 builds the planning objects,
  P4-003 generates tasks into them. P4-001 instead makes ROAD-001's traceability **enforceable** by adding
  `tasks_milestone_fk`.
- **G4 — `goals.status` / `milestones.status` exist, but nothing can transition them yet.** DATA-ARCHITECTURE gives
  `active→achieved/dropped` and `planned→reached/dropped`, but no state machine is defined and no Phase-4 ticket owns
  progress tracking. The columns are created with closed CHECK sets and defaults and **no UPDATE grant** (both tables
  stay fully immutable). Adding a column-scoped UPDATE grant later is additive; removing one is not. Coherence note:
  because goals and milestones belong to an *immutable roadmap version*, progress is better modelled later as an
  append-only progress-event table (the `understanding_item_reviews` pattern) than as in-place mutation.
- **G5 — `milestones.goal_id` is nullable, with a composite FK.** DATA-ARCHITECTURE has both entities "belong to
  Roadmap" and defines no goal↔milestone edge, while J-09's "goals → roadmap → milestones" implies a chain without
  pinning it. Nullable permits the chain when the model produces it, invents no requirement, and the composite FK
  makes a cross-version link impossible at the DB.
- **G6 — milestone sequencing is `ordinal` only; no `target_date`.** ROAD-001 says "target sequencing", not dates.
  A model-invented date is exactly the fabricated precision ADR-019 forbids. A nullable date can be added later.
- **G7 — "affected open tasks" is defined concretely.** ROAD-002 does not define either word. **Affected** = tasks
  whose `milestone_id` belongs to the superseded roadmap version; **open** = `state NOT IN ('completed', 'failed',
  'cancelled')` (derived from the closed task state set and the terminal states in WORKFLOW-STATE-MACHINES §4). Flags
  are written in the same transaction as the new version and `roadmap.edited`.
- **G9 — the gate applies to EDITS, not only to generation.** An edit authors the new **current** roadmap version, so
  it is planning. If only generation were gated, a rejection could be side-stepped by revising instead of
  regenerating, and the company's current plan would be one authored after the strategy was rejected — contradicting
  §2 ("J-08 … is enforced here") and WORKFLOW's `→rejected` routing back to understanding review. `editRoadmap`
  therefore applies the same `classifyPlanningGate` and returns `decision_rejected`. *(Added after the independent
  review found the edit path ungated.)*
- **G10 — the defensive re-entry re-applies the PERSISTABILITY invariants, not just types.** The gateway is injected,
  so a caller that wires a different or missing validator must not be able to persist a plan the parser exists to
  reject. `narrowRoadmapOutput` therefore re-checks emptiness, the one-sided/partial rule, item counts and title and
  description bounds — a weaker backstop would let an empty plan persist labeled `complete`, or let a length only the
  DB rejects surface as a raw constraint error instead of an honest `generation_failed`.
- **G11 — a ONE-SIDED plan may only be labeled `partial`.** ROAD-001's acceptance is a roadmap containing goals **and**
  sequenced milestones, so a plan missing either side cannot honestly be `complete`; it is a legitimate partial. An
  EMPTY plan is neither — it is rejected outright even when flagged partial.
- **G12 — "affected open tasks" is scoped by COMPANY, not by the single superseded version.** Tasks are never
  re-pointed at a new version's milestones, so after the first revision they still reference the ORIGINAL version.
  Keying the flag query on "the version being superseded" would flag correctly once and then silently stop — a task
  two revisions stale would never be flagged again. At flag time every existing milestone belongs to a version the new
  one supersedes, so joining through `milestones` within the company is exactly the affected set. *(Refines G7 after
  the review found the re-flagging gap.)*
- **G13 — the version-uniqueness violation is mapped to the honest stale result.** The read-then-insert guard runs at
  READ COMMITTED, so two writers can both pass it; `roadmaps_company_version_uq` is the real serializer. The loser is
  mapped to `stale_decision`/`stale_version` — scoped to that EXACT constraint, never a blanket 23505 (CLAUDE.md).
- **G14 — the `tasks.milestone_id` FK is TENANT-PINNED.** Referential-integrity checks always bypass row security, so
  a single-column FK would let a member of company B create a task naming company A's milestone (an existence oracle,
  and a cross-tenant `SET NULL` when A drops that version). The FK carries `company_id`, with a column-scoped
  `ON DELETE SET NULL (milestone_id)` (PostgreSQL 15+; CI runs 16) so the task's tenancy is never nulled.
- **G8 — both requirements stay in this ticket, ROAD-001 first.** ROAD-002 is only a "Should", but the backlog's
  single acceptance criterion for P4-001 is "Versioned edits flag affected tasks" — the ROAD-002 path. Both are
  therefore in scope, sliced Must-first.

## 8. Out of scope / deferred

Task generation + chat steering + phase-scope enforcement (**P4-003**); task dependencies and board views
(**P4-004**); task detail / repeat / delete / reject controls (**P4-005**); the planning input snapshot and per-task
rationale (**P4-006**); the Slice D E2E demo (**P4-007**); goal/milestone progress transitions (no Phase-4 ticket owns
them — §7-G4); any HTTP route or UI (deferred with the strategy surface, CDR-026 §0); object storage (ADR-016 /
ACBP-P0-005 is blocked); any new SECURITY DEFINER, role, or BYPASSRLS.
