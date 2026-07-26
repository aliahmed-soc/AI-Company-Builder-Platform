# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active

_Newest first. When a ticket merges, a one-line **DONE** entry is added ABOVE its working block; the working block is
kept as historical detail (what was built, which commits, which gates). **The DONE line is the authoritative status** —
a "CORE DONE / FINALIZING" block below a DONE line for the same ticket is history, not an open item. Only the topmost
ticket without a DONE line above it is genuinely in flight._

- **ACBP-P4-003 task generation + chat steering — CORE DONE / IN REVIEW (4th autonomous window).**
  Branch `p4-003-task-generation` (from main `00a580d`, after P4-001 merged), draft PR **#40**, CDR-040.
  `generateTasks` (PLAN-001: 3+ prioritized, typed, milestone-traced tasks or an honest partial) and
  `steerTaskPlanning` (PLAN-002: THREE distinct successful answers — tasks + interpreted intent, a clarifying
  question, or an honest refusal; none reported as a failure). **The preview is the `draft` state**, canon-native per
  diagrams/06 + WORKFLOW §4 + CDR-033 §4 (not on the board, no audit); confirming is the existing `planTask`
  transition, so NO new audit event. **STRAT-005 is enforced here** — the boundary CDR-037 §5 recorded as a flag and
  deferred to this ticket: only the approved phase's milestones are shown to the model, and every ordinal is
  re-resolved server-side at persist so an out-of-scope task is refused, never re-pointed. Gate reuses
  `classifyPlanningGate` + requires a current roadmap; both re-verified in the persist tx (`stale_decision` /
  `stale_roadmap`). Migration **0027** is ALTER-only: `tasks.task_type` (closed CHECK, nullable) + `tasks.priority`
  (integer RANK, no invented scale) — both INSERT-ONLY, the `(state, updated_at)` grant untouched.
  Commits: contracts `7fe3c4b` → migration 0027 `65e83be` → both core use cases `8ebbb64`.
  Local: full unit 1055 passed / 0 failed; planning real-PG 38 discovered (local PG down → **skipped, not green**;
  hosted CI is the evidence); recursive typecheck/lint/secrets/boundaries clean; 0 mojibake.
  Independent review next, then exact-head CI zero-skip → squash-merge → exact-main CI zero-skip → delete branch.
  Migrations end **0027**.
- **ACBP-P4-001 goals, roadmap and milestones — DONE** (squash `00a580d`, PR #39; exact-main CI green zero-skip 1755/1755; branch deleted). Phase 4 2/7.
- **ACBP-P4-001 goals, roadmap and milestones — CORE DONE / IN REVIEW (3rd 8-hour autonomous window).**
  Branch `p4-001-goals-roadmap-milestones` (from main `766b674`, after P3-005 merged), draft PR **#39**, CDR-039.
  Turns the DECIDED strategy into a plan (ROAD-001) that is versioned and editable (ROAD-002). The planning GATE is the
  company's LATEST decision being NON-reject (`decisions.mode <> 'reject'`; CDR-039 §7-G1) — STRAT-006 records
  rejections too, so "a decision exists" would have unlocked planning off a rejection; re-verified inside the persist
  tx → `stale_decision`. Migration **0026**: `roadmaps` (versioned append-only, UNIQUE(company_id, version), supersedes
  chain, edit_reason shape CHECK), `goals` + `milestones` (immutable, ordinal-sequenced, composite same-version goal
  FK), `task_review_flags`; plus the additive `tasks.milestone_id → milestones` FK that closes the P4-002 review NOTE
  and makes ROAD-001's "tasks trace to milestones" enforceable. `generateRoadmap` (metered by the gateway; partial
  honesty — failure/malformed/empty persists NOTHING, only a model-flagged output is `partial`) and `editRoadmap`
  (OWNER-ONLY, version-guarded, new version + affected-OPEN-task flags + `roadmap.edited` in ONE tx, so a failure
  cannot lose history). NO task generation (P4-003 owns PLAN-001), no dates (ADR-019). Ratified: CDR-039 §7 G1–G8.
  Commits: contracts `0cf8a15` → migration 0026 `b517dee` → ROAD-001 core `593051a` → ROAD-002 core `7c2cbad`.
  Local: full unit 1036 passed / 0 failed; planning real-PG 11 + roadmap-generation 12 + roadmap-edit 7 discovered
  (local PG down → skipped; hosted CI is the evidence); recursive typecheck/lint/secrets/boundaries clean; 0 mojibake.
  Independent review next, then exact-head CI zero-skip → squash-merge → exact-main CI zero-skip → delete branch.
  Migrations end **0026**.
