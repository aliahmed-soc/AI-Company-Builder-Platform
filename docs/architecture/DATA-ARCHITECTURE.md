# Data Architecture

Status: Proposed. **Logical model — not final migrations.** Vendor-neutral; ADR-007 governs isolation. Mutability: A = append-only, I = immutable after creation, V = versioned (new version per change), M = mutable with audit. Tenant: C = company-owned (`company_id` immutable), A = account-owned, G = global/platform.

## 1. Logical objects

| Object | Tenant | Key identifiers | Relationships | Lifecycle | Mut. | Sensitive fields | Retention | Audit | MVP |
|---|---|---|---|---|---|---|---|---|---|
| Account | A (root) | account_id | has Users via Membership; owns Companies | active→suspended→closed | M | billing refs | Life + legal hold post-deletion | All lifecycle changes | MVP |
| User | G (identity) | user_id, email | Memberships | active→deactivated→deleted | M | email, name, credentials hash | Until deletion (ACC-005) | auth events | MVP |
| Membership | A | (user_id, account_id, company scope) | User↔Account/Company + role | invited→active→revoked | M | — | Life of account | role changes audited | MVP |
| Company | C (root) | company_id, account_id | owns everything below | draft→onboarding→active→paused→deactivating→deactivated (→deleted) | M | — | Until deletion + retention | company.* events | MVP |
| Company profile | C | profile_id | 1:1 Company | with company | V | founder-provided business data | With company | version history | MVP |
| Provisioning checkpoint | C | (company_id, step) | 6 canonical steps per Company (ACBP-P1-012; CDR-018) | pending→completed / pending→failed (retry ≤3; no durable running) | M (current state; history = audit) | — | With company | provisioning.* audit-only events | MVP |
| Workspace area | C | (company_id, area) | closed set: mission_draft, research, roadmap, documents (ACBP-P1-012) | registered | A (append-only) | — | With company | via provisioning step audits | MVP |
| Platform admin | G (operator allowlist) | user_id (PK, FK users.id) | marks a User as platform operator (ACBP-P1-013; CDR-019) | active→revoked (shape CHECKs; owner-connection ops only — no runtime write path) | M (owner connection only; acbp_app = self-check SELECT only under FORCE RLS) | — | Permanent (revoked rows retained) | admin.tenant_read audit-only events record every use | MVP |
| Interview session | C | session_id | has Questions/Answers; feeds Understanding | not_started→in_progress→waiting_for_user→ready_for_review→confirmed→superseded | M (state) | founder answers | With company | interview.* | MVP |
| Question | C | question_id, session_id | belongs to session; may depend on prior Answer | asked→answered/skipped | I | — | With session | — | MVP |
| Answer | C | answer_id, question_id | 1:1 Question; source for memory items | given→revised(new row) | A (revisions append) | founder content | With session | corrections audited | MVP |
| Fact / Preference / Constraint / Assumption / Research finding | C | memory_item_id (typed) | realized as **Memory item** rows (MEM-001); linked to sources and dependents | proposed→accepted/confirmed→superseded/invalidated/deleted | V | business content | User-deletable (MEM-002) | all changes audited (MEM-003) | MVP |
| Strategy option | C | option_id | derives from Understanding version; feeds Decision | generating→ready_for_review→selected/rejected→superseded | I (content) | — | With company | strategy.* | MVP |
<!-- IMPLEMENTED (ACBP-P2-008; CDR-029): the Understanding artifact is realized as `understanding_documents`
     (versioned header — `version` unique per company, `status` complete|partial, `overall_confidence` = weakest
     section, UNDER-005) + `understanding_items` (classified into the closed 6-set fact/preference/constraint/
     assumption/research_finding/open_question, each with `confidence` + a `source_ref` provenance link to memory).
     Both company-owned, dual-keyed FORCE RLS, VERSIONED + APPEND-ONLY (SELECT+INSERT only — a re-generation is a
     new version; review/correct is P2-009). Generated via the gateway from confirmed memory; `understanding.generated`
     audited in-tx; usage metered. -->
