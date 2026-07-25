# CDR-037 — Selection, edit, combine, reject, phase-limited approval (ACBP-P3-004)

**Status:** Accepted (autonomous lead, standing authorization). **Requirements:** STRAT-003 (five owner controls:
select / edit / combine / reject / request-another; "a combined option is re-rendered in the standard format for
confirmation"; "rejection of all options routes back to understanding review with captured reasons"), STRAT-005
(phase-limited approval — "approve only the first phase of a strategy rather than the whole plan"). **Governing ADRs:**
ADR-011, ADR-015 (decision records — P3-005), ADR-009 (approval-boundary principle, by analogy). **Architecture:** PRD
J-08 (owner actor), diagrams/05 (`choice` node), WORKFLOW-STATE-MACHINES (`ready_for_review → selected/rejected`),
EVENT-CATALOG (`strategy.selected`), IMPLEMENTATION-ROADMAP §Phase 3. **Depends on:** P3-003 (Done). **No live model**
(edit/combine is user-supplied — see §6-G3; FakeModelProvider not needed), **no owner gate.**

The owner's terminal DECISION act over a confirmed generation's distinct options. P3-004 records the selection (or
reject, or an edited/combined option, with an optional phase-scope flag) and audits it; it does NOT write the immutable
Decision record (P3-005), does NOT unlock/generate planning (P4-001), and does NOT enforce phase-limited task generation
(P4-003). All state is append-only (the strategy tables are immutable).

## 1. The five controls (canon; diagrams/05 + STRAT-003)
| Control | Effect | Actor |
|---|---|---|
| **select** | choose exactly one existing distinct option as the direction | **owner-only** |
| **edit** | modify an option's 16 fields → a re-rendered 16-field object for confirmation | **owner-only** |
| **combine** | merge ≥2 options into one new 16-field object, re-rendered for confirmation | **owner-only** |
| **reject** | reject all options with captured reasons (routes to understanding review) | **owner-only** |
| **request another** | ask the model for another option | **owner|viewer** — REUSES `strategy:generate` (P3-001); NOT in scope here |

## 2. Storage — migration 0024 (additive; one table)
`strategy_options`/`strategy_generations`/`strategy_recommendations` are IMMUTABLE (no UPDATE grant), so a "selected"
state is realized APPEND-ONLY (the P2-009 event-log precedent), not a column update. Add ONE company-owned, dual-keyed
FORCE-RLS, IMMUTABLE (`I`) table `strategy_selections` (SELECT+INSERT only), migration 0024 (the 0022/0023 pattern):
`id`, `account_id`, `company_id`, `generation_id` (FK strategy_generations cascade), `mode` (text CHECK
`select|edit|combine|reject`), `selected_option_id` (nullable FK — for `select`/`edit`; the COMPOSITE `(id,
generation_id)` FK from CDR-036 enforces same-generation), `chosen_fields` (nullable jsonb — the edited/combined
validated 16-field object, for `edit`/`combine`), `phase_scope` (nullable text CHECK `first_phase|whole_plan`),
`reasons` (nullable text, bounded — captured reasons for `reject`), `created_by_user_id`, `created_at`. Append-only
(a re-decision is a new row; latest-wins on read). Shape CHECKs (§3). No new SECURITY DEFINER / role / BYPASSRLS.

## 3. Per-mode validation (deny-by-default)
- `select`: `selected_option_id` REQUIRED (an option of THIS generation); `chosen_fields`/`reasons` NULL.
- `edit`: `chosen_fields` REQUIRED (a valid 16-field object per the P3-001 `isCompleteOptionFields` contract);
  `selected_option_id` OPTIONAL (the base option edited); `reasons` NULL.
- `combine`: `chosen_fields` REQUIRED (valid 16-field object); `selected_option_id` NULL; `reasons` NULL.
- `reject`: `reasons` REQUIRED (bounded); `selected_option_id`/`chosen_fields`/`phase_scope` NULL.
- `phase_scope` is meaningful only for select/edit/combine; a DB CHECK ties the shape to the mode.

## 4. Audit + authz
- **Audit:** `strategy.selected` (registered by P3-004 per EVENT-CATALOG:80). Subject = the selection id; bounded
  metadata `{mode, phase_scope}` (NEVER option content / chosen_fields / reasons text). Written in the SAME transaction
  as the selection insert (audit-or-nothing). The EVENT-CATALOG mode enum (select/edit/combine) is EXTENDED to include
  `reject` — one event for the owner's terminal decision act (a superset, reversible; reconciles WORKFLOW's separate
  `rejected` transition without registering a second event). `decision.recorded` is P3-005's.