- **ACBP-P3-005 immutable decision records — DONE** (squash `766b674`, PR #38; exact-main CI green zero-skip 1695/1695; branch deleted). Phase 3 5/7.
- **ACBP-P3-005 immutable decision records — CORE DONE / IN REVIEW (3rd 8-hour autonomous window).**
  Branch `p3-005-decision-records` (from main `50bbaa8`, after P3-004 merged), draft PR **#38**, CDR-038.
  The STRAT-006 audit-grade record: links the CONFIRMED understanding version, the options CONSIDERED (via the
  generation), the SELECTION it hardens (P3-004), and an OPTIONAL bounded owner-supplied rationale. `recordDecision` is
  OWNER-ONLY (`decision:record`) and writes ONE immutable `decisions` row + `decision.recorded` in ONE transaction —
  that audit-or-nothing pair IS the STRAT-006 failure mode ("failed record writes block the transition; a decision is
  not silently unrecorded"). Migration **0025** `decisions` (immutable/append-only, dual-keyed FORCE RLS, SELECT+INSERT,
  composite FK (selection_id, generation_id) so a cross-generation decision is impossible, optional bounded rationale
  CHECK) + an additive `UNIQUE(id, generation_id)` on `strategy_selections`. `getLatestStrategyGeneration` surfaces the
  latest decision. Records only — NO planning unlock (P4-001 gates on the decision separately). Ratified (CDR-038 §6):
  G1 a REJECT selection also gets a record (STRAT-006 says "selection/edit/rejection" explicitly; planning-unlock keys
  off a non-reject decision); G2 rationale optional; G3 references (not re-captures) the selection; G4 options-considered
  = the generation link + a scalar audit count; G5 append-only latest-wins. Commits: CDR+contracts `4896de0` →
  migration 0025 `bb65087` → core `e1c4a6d`. Local: full unit 1018 passed / 0 failed; decisions real-PG 9 + decision-record
  real-PG 9 discovered (local PG down → skipped; hosted CI is the evidence); recursive typecheck/lint/secrets/boundaries
  clean. Independent review next, then exact-head CI zero-skip → squash-merge → exact-main CI → delete branch.
  Migrations end **0025**.
- **ACBP-P3-004 selection / edit / combine / phase-limited approval — DONE** (squash `50bbaa8`, PR #36; exact-main CI green zero-skip 1665/1665; branch deleted). Phase 3 4/7.
- **ACBP-P3-004 selection / edit / combine / phase-limited approval — CORE DONE / FINALIZING (3rd 8-hour autonomous window).**
  Branch `p3-004-selection-and-approval` (from main `c645e8e`, after the `.gitattributes` chore), draft PR **#36**, CDR-037.
  Records the OWNER's decision over a generation in a closed `mode` {select, edit, combine, reject} + FLAGGING-only
  `phase_scope` {first_phase, whole_plan} (STRAT-003/005). `validateStrategyDecision` is deny-by-default per-mode (select →
  in-range ordinal; edit/combine → an owner-supplied 16-field object reusing `isCompleteOptionFields`, NO model call;
  reject → non-blank bounded reasons). `recordStrategyDecision` (OWNER-ONLY `strategy:select`) persists ONE immutable
  selection + the `strategy.selected` audit (metadata {mode} + phase_scope when set — never content) in ONE tx
  (audit-or-nothing); `getLatestStrategyGeneration` surfaces the latest selection. Records a SELECTION only — NO decision
  record (P3-005), NO planning unlock (the P4 boundary; phase-limited approval is an owner-accepted Phase-3 deferral).
  Migration **0024** `strategy_selections` (immutable/append-only, dual-keyed FORCE RLS, SELECT+INSERT; composite FK
  same-generation; mode/phase_scope/shape CHECKs) + every reset list/catalog surface. Ratified (CDR-037 §6): G1
  selection-only; G2 phase_scope value set; G3 edit/combine owner-supplied; G4 reject single reasons field. Commits:
  contracts `c4d57c7` → migration+repo `806606b` → core `5ec73b5`. Local: contracts strategy unit + core strategy/audit
  33 unit; strategy-selection real-PG 11 + strategy_selections migration 10 discovered (local PG down → skipped, hosted CI
  is the evidence); full recursive typecheck/lint/secrets/boundaries clean. Independent review next.
  Finalization → backlog Done → exact-head CI zero-skip → squash-merge "ACBP-P3-004: Selection, edit, combine,
  phase-limited approval" → exact-main CI zero-skip → delete branch. Migrations end **0024**.
- **ACBP-P3-003 comparison + AI recommendation — DONE** (squash `55438de`, PR #35; exact-main CI green zero-skip; branch deleted). Phase 3 3/7.
- **ACBP-P3-003 comparison + AI recommendation — CORE DONE / FINALIZING (2nd 8-hour autonomous window).**
  Branch `p3-003-comparison-recommendation` (from main `a8ace01`, after P3-002 merged), draft PR **#35**, CDR-036.
  Adds the OPTIONAL ADVISORY recommendation over a generation's distinct options (STRAT-004). Canon-derived design (via
  discovery subagent): a MODEL call (FakeModelProvider; live deferred CDR-026 §0) recommends ONE option with rationale +
  sensitivities, or honestly abstains. Two guards: NEVER auto-selects (structural — no selection/decision/state change;
  selection is P3-004) + no defensible rationale → no recommendation (deny-by-default: one option-in-range + non-blank
  rationale + sensitivities, else abstain → nothing persisted, `recommendation: null`). `recommendStrategy` +
  `getLatestStrategyGeneration` surfaces the latest recommendation. Migration **0023** `strategy_recommendations`
  (immutable/append-only, dual-keyed FORCE RLS, SELECT+INSERT, FK generation+option). `strategy:recommend` authz
  (owner|viewer). NO new audit event (changes no state; only the gateway usage event). Ratified gaps: G-1 structural
  "defensible" bar; G-2 model-metered; G-3 owner|viewer. Commits: CDR+contracts `35b7663` → migration 0023 `eb4274f` →
  core `2875eb2`. Local: contracts strategy 25 unit; recommendation real-PG 7/7 + migration 6/6; strategy-generation
  real-PG 12/12; full recursive typecheck/lint/secrets/boundaries clean; unit 1004. Independent review in progress.
  Finalization → backlog Done → exact-head CI → squash-merge "ACBP-P3-003: Comparison and AI recommendation" →
  exact-main CI → delete branch. Migrations end **0023**.
- **ACBP-P3-002 distinctness check — DONE** (squash `a8ace01`, PR #34; exact-main CI green zero-skip; branch deleted).
  Phase 3 2/7.
- **ACBP-P3-002 distinctness check — CORE DONE / FINALIZING (2nd 8-hour autonomous window).**
  Branch `p3-002-distinctness-check` (from main `450c768`, after P3-001 merged), draft PR **#34**, CDR-035. Adds the
  STRAT-001 similarity check P3-001 deferred (it wrote `similarity_check_result = 'pending'`). Canon is explicit
  (searched thoroughly — no product-semantics gap): two options are genuinely distinct IFF they differ on ≥1 of
  {customer, offer, business_model} (PRD J-07 + REQUIREMENTS STRAT-001); the check rejects near-duplicates ("same plan,
  different title"); fewer than 3 distinct → stated honestly with reasons. Deterministic, model-free (AI-AND-WORKER §1);
  no metering, no owner gate. Contract `dedupeByDistinctness` (normalized 3-axis key, NUL-separated to avoid boundary
  collisions; keeps the first representative per group; `distinct`/`insufficient_distinct`). Wired into
  `generateStrategyOptions`: persists ONLY the distinct set (near-duplicates rejected, not stored), records the real
  verdict (never `pending` again), derives status from the distinct count, and writes an honest fewer-reason on
  collapse. NO schema/migration change (the existing `similarity_check_result` column + P3-001 status↔option_count CHECK
  hold since option_count = distinct count); no new audit/authz. Commits: CDR+contracts `f563d14` → core `cba98cc` →
  NUL-escape source cleanup `faf4c91`. Local: contracts distinctness 8/8 + strategy 19 unit; core strategy real-PG
  11/11 (incl. near-duplicate rejection adversarial); full recursive typecheck/lint/secrets/boundaries clean; unit 995.
  Independent review in progress. Finalization → backlog Done → exact-head CI → squash-merge "ACBP-P3-002: Distinctness
  check" → exact-main CI → delete branch. Migrations stay **0022**.
- **ACBP-P3-001 strategy option generation — DONE** (squash `450c768`, PR #33; exact-main CI green zero-skip; branch
  deleted). Phase 3 1/7.
- **ACBP-P3-001 strategy option generation — CORE DONE / FINALIZING (8-hour autonomous window).**
  Branch `p3-001-strategy-option-generation` (from main `08e7d6a`, after P4-002 merged), draft PR **#33**, CDR-034.
  Generates strategy options from the CONFIRMED understanding version (STRAT-001/002). Corrects an earlier mistaken
  deferral: the 16-field option standard IS canon (PRD §11.3 line 302, locked by the backlog's "All 16 fields"
  acceptance) — verified directly, so P3-001 is unblocked (no owner gate; deterministic FakeModelProvider, live provider
  deferred CDR-026 §0). Implements only the `gen` node: `generateStrategyOptions` (gated on owner-confirmed understanding
  — blocked pre-confirm; gateway → validate 16-field/ADR-019 no-fake-precision `"unknown"` labeling → honest
  fewer-than-three → persist ONE immutable generation + options + `strategy.generated` audit in one tx, audit-or-nothing;
  metered) + `getLatestStrategyGeneration` read. The rigorous cosmetic-variant distinctness engine is P3-002
  (`similarity_check_result` = `pending`); comparison/selection/decision are P3-003/004/005. Migration **0022**
  (`strategy_generations` + `strategy_options` — immutable `I`, dual-keyed FORCE RLS, SELECT+INSERT). Authz
  `strategy:generate`/`:read` (owner|viewer). No new SECURITY DEFINER / role / BYPASSRLS. Commits: CDR+contracts
  `f85263d` → migration 0022 `932c399` → core `2c9c22d`. Local real-PG green (zero skips): strategy migration 6, core
  use cases 8, catalog + database existence re-verified; full recursive typecheck+lint+secrets+boundaries clean; full
  unit 988. Independent security/scope review in progress. Finalization → backlog Done → exact-head CI → squash-merge
  "ACBP-P3-001: Strategy option generation" → exact-main CI → delete branch. Migrations end **0022**.
- **ACBP-P4-002 task model + state machine — DONE** (squash `08e7d6a`, PR #32; exact-main CI green zero-skip; branch
  deleted). Established the server-enforced task state machine + tasks/task_dependencies (migration 0021). Phase 4 1/7.
- **ACBP-P4-002 task model + state machine — CORE DONE / FINALIZING (8-hour autonomous window).**
  Branch `p4-002-task-state-machine` (from main `68f99e4`), draft PR **#32**, CDR-033. Establishes the Task entity + the
  SERVER-ENFORCED state machine (TASK-001; ADR-008; WORKFLOW §4): the full closed 11-state set + legal-transition map are
  defined day-one (every illegal transition rejected + 100% table conformance test), but only the effect-free
  pre-execution transitions are EXECUTED — `createTask` (mints `draft`, no audit), `planTask` (server-enforced
  `draft→planned`, `task.created` audited in-tx, audit-or-nothing; illegal transitions rejected with no audit),
  `addTaskDependency` (immutable same-company edge; self/duplicate/unknown refused), `getTask`/`listTasks` (redacted
  reads). Execution transitions (credit reservation on planned→queued, worker runs, holds, terminals) are DEFINED-legal
  but their EFFECTS DEFERRED to P5/P6 — the `interview.ts` precedent. Migration **0021** (`tasks` mutable-with-audit
  `M`: SELECT+INSERT + column-scoped UPDATE(state,updated_at); `task_dependencies` append-only `I`, UNIQUE + no-self-dep;
  both dual-keyed FORCE RLS). Authz `task:create`/`task:read` (owner|viewer). No new SECURITY DEFINER / role / BYPASSRLS.
  Commits: CDR+contracts+authz+audit `780ce94` → migration 0021 `9916ffd` → core `eeddf65`. Local real-PG green (zero
  skips): tasks migration 7, core use cases 10, catalog + database existence re-verified; full recursive typecheck +
  lint + secrets + boundaries clean. Independent security/scope review in progress. Finalization → backlog Done →
  exact-head CI → squash-merge "ACBP-P4-002: Task model and state machine" → exact-main CI → delete branch. Migrations
  end **0021**.
- **ACBP-P2-007 context assembly — CORE DONE / FINALIZING (autonomous window; trust-critical).**
  Branch `p2-007-context-assembly` (from main `a6dff28`), draft PR **#31**, CDR-032. Owner ratified the MEM-004 conflict
  semantics (genuine contradiction → open question, never silent rank-resolve; reuse P2-005). Core `assembleContext`
  (commit `381c2bd`): read current memory (`memory:read`) → provenance-rank → detect MEM-004 conflicts (confirmed-user +
  ai_assumption on same `source_ref`, deterministic/model-free) → WITHHOLD both + audit `context.conflict_flagged`
  in-tx → redact secrets → return `contextParts` + conflicts. NO model call; no migration; no new authz. Real-PG
  integration 6/6; full unit 958; all gates clean. P2-005 gap documented (model-based/answer-time; semantic detection
  deferred). Backlog **Done**. Independent core review **PASS** (no Blocker/Crit/High; last-gate-before-model bar met;
  L1 fail-closed enum guard fixed; L2 informational) — P2-007-REVIEW-COVERAGE.md. Finalization records next → exact-head
  CI → squash-merge "ACBP-P2-007: Context assembly" → exact-main CI → delete branch → Phase 2 11/12. The last non-gated Phase-2 ticket
  (P2-011 is OWNER-GATED on the live-model eval). **Deliberately sliced (trust-critical):** this window shipped only
  the PURE, security-critical logic — `rankMemoryForContext`/`provenanceTier` (confirmed user > accepted assumptions >
  research; invalidated excluded; MEM-004 ordering) + the `SECRET_PATTERNS`/`redactSecrets`/`containsSecret` blocklist
  (fail-closed, defense-in-depth; a seeded secret never reaches the prompt — invariant 12/NFR-018). Commit `8b01212`;
  20 unit tests (11 synthetic secret shapes redacted + benign-text no-false-positives + ranking order); synthetic
  fixtures allowlisted for the secret scanner (reviewed FPs, no real creds); recursive typecheck/lint/secrets/encoding/
  boundaries all clean. **NOT finalized** — the follow-up **core slice** (next window) owns: `assembleContext` (scoped
  memory read + MEM-004 conflict DETECTION→question emission — under-specified, designed with care in core), real-PG
  integration (seeded-secret-blocked E2E, seeded-conflict-surfaces-question, cross-company isolation), an independent
  **security review** (trust-critical), and finalization. No migration, no new authz (reuses `memory:read`), no live
  provider. CDR-032 §4 has the slice plan. PR #10 untouched.
- **ACBP-P2-012 Slice B integration: confirmed understanding — DONE (merged squash `a6dff28`, PR #30; exact-main CI green 136/136 zero-skip).**
  Independent 8-dimension adversarial review **CLEAN** (no Blocker/Critical/High; 6 Low — 4 fixed:
  step-3 falsifiability, step-12 seed-audit decoupling, demo truncation guard, CDR wording; 2 accepted with rationale —
  P2-012-REVIEW-COVERAGE.md). Finalization records committed; sequence = exact-head CI (zero-skip) → PR #30 ready →
  verify MERGEABLE + recheck main/PR#10 → squash-merge "ACBP-P2-012: Slice B integration: confirmed understanding"
  (no Co-Authored-By) → exact-main CI → FF main → delete branch. Branch `p2-012-slice-b` (from main `875a00c`), PR **#30**, CDR-031. (P2-009 merged `40548cf`; brace-expansion CI
  hotfix merged `875a00c`; Phase 2 was 9/12.) Selected via canon discovery over P2-007/P2-011 — P2-012 is the M2/M3
  milestone-exit E2E on the critical spine, deps P2-009 + P2-010 both Done, fully buildable on the deterministic
  FakeModelProvider, NO owner gate. The founder-discovery vertical slice (interview → adaptive follow-ups →
  classification → understanding → edit → confirm → correction → fallback-flag negative), composing the merged
  P2-001/002/005/006/008/009 use cases. `runSliceBJourney` (@acbp/test-support) implemented ONCE, shared by the CI
  suite + `pnpm demo:slice-b` (no drift; the Slice A/CDR-021 precedent); the core use cases + gateway factory are
  INJECTED (test-support must not import @acbp/core — workspace cycle). No migration, no new authz/audit, no live
  provider. Commit `51cb256` pushed; CI `30134235216` in flight. Local: E2E 1/1, demo 13/13, unit 927, boundaries (no
  cycle)+typecheck+lint+secrets+encoding+boundary-tests clean. Remaining: docs + review + finalization. PR #10 untouched.
- **ACBP-P2-009 understanding review + confirmation — DONE (merged squash `40548cf`, PR #28).**
  Backlog **Done**. Independent 10-dimension adversarial review **CLEAN** (no Blocker/Critical/High; 4 Low/Medium fixed
  — D1 confirmed metadata `{version}` docs; D2 repo chronological ordering; P1 CDR confirm-precondition wording; P2
  correction_ref wording; P2-009-REVIEW-COVERAGE.md). Finalization head `1fcc8fc` pushed; finalization-records commit
  next; sequence = exact-head CI (zero-skip) → PR #28 ready → verify MERGEABLE + recheck main/PR#10 → squash-merge
  "ACBP-P2-009: Understanding review and confirmation" (no Co-Authored-By) → exact-main CI → FF main → delete branch.
  Branch `p2-009-understanding-review` (from main `9e11466`), PR **#28**, CDR-030. (P2-008 merged `9e11466`;
  Phase 2 was 8/12.) Selected via canon discovery over P2-007/P2-011 (P2-009 is the M2/M3 critical spine → P2-012 +
  P3-001; no owner gate — Usage "—" so no live model, additive migration in the existing pattern). Implements the
  owner review + confirmation gate over an understanding VERSION (not the session — P2-008 decoupled it; session-state
  sync deferred to P2-012): the five per-item controls (`understanding:review`), the owner-only confirm that unlocks
  strategy (`understanding:confirm`), and the DISC-008 correction that supersedes a confirmation + flags dependents.
  Migration 0020 (`understanding_item_reviews` + `understanding_confirmation_events`, additive dual-keyed FORCE-RLS
  append-only; UNIQUE(document_id,kind) idempotency; both in every reset list + the P1-014 catalog — no new SECURITY
  DEFINER/role). Three audit events (`understanding.item_reviewed`/`.confirmed`/`.corrected`, in-tx). Core
  `recordUnderstandingReview`/`confirmUnderstanding`/`correctUnderstanding`/`isCurrentUnderstandingConfirmed` gate.
  Commits: CDR-030 → contracts `7455e66` → migration 0020 `594b044` → core `3c349f1`. Local real-PG all green (zero
  skips): 0020+0019 migration 14, catalog 48, database 10, core review 8, audit 12; full unit 927; gate clean. HEAD
  `3c349f1` pushed; CI `30128716043` in flight. Remaining: docs + reviews + finalization. Evidence/research requests
  are recorded (not executed — Research worker P5); HTTP routes + live provider deferred (CDR-026 §0). PR #10 untouched.
- **ACBP-P2-008 understanding generation — FINALIZING (autonomous window; finalization pre-authorized).** Branch
  `p2-008-understanding-generation` (from main `c916d81`), PR **#27**, CDR-029. (P2-005 merged `c916d81`; Phase 2
  was 7/12.) Selected via canon discovery over P2-007/P2-011 (P2-008 is the M2/M3 critical spine → P2-009 → P2-012
  → P3-001; P2-011 hits the live-model eval gate; P2-007 lower-leverage). Generates a classified, versioned
  business-understanding document from confirmed memory (diagram 04 `gen`; UNDER-001/005): closed 6-class taxonomy
  (fact/preference/constraint/assumption/research_finding/open_question), `parseUnderstanding` deny-by-default,
  per-section confidence + present/assumed/unknown status (0.5 threshold), overall = weakest covered section;
  migration 0019 (`understanding_documents` + `understanding_items`, additive dual-keyed FORCE-RLS append-only
  versioned; both in every reset list + the P1-014 catalog); `understanding.generated` audit; `understanding.generate`
  template; `understanding:generate`/`understanding:read` authz. Core `generateUnderstanding` composes the scoped
  primitives + the P2-003 gateway (model call BETWEEN scopes) → persist version+items+audit in one tx
  (audit-or-nothing); **failure/malformed persists NOTHING**; model-flagged partial → status partial; race-safe
  versioning (ON CONFLICT + bounded retry). Uses the FAKE provider; **live generation + HTTP routes are the deferred
  owner gate CDR-026 §0** (engine proven by the scripted integration suite, CDR-029 §8). Built TDD; unit 906/0;
  real-PG integration 15/15 (0 skips): 0019 catalog/lifecycle 6 + generation 9 (complete/partial/6-classes/
  malformed→nothing/gateway-failure→nothing/audit-rollback/non-member-forbidden/version-sequencing+immutability/
  concurrency). Independent 10-dimension review **CLEAN** (no Crit/High/Med); 3 LOW fixed (race-safe versioning +
  concurrency test; CDR §1/§3 wording) — P2-008-REVIEW-COVERAGE.md. Web build not required (no route). CI green on
  `448b83d` (run 30125418699); review-fix head `85808e7`. **Finalization:** records commit → exact-head CI → PR #27
  ready → squash-merge "ACBP-P2-008: Understanding generation" (no Co-Authored-By) → exact-main CI → delete branch →
  next Ready ticket. Phase 2 after merge: **8/12 Done**; P2-009 (understanding review, deps P2-008) + P2-007 become
  candidates (P2-011/P3-006/P7-012 gated on the live-model eval; P2-012 needs P2-009+P2-010).
- **ACBP-P2-005 adaptive question orchestration — FINALIZING (autonomous window; finalization pre-authorized).**
  Branch `p2-005-adaptive-orchestration` (from main `68a022b`), PR **#26**, CDR-028. Selected via canon discovery
  over P2-005 vs P2-007 (both Ready/unblocked; P2-005 is on the M2/M3 critical path, P2-007 only feeds a Phase-5
  worker). Delivers the adaptive interview ENGINE (diagram 04: batch→ask→answer/IDK/pause→vague/contradiction
  check→store→loop): contracts (parseFollowUps/parseAnswerQuality/parseAssumption deny-by-default + QuestionSource);
  migration 0018 (`interview_questions.rationale` + `.source`, additive immutable); two registry templates
  (interview.answer_quality/assumption); pure DISC rules (≤3 cap, static-fallback flag, fail-open detection,
  assumption→ai_assumption); use cases (generateAdaptiveBatch/evaluateAnswer/suggestAssumptionForSkip) composing
  the scoped primitives + the P2-003 gateway (model call BETWEEN scopes); composition validator. Built TDD; unit +
  **real-PG integration 8/8** (adaptive persist+metering, static fallback, ≤3 rule, clear→user_fact, vague/contra
  no-memory, IDK→ai_assumption, non-member forbidden). Uses the deterministic FAKE provider; **live generation +
  the HTTP orchestration routes are the deferred owner gate CDR-026 §0** — the engine is proven by the scripted
  integration suite (CDR-028 §8). Independent security/scope review **CLEAN** (no Crit/High/Med; 3 LOW retained;
  API-deferral accepted as documented/precedent-consistent — P2-005-REVIEW-COVERAGE.md). Web build + audit green;
  unit 888/0. **Finalization sequence:** records commit → push → exact-head hosted CI (zero-skip) → PR #26 ready →
  squash-merge "ACBP-P2-005: Adaptive question orchestration" (no Co-Authored-By) → exact-main CI → delete branch →
  next Ready ticket. Phase 2 after merge: **7/12 Done**; P2-007 (context assembly) + P2-008 (understanding, deps
  P2-005+P2-006) become the next Ready candidates.
- **ACBP-P2-004 prompt/template registry — DONE (autonomous window).** Branch `p2-004-prompt-template-registry`
  (from main `d95fafb`), PR **#25**. Provider-neutral versioned template registry in `@acbp/contracts`
  (`model/template.ts`): `TemplateDefinition {family, version, taskClass, segments, slots}`, `resolveTemplateRef`
  (deny-unknown), `latestTemplateRef` pinning, `templateProvenance {template_ref, template_version}` (TASK-005),
  `renderTemplateSegments` (own-slot; assembly stays P2-007). CONFIG not tenant data — **no migration, no new
  SECURITY DEFINER (still 3), no tenant surface**. CDR-027. Three read-only reviews (canon/scope · security ·
  tests/docs) CLEAN; all Low/Info findings fixed (neutrality-token list widened + family/slot scan; per-family
  task-class assertions; `isPlatformError` on render-deny; CDR truth-ups). Acceptance "recorded on every derived
  artifact" satisfied at the MECHANISM level — end-to-end stamping tracked to the first artifact-producing ticket.
  Unblocks nothing new by itself; P2-005 still needs the D-10 (existing-business) owner decision reviewed.
- **ACBP-P2-003 model gateway — DONE; squash-merged `d95fafb` (PR #24), exact-main CI 30112328579 green
  zero-skip.** Branch `p2-003-model-gateway` (from main `10b4e2e`) deleted post-merge. Feature head **`52653f2`**; exact-head hosted CI **30109799579
  green, ZERO-SKIP** (CI preflight "fails if integration tests would silently skip" → OK; 121/121 test files;
  real-PG append-only/RLS/CHECK/FK negative assertions all executed). A **second independent review round** ran
  five parallel read-only reviewers (canon/scope · contract · tests · security · docs): security CLEAN, scope
  CLEAN; all actionable findings FIXED (timeout bound to `taskClass`; fail-closed on `outputSchemaRef` with no
  wired validator; retry/re-ask CLAMPED to owner-ratified ceilings; generation-deadline + unwired-validator +
  row-level-canary tests; `@acbp/core` gateway README; doc precision truth-ups) — ledger in
  `docs/implementation/P2-003-REVIEW-COVERAGE.md`. Also fixed a real hosted-CI drop-list collision
  (`usage_events` added to all schema-reset lists + the P1-014 catalog; commit `52653f2`). **IOQ-13 owner-RATIFIED** ("Adopt proposed defaults": interactive
  30s / generation 120s / retries ≤2) → recorded in **CDR-026** + IOQ marked Resolved. Built the provider-neutral
  gateway ABSTRACTION + a deterministic FAKE provider (the only wired adapter): `callModel` (ADR-011 contract,
  per-class timeout, bounded retry ≤2 + re-ask ≤1, fallback eligibility [generation ineligible — no silent
  fallback], seven-value normalized taxonomy, redacted logging, company-policy pre-check) + APPEND-ONLY
  `usage_events` (migration 0017, dual-keyed FORCE RLS, SELECT+INSERT only, integer micro-units) with FAIL-CLOSED
  metering. **The LIVE provider path (real key + `gpt-5.1` snapshot pin [CDR-001 §8] + ADR-019 §13 eval gate) is a
  DEFERRED owner gate — CDR-026 §0 — NOT built.** 5 committed slices' worth (contracts → 0017 → gateway+fake →
  composition → docs). Evidence: full static gate green; unit 850/850; real-PG usage_events 8/8 + composition 5/5
  (0 skips on disposable DB). **NEXT (owner gate): authorize the finalization sequence** — backlog Planned→Done →
  records commit → push + draft PR → exact-head hosted CI green (zero skips) → mark PR ready → squash-merge
  **"ACBP-P2-003: Model gateway v1 with usage recording"** (no Co-Authored-By) → exact-main CI → delete branch →
  next Ready Phase 2 ticket (P2-004/P2-005/P2-007 unblock once P2-003 Done).
- **ACBP-P2-010 finalization.** Status **Done**; feature head `b9441f1` (review fixes), exact-head CI
  **30102561583 green** (local full suite 116 files / 1319 / 0 skipped). The memory browser: list/filter/get +
  owner edit (versioned supersede) + owner **soft delete** — the CDR-025 §0 deletion semantics were an owner
  gate, **owner-RATIFIED** (`deleted_at` + `deleted_by_user_id`; `memory.item_deleted` in-tx; propagation
  deferred to M3/M4). Both independent reviews CLEAN with explicit CORRECT verdicts on delete-concurrency
  determinism, audit atomicity, and grant narrowness; all findings fixed (edit-concurrency FOR-UPDATE lock;
  CDR §7; P2-010-REVIEW-COVERAGE.md). Sequence: finalization records commit → exact-commit CI → PR #23 ready →
  recheck main/PR#10 → squash-merge **"ACBP-P2-010: Memory browser"** (no Co-Authored-By) → exact-main CI →
  delete branch → next Phase 2 ticket.
- Migrations 0001–0016; exactly 3 SECURITY DEFINER (all 0006); `acbp_app` NOBYPASSRLS/non-owner; no owner
  runtime. `memory_items` column-level UPDATE confined to `superseded_by` (0015) + `deleted_at`/`deleted_by_user_id`
  (0016); content/type/source/identity immutable; no hard-delete grant. Lifecycle active/superseded/deleted
  (mutually exclusive, DB-enforced). Deleted items omitted from list/get; the row survives for history/audit.
- **P2-001/P2-002/P2-006/P2-010 — Done.** Phase 2: **4 Done / 8 Planned.** P2-003/P2-005 gated by open question
  IOQ-13.
- **P2-001/P2-002/P2-006 — Done.** Phase 2: 3 Done / 9 Planned. P2-003/P2-005 gated by IOQ-13.

## ACBP-P2-006 detail (Done) — branch `p2-006-typed-memory-items`, PR #22, CDR-024
- Status **Done**; feature head `a5fe97c` (review fixes), exact-head CI
  **30090738122 green** (real-PG memory suites + HTTP adversarial + reverse-fully migration cycle; local full
  suite 115 files / 1286 / 0 skipped). Both independent reviews CLEAN with explicit CORRECT verdicts on the
  migration root-cause fix and the audit atomicity/decision (not an owner gate); all findings fixed
  (P2-006-REVIEW-COVERAGE.md). Sequence: finalization records commit → exact-commit CI → PR #22 ready → recheck
  main/PR#10 → squash-merge **"ACBP-P2-006: Typed memory items with provenance"** (no Co-Authored-By) →
  exact-main CI → delete branch → next Phase 2 ticket.
- Migrations 0001–0014; exactly 3 SECURITY DEFINER (all 0006); `acbp_app` NOBYPASSRLS/non-owner; no owner
  runtime; `memory_items` dual-keyed FORCE RLS (SELECT+INSERT only). `memory.item_created` audited in-tx.
- **Migration-cycle blocker (prior window) — ROOT-CAUSED + FIXED (Class T):** a window-1 bulk drop-list edit had
  inserted `memory_items` into migration `0013`'s down loop → 42P01 on multi-step migrate-down. Fixed
  (`cb43315`): 0013.down reverted to its own tables; the two speculative changes reverted (0014 self-FK restored,
  0014.down standard pattern). Diagnosed on a disposable PostgreSQL (Windows-native 5433, isolated DB,
  command-local env; `.env.local` untouched).
- **P2-001/P2-002/P2-006 — Done.** Phase 2: **3 Done / 9 Planned.** P2-003/P2-005 gated by open question IOQ-13.
- **Design (CDR-024):** `memory_items` (migration 0014) with the **closed 8-type enum** (user_fact,
  user_preference, constraint, ai_assumption, research_finding, approved_decision, measured_outcome,
  correction; type set by source path, untyped rejected), 6-value `source_type` + resolvable `source_ref`
  (encodes the pinned interview-answer `(question_id, revision)`), nullable confidence/superseded_by (populated
  by P2-008/P2-010), confirmation_state default 'proposed'. Dual-keyed FORCE RLS, SELECT+INSERT only
  (append-only for P2-006; supersede is P2-010). Operations create + list; authz `memory:write`/`memory:read`
  (owner|viewer). **Audit REQUIRED** (contrast P2-002): `memory.item_created` written in-transaction (ADR-015),
  metadata `{item_type, source_type}` only — flagged in CDR-024 §4 for owner visibility (new event name;
  implements the canonical "All changes audited"; additive/reversible). Out of scope: context assembly (P2-007),
  understanding/confidence-scoring (P2-008), the browser + edit/delete/supersede (P2-010).
- **Migration-cycle blocker — ROOT-CAUSED + FIXED (window 2).** The 42P01 `relation "public.memory_items" does
  not exist` in the multi-step `migrateDown`/`migrateTo(earlier)` suites was **Class T**: a window-1 bulk
  drop-list edit (adding `memory_items` to test cleanup lists) also matched and edited **migration `0013`'s down
  loop**, so `0013.down` ran `drop policy/revoke … on public.memory_items`. During a down PAST 0013, `0014.down`
  had already dropped `memory_items` (step 0, success), so `0013.down` raised 42P01 at step 1. The single-step
  memory-items test passed because it never reached `0013.down`. Fix: `0013.down` reverted to its own tables
  (`['interview_answers','interview_questions']` — matches main). Also reverted the two window-1 speculative
  changes made for the wrong hypothesis: `0014` self-FK on `superseded_by` **restored** (integrity), and
  `0014.down` restored to the standard policy-drop+revoke+drop-table pattern (matches 0012/0013). Verified on a
  disposable PostgreSQL (Docker daemon unresponsive → used the Windows-native 5433 cluster, isolated
  `acbp_p2006_test` DB, command-local env — `.env.local` untouched): full suite **114 files / 1277 tests / 0
  failed / 0 skipped**, including reverse-fully-and-reapply + the 8 previously-failing suites.
- **Next:** push the fix (exact-head hosted CI green, zero skips), then P2-006 slices 3–5 (core create/list +
  audited-in-tx `memory.item_created`, API, adversarial+docs), reviews, finalize. Branch
  `p2-006-typed-memory-items`, draft PR #22, CDR-024; **main untouched/green** at `1c49c55`.
- **ACBP-P2-002 — Done** (squash `1c49c55`, PR #21). Phase 2: 2 Done / 10 Planned. P2-003/P2-005 gated by open
  question IOQ-13; P2-006 is the sole unblocked ticket.

## ACBP-P2-002 detail (Done) — branch `p2-002-question-answer-persistence`, PR #21, CDR-023
- Status **Done**; feature head `71657ae` (review fixes), exact-head CI
  **30075033944 green** — real-PG Q&A suites (append-only revisions, idempotent no-op, concurrent
  distinct-both-persist + identical-collapse, NOT-NULL author, cross-tenant isolation) + HTTP adversarial all
  passed. Both independent reviews CLEAN with an explicit verdict that the CDR-023 §4 audit-deferral is
  acceptable and NOT an owner gate; all observations fixed (P2-002-REVIEW-COVERAGE.md). Sequence: finalization
  records commit → exact-commit CI → PR #21 ready → recheck main/PR#10 → squash-merge **"ACBP-P2-002: Question
  and answer persistence"** (no Co-Authored-By) → exact-main CI → delete branch → next Phase 2 ticket.
- Migrations 0001–0013; exactly 3 SECURITY DEFINER (all 0006); `acbp_app` NOBYPASSRLS/non-owner; no owner
  runtime; `interview_questions` (immutable) + `interview_answers` (append-only, NOT-NULL author) dual-keyed
  FORCE RLS. **Persistence-only** — no audit/domain event (deferred; CDR-023 §4).
- **ACBP-P2-001 — Done** (squash `6cf537e`, PR #20). Phase 2: 2 Done / 10 Planned. Next candidates: P2-005
  (adaptive orchestration; deps P2-003+P2-002 — P2-003 gated by IOQ-13, so P2-005 is blocked); **P2-006** typed
  memory (deps P1-005 Done — UNBLOCKED); P2-003 gateway gated by IOQ-13.
- **PR #10** still OPEN/draft/external — inspect GitHub state only; never touch.

## ACBP-P2-001 detail (Done) — branch `p2-001-interview-session-state-machine`, PR #20, CDR-022
- **Design (CDR-022):** the durable, company-scoped interview **session envelope** + server-enforced state
  machine (§2 six states) + exact resume + `interview.started` (audit-only; activity projection DEFERRED so
  P1-009's closed taxonomy isn't expanded in a persistence slice) + illegal-transition rejection. P2-001
  implements start/suspend/resume + read; the ready_for_review/confirmed/superseded transitions are defined in
  the contract but their effects belong to later M2/M3 tickets. Migration 0012 `interview_sessions`
  (dual-keyed FORCE RLS, column-immutable identity, one-open-session-per-company partial unique index). Authz
  `interview:read`/`interview:participate` (owner|viewer). Four slices (contracts → migration → core → API).
- **Selected over** P2-006 (unblocked but downstream/parallelizable) and P2-003 (gated by open question
  IOQ-13). P2-001 is the root of the M2 dependency tree.
- **P0-005 remains Blocked** — a known blocked dependency; stop only if a Phase 2 ticket becomes blocked on it.
- **PR #10** (`p1-004-last-owner-race-fix`) still OPEN/draft/external — inspect GitHub state only; never touch.

## Phase 1 completion evidence (2026-07-24)
- **Tickets:** ACBP-P1-001…P1-015 all Done. Squash SHAs for the tickets closed in this session's arc:
  P1-010 `093ec3f` (PR #11), P1-011 (PR #13), P1-012 `c1990ad`… see below, P1-013 `c1990ad`… (PR #15),
  P1-014 **`b559d37`** (PR #16), P1-015 **`85fcb8f`** (PR #17). Final `origin/main` = `85fcb8f`.
- **Migrations:** 0001–0011, ordered and intact. No 0012.
- **SECURITY DEFINER:** exactly three, all in `0006_bootstrap_functions.ts`
  (`acbp_provision_account`, `acbp_resolve_own_membership`, `acbp_accept_invite`).
- **Runtime role:** `acbp_app` created NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOINHERIT;
  BYPASSRLS granted to no one; no `DATABASE_URL` in `apps/web` runtime source (owner connection is
  migration/test-only).
- **Evidence discipline:** hosted CI on the exact SHA is the trust-critical DB evidence; zero-skip PostgreSQL
  preflight enforced; production `next build` is recorded separately and never conflated with hosted CI.
- **Post-completion audit:** backlog P0 20 Done + P0-005 Blocked; P1 15 Done; no abandoned P1 branches (only
  `main` + external PR #10); secret/encoding/boundary checks 0; no temp/scratch/secret artifacts tracked
  (only `.env.example`). One records-only staleness (this file's Active section) fixed on branch
  `records-phase1-complete`.

## ACBP-P1-015 detail (Done, squash `85fcb8f`, PR #17)
- Branch `p1-015-slice-a-secure-company-creation` from `main` @ `b559d37`, **PR #17**. Governed by **CDR-021**.
  - **Design (CDR-021):** the M1 exit criterion made executable — sign in → internal mapping → account →
    company → switch → cross-company access DENIED, with the audit/activity trail verified. The journey is
    implemented ONCE in `@acbp/test-support` (`runSliceAJourney`) and consumed by BOTH the runnable demo
    (`pnpm demo:slice-a`, wired into the CI gate) and the CI suite, so the demo cannot drift from the
    guarantee. Everything below the provider-SDK edge is production code over the restricted `acbp_app`
    connection under FORCE RLS; `DATABASE_URL` is deleted from the runtime's environment and the restricted
    role is then PROVEN positively via `runtimeConnectionRoles`.
  - **Browser-level E2E deferred to staging** (CDR-021 §1): the slice-A flows are API-only by owner decision,
    so there are no screens to drive, and driving Clerk's hosted sign-in would need live provider credentials.
    `TEST-AND-VERIFICATION-STRATEGY.md` amended accordingly. No live authenticated acceptance performed.
  - **Progress:** Slice 1 `2f03a70` (journey + CI suite + demo + CDR-021 + demo doc; exact-head CI 30063164730
    green, 104 files / 1157 / 0-skip, 3m18s). Then the two independent reviews (security; architecture/scope)
    found the DEMO SCRIPT — the backlog row's own acceptance criterion — could not run at all: a Windows
    `pathToFileURL(url.pathname)` drive-letter doubling, and no `@/…` alias resolution outside
    `apps/web/tsconfig.json` + `vitest.config.ts`. Both repaired and the script then EXECUTED end to end
    against real PostgreSQL (10/10 steps, exit 0), and wired into `ci.yml` so the criterion has hosted
    evidence. Also repaired from the reviews: ACC-001 proven NEGATIVELY (mutable verification status +
    unverified-email refusal), PORT-003 given a real A→B→A switch, two unfalsifiable journey steps replaced
    with falsifiable ones (route-stamped `actor_id`; "did this caller leave a trail INSIDE the other
    tenant?"), the runtime-role claim upgraded from precondition to positive proof, the three hand-copied
    runtime-env blocks consolidated into `configureRouteRuntimeEnv`, and the fixture's company names exported
    so leak assertions cannot go vacuous on a rename.

## Closed in this session
- Ticket: **ACBP-P1-014** — Tenant-isolation adversarial suite (status: **Done**). Squash-merged **`b559d37`**
  (PR #16). Implemented under CDR-020. Class M owner gate on `activity_events.event_id` global uniqueness
  RESOLVED as **Option C** (accepted residual: server-generated opaque global identities may remain globally
  unique when no production or plausible application-bug path can supply a foreign value to the constraint;
  caller-influenceable idempotency keys stay tenant-scoped, as already implemented for `audit_events`).
- Ticket: **ACBP-P1-013** — Administrative-access foundation (status: **Done**, owner-authorized 2026-07-24).
  Implemented 2026-07-23 under 21 explicit owner decisions → **CDR-019**.
- Branch: `p1-013-administrative-access-foundation` (from `main` @ `795227b`).
- Base main: `795227bb5265eb71d09e0a220fb3f8917eaa3384` (P1-012 squash PR #14; exact-main CI 30014863811 green,
  87 files / 951 / 0-skip).
- **P1-013 design (CDR-019):** owner-managed `platform_admins` allowlist (users.id-keyed; runtime = self-check
  SELECT only, fresh per request; NO runtime management API; no default/env admin); mandatory bounded VERBATIM
  reason (≥1 non-ws char, ≤512 code points, no NUL, validated before any DB read); single operation
  `admin.tenant_read` (audit-only; target-tenant-scoped; actor_type admin; metadata {reason, scope='company_overview'};
  audit failure blocks response); cross-tenant read via transaction-local target GUCs on `acbp_app` ONLY after
  identity + reason + fresh-admin checks (accountId+companyId both selectors, relationship DB-verified; JIT =
  per-transaction; primitive PRIVATE — no generic runAsTenant export); API-only
  POST /api/admin/accounts/[accountId]/companies/[companyId]/read body {reason} → {companyId,status,creationMode,
  createdAt}; coarse single 403 (no existence oracle); NO impersonation structurally; break-glass + JIT workflow
  DOCUMENTED not built; activity taxonomy unchanged; no 4th SECURITY DEFINER/BYPASSRLS/owner-runtime/third role.
- PR: **#15 draft** "ACBP-P1-013: Administrative-access foundation", base `main`.
- **P1-013 progress:** planning `c48734d` (CDR-019); Slice 1 `15d5adb` (contracts/authz/audit registry; CI
  30017194994 green); Slice 2 `d49e33b` (migration 0011 platform_admins + real-PG suite + runbook; its CI
  30017530296 FAILED on a latent head-pinned migrateDown in the P1-012 backfill suite → repaired `b014e4e`:
  rollback targets pinned BY NAME, also restoring the 0009 reapply proof that had gone vacuous); Slice 3
  `1b28db6`+`a86cf92` (executeAdminCompanyRead one-tx primitive + adminReadCompanyOverview + real-PG trust
  suite + always-run no-impersonation boundary guard; CI 30018642111 green 91f/980/0-skip); Slice 4 `0db555c`
  (admin API route + strict parsing/privacy tests + prod build, route emitted dynamic; CI 30019840829 green
  1018/1018/0-skip). Slice 5 `ae53442`+`966e44d`: malformed-selector UUID-shape guard, full doc set
  (ADMINISTRATIVE-ACCESS.md + BREAK-GLASS-DESIGN.md new; SECURITY-ARCHITECTURE/AUTHORIZATION/TENANCY/
  API-CONTRACTS/EVENT-CATALOG/AUDIT/DATA-ARCHITECTURE updated), three independent reviews over the eight owner
  lenses (no Critical/High; 1 Medium + 6 Lows + 1 info — ALL fixed; ledger in
  `docs/implementation/P1-013-REVIEW-COVERAGE.md`), postcss ≥8.5.12 override (GHSA-6g55-p6wh-862q).
  **Final feature HEAD `966e44d`; exact-head CI 30021770562 green — 93 files / 1038 / 0 failed / 0 skipped.**
  NOTE (documented deviations): no reified AdminCapability value exists — the capability is the verified
  position inside the one transaction (strictly stronger: nothing to cache/serialize/forge); META_MAX_VALUE_LEN
  raised 512→1024 UTF-16 units for astral verbatim reasons (the PUBLIC reason limit stays exactly 512 code
  points); all admin parse failures collapse to one generic 400.
- **P1-012 design (CDR-018, owner-accepted 2026-07-23):** internal-Postgres-only workspace provisioning; six
  canonical ordered steps (profile, mission_draft, research, roadmap, documents, activity); auto-start after the
  creation tx COMMITS; request-driven SEQUENTIAL execution, fresh CompanyScope tx per step; NO worker/queue/
  detached-task/polling/lease/daemon/outbox/owner-connection; durable statuses pending|completed|failed (NO
  committed running); max 3 total attempts/step (exhausted → safe conflict); one MUTABLE row per (company, step)
  in `provisioning_steps` + `company_workspace_areas` registry (mission_draft/research/roadmap/documents INSERTs;
  profile + activity are VERIFICATION steps — no duplicates, no synthetic events); activation = all six completed
  (failed-acknowledged DEFERRED); six audit-only registered events (started/step_started/step_completed/
  step_failed/retry_requested/completed; system actor for execution, user actor for retry_requested); P1-009
  activity taxonomy UNCHANGED; migration 0010 additive (FORCE RLS dual-key; backfill seeds pending checkpoints
  for draft/onboarding companies, runs nothing, transitions nothing); authz `provisioning:read` (owner|viewer) +
  `provisioning:resume` (owner); API-only GET …/provisioning + POST …/provisioning/resume (single resume route,
  no start/retry/acknowledge/cancel, no body/params, no UI/SSE); NO 4th SECURITY DEFINER.
- **P1-011 design (CDR-017, owner-accepted 2026-07-23):** membership-filtered portfolio (active company_memberships
  only; NO account-owner registry visibility); enumeration under AccountScope (company GUC unset) starting from the
  memberships self-branch, joined to companies (account RLS = isolation, not authorization); name enrichment via
  bounded SEQUENTIAL fresh CompanyScope reads (NO account-scoped profile policy); selection URL-only/stateless/
  non-authoritative (nothing persisted anywhere); switching = navigate + fresh runInCompanyScope (no switch action/
  endpoint/durable event); API-only `GET /api/companies` (cursor+limit only; invalid limits REJECTED not clamped;
  keyset created_at DESC, id DESC; default 25/max 100; cursor base64url bound to account+ACTOR); DTO
  {companyId,name,status,role,createdAt}; no filters/metrics; no RLS/persistence migration (index-only allowed ONLY
  on EXPLAIN-proven need); no 4th SECURITY DEFINER.
- **P1-009 design (CDR-016, owner-accepted 2026-07-22):** separate append-only company-scoped `activity_events`
  table (PK = source audit `event_id`; redacted; rebuildable); **synchronous in-transaction projection** of the 4
  company events (`company.created/updated/paused/resumed`) written atomically with the lifecycle mutation + audit
  under the same restricted `acbp_app` CompanyScope; `audit_events` authoritative; **no outbox/async/worker/
  checkpoint/lease/owner-connection/4th SECURITY DEFINER**; `activity:read` = owner|viewer company member; keyset
  pagination (occurred_at DESC, event_id DESC; opaque versioned cursor; default 25/max 100); honest `as_of`;
  **API-only** `GET /api/companies/[companyId]/activity`; no rendered page, no SSE (SSE deferred to P6-008).

## Concurrent work — DO NOT TOUCH
- **PR #10** `p1-004-last-owner-race-fix` (separate session, now deleted) is **OPEN/unmerged**, base main. Its
  worktree `.claude/worktrees/p1-004-last-owner-race-fix` is still registered/locked. Leave it and the branch
  untouched. It touches the memberships REVOKE path; the separate `company_memberships` decision means **no
  overlap** with P1-010. If PR #10 merges during P1-010: fetch, fast-forward, rebase, re-run membership/authz/
  audit/RLS tests, record the new base.

## Prior tickets (closed)
- **ACBP-P1-001..P1-008 — DONE & MERGED.** P1-008 squash `8afb8f0` (PR #9). Main CI green on each squash.
- **ACBP-P1-010 — DONE & MERGED** (squash `093ec3f`, PR #11; exact-main CI `29935591570` green, 803/0-skip).
- Residual: delete the inert P1-002 Clerk Development webhook endpoint. Do NOT touch it.

## P1-010 scope (canonical) — CDR-015 (owner-accepted 2026-07-22)
- **Companies** (C-root: `company_id` PK immutable, `account_id`, name, status, creation_mode) + **company_profiles**
  (immutable versioned; new version per edit; COMP-004) + **company_memberships** (SEPARATE table: company_id,
  account_id, member_user_id, role owner|viewer, status; uniqueness `(company_id, member_user_id) WHERE active`).
- **Many companies per account**; company belongs to exactly one account. Company membership is INDEPENDENT of
  account membership (requires an active account membership; account ownership does NOT auto-grant company access;
  creator gets an explicit active company `owner` row).
- **Company context**: `CompanyContext {accountId, companyId, actorId}`; branded `CompanyScope` (type-distinct from
  AccountScope; the reserved P1-005 `TenantContext`/`TenantScope`/`withTenantTransaction` primitive); resolver =
  server-verified userId + requested companyId → active company_membership → mint CompanyScope; companyId is a
  selector never authority.
- **Create under existing AccountScope; NO 4th SECURITY DEFINER function** (account-keyed `companies` INSERT policy;
  one atomic tx: insert company → mint CompanyScope from the authoritative row → set app.current_company → insert
  owner membership → insert profile v1 → write company.created audit → commit-all-or-rollback-all).
- **Company RLS** keyed to app.current_account + app.current_company (both must match; fail-closed); `acbp_app` stays
  NOBYPASSRLS/non-owner. **audit_events gains nullable `company_id`** (additive expand; account events NULL, company
  events set; append-only preserved). Dual-scope audit policy (account: company_id NULL; company: both match).
- **Lifecycle (WORKFLOW §1 subset):** create (3 modes; idea-mode full) / rename+profile-update / status (truthful;
  unknown→"unknown") / pause / resume. Owner-only lifecycle mutations. Pause = "no new job pickup" (invariant-16
  groundwork via a minimal test rig; no real scheduler). Atomic transitions.
- **Durable company events (4, registered + in-tx):** company.created {company_id, creation_mode}, company.updated
  {changed_fields}, company.paused {reason?}, company.resumed {reason?, held_work_count?}.
- **Out of scope:** deactivate/delete (COMP-007 Post-MVP), portfolio/list/switching (P1-011), provisioning execution
  (P1-012), activity feed + outbox (P1-009+), company invitation flow, any scheduler/queue/worker beyond the test rig.

## Slices
1. Planning + contracts + CDR: **this commit** = CDR-015 + P1-009 dep correction + agent records. Then Slice 1 code:
   company contracts (@acbp/contracts): lifecycle/status/creation-mode types, company authz actions, typed audit
   event factories (company.created/updated/paused/resumed) + registry entries; exhaustive unit tests.
2. Schema + RLS: additive migrations (companies, company_profiles versioned, company_memberships, audit_events
   company_id) + grants/policies/indexes + real-PG migration/RLS/catalog tests (0001-0007 unchanged; no 4th fn).
3. Context + creation: company resolver + CompanyScope mint + same-tx company bootstrap (owner membership + profile
   v1 + company.created audit); 3 creation modes; failure/rollback tests.
4. Lifecycle: read/status, rename/profile-version, pause/resume, owner-only authz, audit atomicity, concurrency/
   idempotency, pause-pickup test rig.
5. API boundary (when canonical): authenticated routes, strict parsing, safe errors, forged-scope negatives; next build.
6. Adversarial hardening + docs + independent reviews.

## Guards (every slice)
- `check:static` (typecheck, lint, secrets 0, encoding 0 BOM, boundaries 0, boundary tests) + full `vitest` incl.
  real-PostgreSQL integration on hosted CI (zero-skip preflight) + `pnpm audit --audit-level high`. `next build`
  only if web runtime changes. Cross-tenant isolation + own-membership-only resolution are trust-critical.

## Blockers / owner decisions
- **RESOLVED:** company data-model/tenancy/bootstrap → CDR-015 (owner-accepted 2026-07-22).
- Future owner gates (do NOT self-authorize): P1-010 backlog→Done, PR ready, merge, branch delete. Begin/resume
  P1-009 only on separate authorization. Stop if profile-versioning storage semantics turn out canonically unsettled
  (owner-approved immutable-revision model per CDR-015).

## Authority limits (this ticket — P1-015)
- Standing Phase 1 authorization covers implementation, slices, pushes, CI, reviews, defect fixes, marking
  P1-015 Done, marking PR #17 ready, squash-merging it, and deleting its branch. Still forbidden: production
  systems/credentials/deploys, live Clerk, any Clerk dashboard change, public tunnels, force-push or history
  rewrite, direct commits to main, non-squash merges, touching PR #10 / its worktree / the stale
  `claude/affectionate-northcutt-f33c98` branch or the inert P1-002 endpoint, weakening tests to make them
  pass, and implementing later-phase scope. Stop only for a NEWLY discovered true mandatory owner gate.

## Authority limits (historical — P1-013)
- No production systems/credentials; no public tunnel; no Clerk dashboard; do not touch the inert P1-002 endpoint
  or PR #10 / its worktree. Do NOT: mark P1-013 Done / PR ready / merge / delete branch / begin P1-014; build
  break-glass or a JIT approval workflow; implement impersonation of any kind; add tenant-data mutations, admin
  list/search, audit export, UI, or SSE; add a runtime admin-management endpoint; add a worker/queue/outbox; add
  a 4th SECURITY DEFINER; weaken FORCE RLS; grant BYPASSRLS; expose the owner runtime connection or a third
  runtime role; export a generic arbitrary-tenant scope primitive; expand the activity taxonomy.

## Test baselines
- Inherited from merged `main` (`8afb8f0`): hosted CI green (zero-skip PG preflight + aggregate + audit). Integration
  files run serially (`vitest fileParallelism:false`) on one shared DB — new suites' cleanup drop-lists must include
  `company_memberships`, `company_profiles`, `companies` (and any new tables), ordered so FKs drop cleanly.
- Local Windows→WSL PG forwarding unstable; hosted CI is the authoritative zero-skip integration gate.
- The `_lc` shell hook intermittently emits false exit-127; verify state via git/gh/CI/filesystem re-reads (PowerShell).

## P1-011 slice plan (CDR-017)
- Slice 1 — **DONE** (`3e0834a`; exact-commit CI `29972673530` green). Shared base64url codec extracted; portfolio
  contracts (PortfolioItem/PortfolioPage; account+actor-bound base64url keyset cursor; strict limit REJECT-not-clamp);
  `portfolio:read` authz action + drift entry; codec/portfolio unit tests (54 contracts tests green).
- Slice 2 — **IN PROGRESS**. Account-scoped membership-filtered `PortfolioRepository`
  (`listActiveMembershipCompanies`: memberships-self-branch → companies PK join; keyset created_at DESC/id DESC;
  exact-microsecond `created_at_us`; NO name, NO list-all method) + real-PG visibility/isolation/keyset test.
  **Query-plan decision (CDR-017 §10): NO index migration** — PROVEN by hosted real-PG EXPLAIN evidence
  (`portfolio-plan.integration.test.ts`, realistic ANALYZEd population, postgres:16): natural plan = Limit → Sort →
  Nested Loop(Bitmap via `company_memberships_member_idx` → `companies_pkey` probe), no seq scans, identical for
  first + keyset pages. Migrations remain 0001–0009. See `docs/implementation/P1-011-PORTFOLIO-QUERY-PLAN.md`.
  Local integration UNRUNNABLE (Windows→WSL 5432 forwarding refuses connections); hosted CI is the zero-skip gate.
- Slice 3 — **DONE**. `getCompanyPortfolio` use case: Phase 1 enumeration under AccountScope
  (`portfolio:read` account-role check via own-membership bootstrap, then `PortfolioRepository`); Phase 2
  SEQUENTIAL per-candidate name enrichment via FRESH `runInCompanyScope` (Option B — no scope reuse, no parallel).
  A membership going stale between phases → runInCompanyScope denies → candidate DROPPED (never a stale/substituted
  row; keyset advances past it). `enrichCandidatesSequentially` exported for deterministic stale-drop testing.
  Real-PG core test proves membership-only visibility, account-member-only-no-rows, forbidden non-member, keyset
  pagination + account+actor cursor, strict limit/cursor rejection, cross-company enrichment isolation, stale-drop.
  Pure-guard unit test (limit/cursor reject before any DB) runs everywhere.
- Slice 4 — **DONE**. `GET /api/companies` (portfolio) added to the existing collection route (POST create
  untouched): allowed params {cursor, limit} only (any other → 400); server-resolved account+actor; maps
  ok→200 {items,nextCursor} / forbidden→403 / invalid_cursor→400 / invalid_limit→400. Wired `getCompanyPortfolio`
  through the ClerkIdentityRuntime composition + CompanyRuntime; `getPortfolioForRequest` request use case.
  Web unit tests (request + http mapping) green; local production `next build` green (route ƒ dynamic).
- Slice 5 — **DONE**. Real-PG switch-isolation test: A→B→A sequential re-entry (no name/status bleed);
  same company yields DIFFERENT roles to different callers (role isolation via portfolio); concurrent entries +
  concurrent portfolios never cross (pooled-connection GUC isolation); transaction-local GUCs clear after COMMIT
  AND ROLLBACK; forged route companyId (non-member + cross-account) denies coarsely.
- Slice 6 — **DONE (pending owner gate)**. Architecture docs (`docs/architecture/PORTFOLIO.md`; TENANCY.md P1-011
  entry); two independent reviews CLEAN; final verification green. PR body updated. Awaiting owner authorization
  to mark Done / ready / merge / delete branch.

## P1-012 slice plan (CDR-018)
- Slice 1 — **DONE** (`69d15fa` + completeness-registry fix `d0dbe2f`): contracts (closed step/status/failure-code
  enums, DTOs, flag derivations), `provisioning:read`/`provisioning:resume`, six audit registrations + factories +
  operation partition. Draft **PR #14**.
- Slice 2 — **DONE** (`bcd12a2`; CI 30010682316): migration 0010 (CHECK-pinned tables; FORCE RLS dual-key;
  column-limited UPDATE; idempotent draft/onboarding backfill with BYPASSRLS guard) + real-PG
  RLS/privilege/backfill/down-up suite; all 22 existing suites' drop-lists extended.
- Slice 3 — **DONE** (`7e0a5d4`; CI 30011303006): creation tx atomically adds 6 pending checkpoints +
  draft→onboarding + provisioning.started (selective-writer rollback proven); creation returns onboarding.
- Slice 4 — **DONE** (`ae4fd5c`; CI 30012231249): fresh-scope step executor (FOR UPDATE + status/attempt guards;
  no committed running; cap 3), material effects (verify profile/activity; idempotent area inserts), resume
  orchestration (Phase A company-row-locked gates; USER retry_requested + causation; backfilled-draft bring-up;
  paused/inconsistent fail closed), completion transition (locks + gate + idempotent activation),
  createCompany post-commit INLINE auto-run (provisioningRunner seam); 12-test real-PG suite (kill-and-resume at
  every checkpoint, exhaustion, concurrency single-effect/single-activation, authz matrix, DTO privacy, GUC
  cleanup, provisioning audit completeness).
- Slice 5 — **DONE** (`5933fe3`; CI 30012614309): GET …/provisioning + POST …/provisioning/resume (param-free,
  body never parsed) + runtime wiring + web tests + prod build (both routes ƒ dynamic).
- Slice 6 — **DONE (pending owner gate)**: three independent reviews (security/RLS/audit; correctness/
  concurrency/state-machine; scope/migration/taxonomy) — NO Critical/High; R2's 2 Medium (concurrent-retry
  authorization/audit gaps) FIXED STRUCTURALLY (retry_requested written in the executing step tx under an exact
  (step, attempt) Phase-A authorization; unauthorized failed rows halt); 6 further Lows fixed, 5 accepted with
  documented rationale (`docs/implementation/P1-012-REVIEW-COVERAGE.md` register). Architecture docs complete
  (PROVISIONING.md new; TENANCY/AUTHORIZATION/EVENT-CATALOG/AUDIT/DATA-ARCHITECTURE/API-CONTRACTS updated).
  Local gate green on the Slice 6 candidate (674 passed / 277 PG-dependent skips; build; audit; diff-check).

## P1-013 slice plan (CDR-019)
- Slice 1 — CDR-019 + planning + draft PR; contracts (AdminReason validation, AdminReadTarget,
  AdminCompanyOverview), `admin:tenant_read` authz (granted to NO membership role), `admin.tenant_read` audit
  registration + completeness partition; unit tests.
- Slice 2 — migration 0011 `platform_admins` (self-check SELECT only; zero mutation grants) + real-PG
  RLS/catalog/lifecycle tests + operational setup/revocation runbook stub.
- Slice 3 — private admin gate + transaction-local target-scope primitive + audited company-overview read
  (audit-before-response atomicity) + real-PG trust tests.
- Slice 4 — POST /api/admin/accounts/[accountId]/companies/[companyId]/read (strict body/query parsing) + web
  tests + production build.
- Slice 5 — concurrent/GUC/no-impersonation adversarial tests + docs (break-glass design; runbook; architecture
  updates) + independent reviews + final verification (owner gate).

## Next executable action
Phase 1 is complete and merged (`85fcb8f`). Begin Phase 2: `git fetch --prune`, confirm clean/equal
exact-main hosted-green state, inspect PR #10 via GitHub state only, read the Phase 2 backlog, and select the
first canonical Ready/unblocked ticket by dependency + milestone order (never by ticket number alone). Run
canonical discovery; when canon resolves every foundational decision and no mandatory owner gate applies, make
the least-authority reversible recommendation, record it, open one branch + draft PR, and implement in TDD
slices — each pushed, each exact-head hosted-green (zero-skip PG), independently reviewed before finalization,
squash-merged, exact-main-CI-verified, branch deleted — then continue to the next Ready/unblocked ticket.

## Local integration environment (learned 2026-07-24)
Local real-PostgreSQL runs ARE possible on this machine, contrary to the older "unrunnable" note below — two
things were in the way: (1) the dedicated WSL distro terminates when no process holds it open, so hold it with
a background `wsl -d acbp-local-dev … sleep N` for the duration of a run; (2) the local owner role lacked
CREATEROLE, so migration 0005 failed with "permission denied to create role" — CI's owner is a superuser, so
`alter role acbp_dev superuser createrole` on the disposable local distro matches CI. Hosted CI remains the
authoritative zero-skip gate; local runs are for fast feedback and for executing `pnpm demo:slice-a`.