<!-- IMPLEMENTED (ACBP-P2-009; CDR-030): the owner REVIEW + CONFIRMATION gate over an understanding version is realized
     as two additional company-owned, dual-keyed FORCE RLS, APPEND-ONLY tables (migration 0020) — because the P2-008
     tables are immutable, review/confirm are event logs, never in-place edits: `understanding_item_reviews` (one row
     per owner decision — the closed 5-control set approve/edit/reject/evidence_requested/research_requested; the
     item's effective state is its latest row; edits record the corrected text in `note`, never mutating the item) +
     `understanding_confirmation_events` (`kind` confirmed|corrected, UNIQUE(document_id,kind) → idempotent confirm +
     one correction per version; `correction_ref` + `dependents_flagged` set only for `corrected`). The strategy-unlock
     gate = the current version has a `confirmed` and no `corrected` event (planning blocked otherwise). This is the
     append-only realization of the assumption-lifecycle `confirmation_state` + `superseded_by` model above (UNDER-004,
     DISC-008): a correction never overwrites — it supersedes, re-blocking planning and flagging dependents.
     `understanding.item_reviewed`/`.confirmed`/`.corrected` audited in-tx. Evidence/research requests are RECORDED
     (a review row), not executed — the Research worker (P5) fulfils them. Owner-only. -->
<!-- IMPLEMENTED (ACBP-P4-002; CDR-033): the `Task` + `Task dependency` rows above are realized by migration 0021 as two
     company-owned, dual-keyed FORCE RLS tables. `tasks` is mutable-with-audit (`M`): SELECT+INSERT plus a COLUMN-scoped
     `UPDATE(state, updated_at)` grant ONLY — `id`/`account_id`/`company_id`/`title`/`description`/`milestone_id`/
     `created_*` are immutable to the app role; `state` is constrained to the closed 11-value set (draft·planned·queued·
     running·waiting_for_input·waiting_for_approval·blocked_by_policy·paused·completed·failed·cancelled). `task_dependencies`
     is immutable (`I`): SELECT+INSERT only, UNIQUE(task_id, depends_on_task_id), CHECK task_id<>depends_on_task_id (no
     self-dependency); a cross-company edge is impossible (both FKs + the dual key confine to one company). P4-002
     implements only the effect-free pre-execution transitions create→draft and the server-enforced draft→planned (the
     `interview.ts` precedent); the execution transitions (credit reservation on planned→queued, worker runs, holds,
     terminals) are DEFINED-legal in the state machine but their EFFECTS belong to later P5/P6 tickets. `milestone_id` is
     nullable — milestones are P4-001 (not yet built); ad-hoc tasks have none. No new SECURITY DEFINER / role / BYPASSRLS. -->
<!-- IMPLEMENTED (ACBP-P3-001; CDR-034): the `Strategy option` row above is realized by migration 0022 as two
     company-owned, dual-keyed FORCE RLS, IMMUTABLE (`I`) tables — `strategy_generations` (one generation from a
     CONFIRMED understanding version; closed status {complete, fewer_than_three}; `similarity_check_result`
     {pending, distinct, insufficient_distinct} — the P3-002 distinctness engine now sets the
     verdict; FK to understanding_documents) + `strategy_options` (the validated 16-field `fields` jsonb object;
     UNIQUE(generation_id, ordinal)). Both SELECT+INSERT only (a re-generation is a NEW generation, never an edit —
     the "generating→ready_for_review→selected/rejected→superseded" lifecycle's later transitions live in P3-004/005).
     P3-001 implements only the generation `gen` node: gated on the owner-confirmed understanding (strategy blocked
     pre-confirm), the 16-field standard with ADR-019 no-fake-precision labeling, and the honest fewer-than-three path.
     Model usage metered via the gateway; `strategy.generated` audited in-tx. No new SECURITY DEFINER / role / BYPASSRLS. -->
<!-- IMPLEMENTED (ACBP-P3-002; CDR-035): the STRAT-001 similarity check. `generateStrategyOptions` now runs a
     deterministic, model-free distinctness check (two options are genuinely distinct IFF they differ on ≥1 of
     {customer, offer, business_model}, normalized) and persists ONLY the distinct set — near-duplicates (cosmetic
     variants) are rejected, not stored. `similarity_check_result` is written `distinct` (≥3 distinct) or
     `insufficient_distinct`; the honest fewer-than-three outcome + reason follow from the DISTINCT count. No schema
     change (the existing column + enum + the P3-001 status↔option_count CHECK hold since option_count = distinct
     count); no new migration/audit/authz. `pending` remains a legal enum value but is no longer written by this path. -->
<!-- IMPLEMENTED (ACBP-P3-003; CDR-036): the OPTIONAL ADVISORY recommendation is realized by migration 0023 as one more
     company-owned, dual-keyed FORCE RLS, IMMUTABLE (`I`) append-only table `strategy_recommendations` (SELECT+INSERT
     only): FK to `strategy_generations` + the recommended `strategy_options` row; a bounded `rationale` +
     `sensitivities`. "No recommendation" = ABSENCE of a row (STRAT-004 "absent a defensible rationale, no
     recommendation is shown"); a re-recommendation is a new row (latest-wins on read). It is ADVISORY — it references
     one option and NEVER selects (selection is P3-004; decision records P3-005) or changes state. A model call
     (metered by the gateway) produces it; deny-by-default (one option in range + non-blank rationale + sensitivities,
     else honest abstain). NO new audit event (the recommendation changes no state — CDR-036 §4); no new SECURITY
     DEFINER / role / BYPASSRLS. -->
<!-- IMPLEMENTED (ACBP-P3-004; CDR-037): the OWNER's decision over a generation is realized by migration 0024 as one more
     company-owned, dual-keyed FORCE RLS, IMMUTABLE (`I`) append-only table `strategy_selections` (SELECT+INSERT only).
     One row per decision in a closed `mode` {select, edit, combine, reject}; mode-shaped nullable columns
     (`selected_option_id`, a `chosen_fields` jsonb object, `phase_scope` {first_phase, whole_plan}, `reasons`) enforced
     by CHECK constraints; a composite FK (selected_option_id, generation_id) → strategy_options(id, generation_id) keeps
     a named option in THIS generation. "No decision" = ABSENCE of a row; a re-decision is a new row (latest-wins on
     read). OWNER-ONLY (`strategy:select`; edit/combine fields are owner-supplied, NO model call). It records a SELECTION
     ONLY — it is NOT the immutable Decision record (decision.recorded is P3-005) and unlocks NO planning (the P4
     boundary). `phase_scope` is FLAGGING only (STRAT-005; enforcement is the P4 planning boundary — an owner-accepted
     Phase-3 deferral). `strategy.selected` audited in-tx (metadata {mode} + phase_scope when set — never content). No
     new SECURITY DEFINER / role / BYPASSRLS. -->
<!-- IMPLEMENTED (ACBP-P3-005; CDR-038): the Decision row below is realized by migration 0025 as the company-owned,
     dual-keyed FORCE RLS, IMMUTABLE (`I`) table `decisions` (SELECT+INSERT only) — the STRAT-006 audit-grade
     "institutional memory of why". It links the CONFIRMED understanding version (snapshot column), the options
     CONSIDERED (via `generation_id` — the generation's option set is itself immutable, so the link fixes exactly what
     was considered; the audit event carries the scalar count), the SELECTION it hardens (composite FK
     (selection_id, generation_id) → strategy_selections(id, generation_id), so a cross-generation decision is
     impossible at the DB), and an OPTIONAL bounded owner-supplied `rationale` (a missing rationale must never make a
     decision silently unrecorded — CDR-038 §6-G2). Immutability IS the acceptance criterion ("mutation attempts fail"):
     no UPDATE/DELETE grant. `decision.recorded` is written in the SAME transaction as the row — that audit-or-nothing
     pair IS the STRAT-006 "failed record writes block the transition" guarantee. Append-only, latest-wins on read
     (§6-G5 — the "terminal" state below is the product reading, not a DB uniqueness constraint). A `reject` selection
     ALSO gets a record (STRAT-006 "selection/edit/rejection"); the row therefore carries an IMMUTABLE `mode` snapshot
     of the hardened selection, and **the P4-001 planning gate must key off `mode <> 'reject'`, NOT on the mere
     existence of a decision row** — otherwise a rejection would unlock planning, contradicting the WORKFLOW `→rejected`
     terminal state. The snapshot is denormalized deliberately: the LATEST selection may be a different, later one than
     the decision hardened. OWNER-ONLY (`decision:record`). No new SECURITY DEFINER / role / BYPASSRLS. -->



<!-- IMPLEMENTED (ACBP-P4-001; CDR-039): the Goal / Roadmap / Milestone rows below are realized by migration 0026 as
     `roadmaps` + `goals` + `milestones`, plus a fourth table `task_review_flags` for ROAD-002's affected-task
     flagging. All company-owned, dual-keyed FORCE RLS, SELECT+INSERT only.
     `roadmaps` is VERSIONED append-only: UNIQUE(company_id, version), an unbroken supersedes chain, and an
     `edit_reason` shape CHECK (an EDITED version must carry a bounded reason — ROAD-002 "record rationale" — a
     GENERATED one must carry none). A revision is a NEW ROW, never an in-place edit, which is what makes ROAD-002's
     "version write failure blocks the edit rather than losing history" STRUCTURAL. It pins `decision_id` (J-08
     "decision recorded before any planning"); the gate is the company's LATEST decision being NON-reject
     (CDR-039 §7-G1) — a rejection is also recorded (STRAT-006), so mere existence must never unlock planning.
     `goals`/`milestones` are immutable, ordinal-sequenced per version (ROAD-001 "target sequencing" = ORDER only,
     never invented dates — ADR-019); a milestone MAY name its goal, pinned to the same version by a composite FK.
     The `status` columns below exist with closed CHECK sets but have NO transition path yet and NO UPDATE grant
     (CDR-039 §7-G4) — progress belongs in a later append-only event table, not in-place mutation.
     Migration 0026 also adds the `tasks.milestone_id → milestones` FK (ON DELETE SET NULL) that makes
     "Tasks trace to it" enforceable — the P4-002 review flagged its absence for this ticket. Roadmap CONTENT stays in
     Postgres. (ADR-016 object storage was blocked on the provider selection; ACBP-P0-005 resolved it on 2026-07-27 — CDR-048. Roadmap content still lives in Postgres: the artifact/document MODEL is ACBP-P5-011, which P0-005 gates.) Task GENERATION is P4-003
     (CDR-039 §7-G3). No new SECURITY DEFINER / role / BYPASSRLS. -->

<!-- IMPLEMENTED (ACBP-P4-006; CDR-041; PLAN-004): migration 0028 adds `planning_runs` + `planning_run_inputs` —
     company-owned, dual-keyed FORCE RLS, SELECT+INSERT only (a run is a HISTORICAL RECORD of what planning
     considered; rewriting it would defeat the requirement). One run row per planning invocation, autonomous or
     steered, recorded even when generation FAILED — "every planning run links its input snapshot" is unqualified,
     and a failed run is the one an owner most wants to inspect (§3-G3). Its `outcome` keeps steering's honest
     `clarification`/`refusal` DISTINCT from `failed`, and two CHECKs make the record internally consistent: an
     outcome can never contradict its task count, and a run can never report more missing rationales than tasks.
     The snapshot LINKS, never COPIES (§3-G2): `planning_run_inputs` holds resolvable references under a CLOSED
     `kind` discriminator (`roadmap` · `decision` · `milestone` · `memory_item` · `memory_item_withheld` · `metric` ·
     `prior_result`), so adding metrics (P6-009) or prior results (Phase 5) is an INSERT, not a migration. A
     MEM-004-conflicted item is linked as `memory_item_withheld` — considered and deliberately not used — because
     omitting it would make the snapshot claim the item was never examined.
     Both FKs to `roadmaps`/`decisions` are TENANT-PINNED composites (RI checks always bypass RLS), for which 0028
     additively adds `(id, company_id)` UNIQUE to both parents.
     0028 also adds `tasks.rationale` (PLAN-004's per-task "why"): nullable — a missing rationale renders as "not
     recorded" and is COUNTED, never invented (ADR-019) — and INSERT-ONLY, with the `(state, updated_at)` column
     grant untouched. This ticket also wires `assembleContext` into planning (AI-AND-WORKER §1 puts context assembly
     first in every generation path; P4-003 had skipped it), which is what makes the memory links real rather than
     always-empty. No new SECURITY DEFINER / role / BYPASSRLS. -->

| Decision | C | decision_id | links understanding version + options considered + selection | recorded (terminal) | **I** | — | Permanent (with company) | decision.recorded | MVP |
| Goal | C | goal_id | belongs to Roadmap | active→achieved/dropped | V | — | With company | roadmap versions | MVP |
| Roadmap | C | roadmap_id, version | has Goals/Milestones; from Decision | versioned | V | — | With company | ROAD-002 versions | MVP |
| Milestone | C | milestone_id | belongs to Roadmap; Tasks trace to it | planned→reached/dropped | V | — | With company | — | MVP |
<!-- IMPLEMENTED (ACBP-P4-003; CDR-040): migration 0027 adds two ADDITIVE columns to the Task row below, both required
     by PLAN-001 ("3+ prioritized tasks …; each has type and description"): `task_type` (a closed CHECK over the seven
     PRD "initial task types", NULLABLE — a missing type renders as explicitly missing per TASK-002 rather than being
     guessed) and `priority` (a non-negative integer RANK, NOT a scale — an invented high/medium/low would be the fake
     precision ADR-019 forbids, the same reasoning as §7-G6's ordinals-not-dates). BOTH ARE INSERT-ONLY: the
     column-level UPDATE grant stays exactly `(state, updated_at)`, so J-10's "adjust priorities" is deliberately not
     reachable yet rather than widening a grant the adversarial catalog pins (CDR-040 §8-G9).
     Planning mints tasks in `draft` — the PREVIEW state (PLAN-002 "intent and effect are previewed before task
     creation"): a draft is NOT on the board and writes NO audit (CDR-033 §4), and confirming is the existing
     `draft→planned` transition that emits `task.created`. The STRAT-005 phase boundary is enforced at generation
     (CDR-037 §5 deferred it here): only the approved phase's milestones are plannable, re-checked server-side. -->
<!-- IMPLEMENTED (ACBP-P4-005; CDR-043; TASK-002/TASK-008): migration 0029 adds `task_deletions` plus an ADDITIVE
     `tasks.repeated_from_task_id`.
     DELETION IS A RECORDED FACT, NOT AN ERASURE. TASK-008 requires that a delete be AUDITED, and `tasks` grants the
     app role SELECT + INSERT + a column UPDATE pinned to exactly `(state, updated_at)` — no DELETE, with the
     adversarial catalog pinning that set. Granting DELETE would destroy the very trail the requirement demands, and
     adding `deleted_at` would mean widening a grant the tenant-isolation suite pins (CDR-043 §3 weighed all three).
     So `task_deletions` is a separate company-owned, dual-keyed FORCE RLS table, SELECT+INSERT only — the same shape
     CDR-039 chose for `task_review_flags`, for the same reason. `UNIQUE(task_id)` makes a repeat delete the SAME fact
     rather than a second row, letting the use case be idempotent at the database instead of via a check-then-insert
     that would race. `state_at_delete` is retained because once reads filter the task out it is the only place the
     difference between discarding a completed task and a queued one survives; the optional `reason` is bounded and
     stays OUT of the audit payload (which records only `has_reason`).
     `repeated_from_task_id` is TASK-008's lineage link ("repeat creates a linked new task"): nullable, INSERT-ONLY
     (the `(state, updated_at)` grant is again untouched), CHECKed against self-reference, and `ON DELETE SET NULL`
     rather than CASCADE — losing the source must not delete the repeat, which is live work the owner queued.
     Both new FKs are TENANT-PINNED composites (RI checks always bypass RLS), for which 0029 additively adds
     `(id, company_id)` UNIQUE to `tasks`.
     Every product read excludes deleted tasks — get, detail, list, the board, and the off-board draft COUNT (§4-G9).
     `findStatesByIds` deliberately does not: a prerequisite deleted while `completed` genuinely did unblock its
     dependent, and filtering it out would turn that into a permanent false block.
     There is NO task "reject" control (CDR-043 §2): no requirement defines task rejection, so TASK-001's `Rejected`
     bucket stays declared-but-unreachable rather than merely pending. No new SECURITY DEFINER / role / BYPASSRLS. -->
<!-- IMPLEMENTED (ACBP-P5-001a; CDR-049; ADR-008; NFR-005/006; invariant 3, trust-critical #3): migration 0031 adds
     `jobs` — company-owned, dual-keyed FORCE RLS, the same shape as every other tenant table.
     WE OWN THIS TABLE, and that is the load-bearing decision. The Objective's "library per ADR-008" reads naively as
     "adopt pg-boss and use its job table", and those libraries manage their own DDL — a table we do not own cannot
     carry a NOT NULL tenant stamp or dual-keyed RLS. The owner's ADR-008 amendment settles it: "job tables remain
     standard SQL (exit path)". A runner may later POLL this table; it may not own the schema, and P5-001a therefore
     takes no library dependency at all.
     TENANT CONTEXT IS REFUSED, NEVER DEFAULTED, at THREE deliberately redundant layers (CDR-049 §3-G3), because each
     catches a different mistake: `NOT NULL` on account_id/company_id catches code that forgets the fields; the
     dual-keyed `WITH CHECK` catches a caller supplying SOMEONE ELSE'S ids (which NOT NULL cannot see, both columns
     being populated); and `validateJobTenancy` turns both into a typed reason. The third runs BEFORE scope
     resolution — found in review, because `runInCompanyScope` denies a blank company id itself and would otherwise
     report the acceptance clause's failure as an ordinary `forbidden`.
     `company_id` is NOT NULL rather than nullable-for-possible-account-jobs (§3-G4): a nullable column makes "no
     company" a legal state the moment anything writes NULL, which is exactly the defaulting this table forbids.
     Grants are SELECT + INSERT + a COLUMN-scoped UPDATE pinned to `(state, updated_at, attempts)` — tenancy, kind and
     payload are immutable, so a job can be neither re-pointed at another tenant nor have its work swapped between
     enqueue and execution. NO DELETE (§4-G5): job history is the run trail the "Run trail audited" behaviour depends
     on, and archival is a later deliberate operation rather than a routine capability.
     The state set is CLOSED and includes `dead_letter` from the start (§4-G6) even though P5-001c implements reaching
     it — a state added later by migration is a state the earlier code never handled. `JOB_STATES` in @acbp/contracts
     mirrors the CHECK, with a real-PostgreSQL test asserting the two agree.
     Idempotency is per COMPANY via a PARTIAL unique index on `(company_id, idempotency_key)`: a global unique would
     let one tenant's key collide with — and so reveal the existence of — another's. `ON CONFLICT` must restate that
     partial predicate; PostgreSQL will not infer a partial index from a bare column list (42P10).
     `payload` carries REFERENCES, NEVER SECRETS (ADR-008 §11), bounded by CHECK, with the contract bound set
     deliberately tighter so the contract is the error surface and the CHECK a true backstop.
     Checkpoints/resume (P5-001b) and retry caps/dead-lettering (P5-001c) are separate sub-scopes. No new SECURITY
     DEFINER / role / BYPASSRLS. -->
<!-- IMPLEMENTED (ACBP-P5-002; CDR-053; TASK-007; NFR-005; ADR-008): migration 0035 adds `task_runs` — company-owned,
     dual-keyed FORCE RLS.
     A RUN IS ONE EXECUTION ATTEMPT of a task, which is why `attempt` is part of its identity and why its state set is
     SMALL. WORKFLOW-STATE-MACHINES §4's richer set — waiting_for_input, waiting_for_approval, blocked_by_policy,
     paused — are TASK states (each emits a `task.*` event) owned by P4-002's `tasks.state`. Collapsing the two would
     make "which attempt failed, and why?" unanswerable (CDR-053 §2).
     `UNIQUE(task_id, attempt)` makes the claim atomic: two coordinators racing to start attempt 2 do not both proceed,
     and the loser is TOLD (`attempt_taken`) rather than given a duplicate or silently skipped to the next number.
     The FK to `tasks` is TENANT-PINNED (RI checks always bypass RLS), for which 0035 additively adds `(id, company_id)`
     UNIQUE to `tasks` — guarded, because 0029 may already have added it.
     LIVENESS IS A TIMESTAMP THE WORKER ADVANCES, NOT A BACKGROUND TIMER (§3-G4): `last_heartbeat_at` plus a bounded
     grace makes "is this run lost?" a pure comparison any healthy process can make. The process that would have held
     the timer is the one most likely to have died — which is the very failure this detects. `isRunLost` FAILS CLOSED:
     a running run with neither heartbeat nor start time reads as lost.
     CANCELLATION IS TWO OPERATIONS because the acceptance clause names two. A queued run has no worker to consult, so
     it is cancelled outright; a running run gets a DURABLE `stop_requested_at` and halts at its next safe point, which
     is what §4's "current tool call completes/aborts safely, then halt" requires. Found in review: when a queued run is
     picked up mid-cancellation the guard misses, and the honest answer is a safe-stop — never `already_terminal`,
     which would tell an owner their stop landed on finished work while the work carried on (§6-G9).
     A RUN IS NEVER STARTED FOR WORK THAT IS OVER (§6-G7/G8, both found in review): `startRun` reads through `findLive`,
     so a DELETED task — whose row survives, there being no DELETE grant — can never acquire an attempt; and
     `canStartRunForTask`, DERIVED from canon's own task transition table rather than restated, refuses `completed`,
     `failed`, `cancelled`, `draft` and `planned`.
     Grants are SELECT + INSERT + a COLUMN-scoped UPDATE of exactly the lifecycle columns — tenancy, task linkage and
     attempt number are immutable after insert. NO DELETE: a run is the record that an attempt happened.
     `failure_category` is a CLOSED set including canon's `worker_lost`, one-directionally CHECKed against the terminal
     state (the P5-009/P5-001c lesson) — a category, never provider or worker exception text.
     `task.completed` is DELIBERATELY NOT emitted here: canon requires `artifact_refs[]` on it ("no artifactless
     completion", TASK-005), and a run succeeding is not the same fact as a task completing. No new SECURITY DEFINER /
     role / BYPASSRLS. -->
<!-- IMPLEMENTED (ACBP-P5-003b; CDR-054; TOOL-002/003; WORK-005; NFR-006; ADR-012; trust-critical #4/#11): migration
     0036 adds `tool_calls` — company-owned, dual-keyed FORCE RLS. This is the 100%-coverage surface of THE enforcement
     chokepoint (`COMPONENT-CATALOG`: "Trusted — the enforcement chokepoint").
     REFUSED CALLS GET ROWS TOO, and that single requirement decides the table's two unusual features. TOOL-001's
     failure clause is "Unknown tools cannot be invoked; attempts are audited", and an attempt with no row is not
     audited. So `tool_id` carries NO FOREIGN KEY to `tool_definitions` — the commonest refusal IS a tool that is not
     registered, and an FK would make the required record impossible to write — and `risk_class`, `tool_version` and
     `external_effect` are SNAPSHOTS of the gate that was actually applied, because re-reading the registry later would
     misreport which definition a past call passed through.
     `external_effect` is a BOOLEAN rather than a list of class names inside the receipt CHECK. TOOL-002 requires that
     an external write cannot claim success without a stored receipt; expressing that as `risk_class in (...)` would
     hard-code the class names CDR-051 §0.1 flags as OPEN. The boolean keeps the constraint independent of the naming.
     BLANK IS MISSING (§4-G11, found in review): the receipt CHECK is `coalesce(btrim(receipt_ref),'') = ''`, not
     `is null` — a whitespace receipt would otherwise satisfy the constraint while evidencing nothing, which is exactly
     the hollow success the rule exists to prevent.
     `run_id` is NOT NULL with a tenant-pinned composite FK to `task_runs` (0036 additively adds
     `task_runs_id_company_uq`). A nullable, FK-less run reference would make "a tool call belonging to nothing" a
     legal state on the one surface that must account for everything — which is why P5-002 was sequenced first
     (CDR-052 §1).
     Idempotency is PER COMPANY via a PARTIAL unique on `(company_id, tool_id, idempotency_key)`, the CDR-049 §4
     reasoning; `ON CONFLICT` restates the predicate (42P10).
     Grants are SELECT + INSERT + a COLUMN-scoped UPDATE of exactly `(outcome, denial_reason, receipt_ref,
     updated_at)`: the digest, the class, the version, the external flag and the run linkage are immutable, so a call
     cannot be re-labelled with a gentler class, have its arguments swapped after the gate passed it, or be re-pointed
     at another run. NO DELETE — a call record is the evidence the call happened.
     DEFERRED, as sequencing rather than omission: `policy_eval_ref`/`approval_ref` (the engines are Phase 6's — a
     column that is always null pretending to be evidence is worse than none) and `error_category` (canon names it on
     `tool.call_failed` but enumerates no values for tools, and no tool that can fail exists yet). No new SECURITY
     DEFINER / role / BYPASSRLS. -->
<!-- IMPLEMENTED (ACBP-P5-004; CDR-056; WORK-001/006; ADR-012; trust-critical #4): migration 0038 adds TWO tables,
     because they answer to two different owners.
     `worker_definitions` is GLOBAL platform configuration, versioned `(worker_id, version)`, SELECT-only for the app
     role — the `tool_definitions` shape, for the same reason. Canon: workers are "versioned configuration + prompts
     over one shared execution runtime — not independent agent services", so a definition the product could rewrite at
     runtime would not be a control. It carries canon's own eleven fields (AI-AND-WORKER-ARCHITECTURE §2).
     THE ALLOWLIST LIVES HERE, which is the point of the ticket: CDR-054 §1-G3 and CDR-055 both deferred where the
     dispatcher's allowlist comes from, and trust-critical #4 says "allowlists versioned in worker definitions".
     THE MVP ZERO-EXTERNAL-ACTIONS BOUNDARY is enforced at RESOLUTION, not by a CHECK — `allowed_tools` is a text[]
     and the classes live in another table, and CHECKs cannot subquery. A definition reaching past
     `internal_reversible` may exist and can never be USED, which is what canon's "structural, not procedural" needs
     (§6-G8, found in review). An allowlist naming an unregistered tool fails it too.
     `company_worker_states` is TENANT data (dual-keyed FORCE RLS), because WORK-006 is per company. Keyed on
     `worker_id` WITHOUT a version: an owner pauses "the research worker", and pinning to a version would un-pause
     it the moment a new one was registered. Column-scoped UPDATE of the mutable state only, so a pause cannot be
     re-pointed at another worker or company after the fact.
     Budgets (`max_spend_micros`/`max_duration_ms`) carry IOQ-12's INTERIM values (CDR-056 §3) — columns rather than
     constants precisely so changing one is a data change, not a deploy. NOT owner-ratified.
     WORK-006's "disable during execution triggers safe-stop" is NOT met yet and is recorded as such (§6): nothing
     links a run to a worker until P5-005 stamps it, and a nullable unpopulated `worker_id` would be the FK-less hole
     CDR-049/CDR-052 refused. No new SECURITY DEFINER / role / BYPASSRLS. -->
| Task | C | task_id | traces to Milestone; has Runs, Dependencies | see WORKFLOW-STATE-MACHINES §4 | M (state) | — | With company | task.* | MVP |
| Task dependency | C | (task_id, depends_on_task_id) | Task↔Task | with tasks | I | — | With tasks | — | MVP |
| Task deletion | C | deletion_id, UNIQUE(task_id) | one per deleted Task; records state at delete | recorded (terminal) | **I** | optional owner reason (never in audit) | With tasks | task.deleted | MVP |
| Task run | C | run_id, task_id, attempt | has Worker run, Tool calls, Usage events | queued→running→succeeded/failed/cancelled | A | — | With company | run trace | MVP |
| Job checkpoint | C | checkpoint_id, UNIQUE(job_id, step_name) | records that a job STEP completed | recorded (terminal) | **I** | step output: references, never secrets | With company | - | MVP |
| Durable job | C | job_id, UNIQUE(company_id, idempotency_key) partial | the unit the runner picks up | queued→running→succeeded/failed/dead_letter/cancelled | M (state, attempts) | references only, never secrets | With company | job.enqueued | MVP |
| Worker definition | G | worker_id, version | allowlists Tools; referenced by runs | draft→active→retired | V | — | Permanent | version changes | MVP |
| Worker run | C | worker_run_id | 1:1 task run execution segment | started→completed/failed | A | — | With company | worker.* | MVP |
| Tool definition | G | tool_id, version | risk class; referenced by allowlists | active→retired | V | — | Permanent | class changes audited | MVP |
| Tool call | C | tool_call_id, idempotency_key | belongs to run; links policy eval + approval | see state machine §6 | A | args digest (not raw sensitive args) | With company | 100% recorded (TOOL-002) | MVP |
| Policy | C (+G defaults) | policy_id, version | evaluated per action | active→superseded | V | limits config | Permanent versions | policy changes audited | MVP |
| Policy evaluation | C | evaluation_id | links tool call/approval; policy version | recorded (terminal) | **A/I** | — | ≥ audit retention | POL-006 | MVP |
| Approval request | C | approval_id, payload_hash | links action, policy eval; consumed by Tool call | see state machine §5 | M (state only) | normalized payload | ≥ audit retention | approval.* | MVP |
| Approval decision | C | decision on approval_id | actor, timestamp, choice | recorded | **I** | — | ≥ audit retention | approval.approved/rejected | MVP |
| Integration | C | integration_id | has Credential reference | connected→degraded→revoked | M | scopes, account identity | Revocation record permanent | integration.* | Post-MVP |
| Credential reference | C/G | credential_ref_id (opaque) | points into secret manager — **value never in DB** | active→rotated→revoked | M | none in DB (by design) | Reference history permanent | access audited | MVP (platform keys) |
| Memory item | C | memory_item_id, type | source link (provenance §3); dependents | see Fact row | V | business content | User-deletable | MEM-003 | MVP |
| Generated document | C | document_id, version | produced by Task run; content in object storage | draft→final→superseded | V | business content | With company; exportable | provenance (TASK-005) | MVP |
| Generated artifact | C | artifact_id | non-document outputs (future: code bundles) | created→exported/deleted | I | — | With company | export audits | Post-MVP |
| Deployment | C | deployment_id, version | future: generated-app deploys | future | I | — | Future | full audit | Future |
| Activity event | C | event_id | projection feeding the feed | recorded | **A** | redacted content | With company | is activity | MVP |
| Audit event | C/A/G | audit_id, correlation_id | references any object | recorded | **A** (immutable, invariant 11) | actor, context (redacted) | AOQ retention (≥ product data) | is the audit | MVP |
| Usage event | C | usage_event_id | links run/tool call/model call | recorded | **A** (invariant 9) | — | ≥ billing retention | reconciliation | MVP |
<!-- EXTENDED (ACBP-P5-009; CDR-047; NFR-019): migration 0030 adds `usage_events.fallback_reason` — ALTER-only,
     nullable, no grant change (the table keeps its append-only SELECT+INSERT, invariant 9).
     `fallback_used` already answered WHETHER a call fell over to the secondary provider; canon asks for the REASON,
     and the difference is operational: an engineer looking at a degraded answer needs to know the primary TIMED OUT
     versus was RATE-LIMITED versus was UNAVAILABLE, because those imply different responses. A boolean collapses
     them into "something happened". The value is the NORMALIZED `ModelErrorCategory` — never raw provider text,
     which would put an unbounded vendor string into a ledger retained for the billing lifetime — and it is the
     PRIMARY's terminal category, captured at the moment the fallover decision is taken (afterwards the run describes
     the secondary, so the trigger would be unrecoverable). When BOTH providers fail, `fallback_reason` and
     `error_category` therefore hold DIFFERENT values: why we left, and how it finally died.
     The CHECK is deliberately ONE-DIRECTIONAL — a reason never appears without a fallover (the contradictory state,
     which would read as authoritative), but a fallover without a reason is permitted. The symmetric constraint could
     not be added: rows written before 0030 carry `fallback_used = true` and no reason, so `ADD CONSTRAINT` would
     have passed in CI (schema rebuilt each run) and failed on the first real deployment carrying history. The
     forward guarantee is the gateway's, pinned by its own tests. -->
<!-- IMPLEMENTED for MODEL CALLS (ACBP-P2-003; CDR-026 §6): table `usage_events` (migration 0017) — company-owned,
     dual-keyed FORCE RLS, APPEND-ONLY (SELECT+INSERT grants only; NO update/delete grant, NO update policy —
     invariant 9). v1 `kind = 'model_call'`; `estimated_cost_micros` is integer micro-units (never a float);
     `error_category` present iff `outcome='error'` (the seven-value taxonomy). Tool/worker usage kinds + the account
     usage rollup arrive with their tickets (P5-004/P5-014/P6-009). -->

| Account usage rollup | A | (account_id, period) | aggregates usage events across companies | maintained | M (derived; rebuildable from ledger) | — | ≥ billing retention | reconciliation | MVP (ADR-003) |
| Credit transaction | A/C | credit_txn_id | grants/spends/refunds/expiry; corrections reference originals | recorded | **A** (invariant 10) | — | ≥ billing retention | BILL-002 | MVP |
| Notification | C/A | notification_id | references source event | queued→delivered/failed | M (state) | — | Short (config) | delivery log | Post-MVP |
| Emergency-stop state | C/A/G | (scope, scope_id) | checked by dispatcher | active→cleared | M | — | History permanent | emergency_stop.* | MVP |

## 2. Tenant isolation (ADR-007)

1. **Immutable ownership:** every C-row carries `company_id` (and `account_id` where relevant) set at insert, with no update path (invariant 1).
2. **Authorization queries always tenant-scoped:** repository layer requires tenant context as a construction parameter — queries without it do not compile/execute (invariant 2: context derives from session membership, never client input).
3. **Second layer:** database row-level security policies keyed to a per-connection tenant setting — an app-layer bug alone cannot cross tenants. Row-level enforcement is **recommended where practical**; the *requirement* is two independent layers, vendor choice is separate (AOQ-02).
4. **Cross-company access tests:** adversarial suite (ID substitution, forged membership, IDOR probes) runs in CI; 100% pass is launch gate 1.
5. **Administrative access:** separate authz surface; reason capture; audited; no RLS bypass except break-glass role with alarmed usage (§SECURITY).
6. **Background workers:** jobs carry explicit tenant context (invariant 3); worker DB sessions set the tenant before any query.
7. **Tool calls:** dispatcher stamps tenant onto every call record; tools receive scoped context only.
8. **Storage paths:** object keys prefixed `company/{company_id}/…`; signed URLs scoped to prefix.
9. **Cache keys:** mandatory tenant prefix in the cache-key builder (single utility, lint-enforced).
10. **Log redaction:** tenant identifiers appear in logs only as opaque IDs; cross-tenant log access is role-controlled (ADR-017).
11. **Export ownership:** export jobs verify requester's membership of the exact company; archives contain only that company's prefix.

## 3. Facts vs assumptions — provenance model

Memory items are **typed** (MEM-001): `user_fact` · `user_preference` · `constraint` · `ai_assumption` · `research_finding` · `approved_decision` · `measured_outcome` · `correction`. A generated claim can never be stored as `user_fact` (type is set by source path, not by content).

Provenance fields on every memory item and generated-claim reference:

| Field | Meaning |
|---|---|
| source_type | interview_answer · user_edit · task_result · model_generation · imported_document · system_measurement |
| source_ref | ID of the originating answer/run/document (resolvable link — MEM-003) |
| confidence | numeric + class per PRD §7 bands |
| created_by | actor (user id / worker id + version) |
| confirmed_by | user actor when confirmation state advances |
| confirmation_state | proposed → accepted → validated / invalidated (UNDER-004) |
| superseded_by | forward pointer on correction/replacement (never destructive overwrite) |

Instruction precedence (MEM-004): explicit user instructions are stored as `user_fact`/`constraint` with `confirmed_by` set; the context assembler ranks confirmed user items above AI assumptions and, on conflict, emits a question event instead of silently preferring memory (invariant-adjacent runtime check, tested via seeded conflicts).
<!-- IMPLEMENTED (ACBP-P2-007; CDR-032): `assembleContext` (@acbp/core) builds the model context from the company's
     current typed memory — provenance-ranked (confirmed user > accepted assumption > research; `invalidated` excluded),
     with the reviewed secret blocklist redacting any secret-shaped span (invariant 12/NFR-018). MEM-004 conflict =
     a confirmed user item + an `ai_assumption` sharing one `source_ref` (same subject): assembly WITHHOLDS both from the
     context and surfaces them as an open question (`context.conflict_flagged` audited, outcome `blocked`) — NEVER
     silently rank-resolved. Model-free (assembly builds the prompt; the live provider is CDR-026 §0). Deterministic
     same-subject detection; arbitrary cross-subject SEMANTIC contradiction needs the model (P2-005) and is deferred
     (would require persisting P2-005's verdicts at write time). Reuses `memory:read`; no new table. -->