- **Authz:** ONE new owner-only action `strategy:select` (the `understanding:confirm` owner-only precedent) covering
  select/edit/combine/reject (all owner decision acts). Reads reuse `strategy:read`. request-another reuses
  `strategy:generate`. DISTINCT closed action, deny-by-default.

## 5. Phase-limited approval — FLAGGING only (owner-accepted deferral)
IMPLEMENTATION-ROADMAP §Phase 3 (line 89) explicitly: **"Deferred: phase-limited execution enforcement beyond FLAGGING
(full effect visible in P4 planning boundary)."** REQUIREMENT-TO-TICKET-TRACEABILITY maps STRAT-005 to BOTH P3-004 AND
P4-003. So P3-004 records a `phase_scope` INTENT MARKER (value set derived from STRAT-005's own wording: `first_phase`
= "approve only the first phase", `whole_plan` = "the whole plan") on the selection + stamps it into `strategy.selected`,
and surfaces it. The concrete "generates tasks solely for that phase / violations blocked server-side" ENFORCEMENT is
P4-003 (the planning boundary), which does not exist yet. P3-004 guarantees only that the marker is recorded immutably +
surfaced. (No "phase" decomposition exists at selection time — the roadmap is generated AFTER the decision.)

## 6. Ratified design decisions (canon-derived; documented, not guessed)
- **G1 — P3-004 vs P3-005 boundary:** P3-004 writes the SELECTION only (`strategy.selected`); the immutable audit-grade
  Decision record (`decision.recorded`, STRAT-006) is P3-005. The backlog splits them (P3-005 deps P3-004), EVENT-CATALOG
  assigns the events accordingly, and P4-001 planning gates on P3-005 — so PRD J-08 "decision recorded before any
  planning" holds (planning deps P3-005). The WORKFLOW "selected precondition = decision-record write" is reconciled as:
  the decision record HARDENS on top of the recorded selection in P3-005; selection itself is completable in P3-004.
- **G2 — phase_scope value set:** `{first_phase, whole_plan}` — taken verbatim from STRAT-005 ("the first phase" vs "the
  whole plan"), not invented.
- **G3 — edit/combine authorship:** the edited/combined option is a USER-SUPPLIED 16-field object, re-validated by the
  existing P3-001 contract (no model call, no metering) — the safer reversible reading of "re-rendered in the standard
  format for confirmation." If the owner later wants a model-synthesized merge, that is an additive enhancement.
- **G4 — reject reasons:** ONE overall bounded `reasons` field (STRAT-003 "rejection of all options … with captured
  reasons" — canon does not specify per-option). Reject-all RECORDS the rejection here; the "route back to understanding
  review" is a flow/UI affordance over P2-009's existing owner-only correction path — P3-004 does NOT mutate the
  understanding.

## 7. Slice plan
1. CDR + selection contracts (modes, phase-scope, per-mode parse/validate reusing isCompleteOptionFields, DTO) +
   `strategy.selected` audit + `strategy:select` authz + unit tests.
2. Migration 0024 (strategy_selections) + repo/schema + every reset list/catalog + real-PG RLS/privilege/lifecycle.
3. Core `recordStrategyDecision` (owner-only; per-mode validate; persist selection + strategy.selected in one tx,
   audit-or-nothing; NO decision record, NO planning unlock) + surface the latest selection on the read + real-PG.
4. Docs + review + finalize.

## 8. Out of scope / deferred
The immutable Decision record + `decision.recorded` (P3-005, STRAT-006); planning goals/roadmap/milestones/tasks
(P4-001); the concrete phase-limited task-generation enforcement (P4-003); mutating the understanding on reject
(P2-009's path); the selection/approval UI + HTTP route (deferred, CDR-026 §0); a live model for edit/combine. No
migration 0025.
