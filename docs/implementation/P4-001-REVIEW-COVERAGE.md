# ACBP-P4-001 — Review coverage ledger (goals, roadmap and milestones)

Independent **security + scope + correctness** review of the full P4-001 diff (`p4-001-goals-roadmap-milestones` vs
`main` `766b674`): the planning contracts, the `planning.roadmap@1` template, migration 0026, `generateRoadmap` /
`editRoadmap`, and CDR-039 itself. Calibrated for the load-bearing invariants (the planning gate, ROAD-001's partial
honesty, ROAD-002's "version write failure blocks the edit rather than losing history"), tenant isolation, audit
privacy, and scope.

## Verdict
First pass **FAIL** — 1 High, 6 Medium, 8 Low. The High and all six Mediums are fixed; the Lows are fixed or
accepted-by-precedent below. Every invariant the reviewer verified as upheld is unchanged by the fixes.

## Dimensions — CLEAN (confirmed by the reviewer)
1. **The generation gate.** One exported `classifyPlanningGate` used by both call sites — no drift. The persist tx
   re-verifies it AND pins `gate.decision.id === pre.decision.id` and `latest.id === pre.supersedes`; a mid-call
   decision change returns `stale_decision` before any insert. `mode === 'reject'` blocks, so "a decision row exists"
   never unlocks planning — exactly CDR-038 §6-G1. A later rejection re-blocks new planning without touching existing
   versions.
2. **ROAD-002 history safety.** All four tables SELECT+INSERT only (proved at real PG: UPDATE and DELETE both
   rejected). The new version + goals + milestones + flags + `roadmap.edited` are all inside the single
   `runInCompanyScope` transaction — no write escapes it, no error is swallowed; the forced-audit-failure test proves
   full rollback with v1 intact.
3. **Authorization.** POLICY matches API-CONTRACTS exactly (generate/read = owner|viewer, edit = owner-only); authz
   precedes input validation in the edit path and is tested with a bad reason; the `expectedRoadmapId` guard fails
   closed. Viewer and non-member both denied.
4. **Privacy.** `roadmapGenerated`/`roadmapEdited` emit scalars only; both in-tx call sites and both logger calls carry
   scalars only. The user-supplied edit reason and all plan titles/descriptions never reach audit metadata or logs
   (`has_reason: true` boolean only).
5. **Partial honesty (wired path).** Gateway failure, malformed output, and empty plan each return `generation_failed`
   with zero rows and zero audit events; `status='partial'` derives solely from a strict boolean, never coerced.
6. **Migration 0026.** All four tables: ENABLE+FORCE RLS, dual-keyed fail-closed policies, SELECT+INSERT grants only,
   every schema column `never` on update. CHECKs on version, status, origin, the edit_reason shape, the supersedes
   chain, ordinals, title/description bounds and the flag reason. The composite `(goal_id, roadmap_id)` FK genuinely
   blocks a cross-VERSION goal link. `down()` drops `tasks_milestone_fk` before `milestones`, and the down/up
   round-trip is exercised.
7. **Scope.** No task generation, no milestone dates, no object storage, no HTTP route, no new SECURITY DEFINER (the
   catalog asserts exactly three), no new role, no BYPASSRLS. The reviewer independently confirmed **§7-G3** against
   CLAUDE.md's canonical source priority: the Backlog (#3) does outrank PRD acceptance criteria (#4), and the P4-001
   backlog row's Data column is `goals;roadmaps;milestones` with PLAN-001 assigned to P4-003.
8. **Reset-list / catalog hygiene.** All four tables present in all 38 reset lists, `ALL_TABLES`, `TENANT_TABLES`,
   `EXPECTED_GRANTS`, the no-column-UPDATE assertion, and the DB existence check. Delete ordering is
   `task_review_flags → task_dependencies → tasks → milestones → goals → roadmaps` in **every** list — tasks always
   precede milestones, as the new FK requires. Nothing missed.
9. **Encoding / diff hygiene.** Zero `c3 a2` sequences and zero BOMs across all changed files. `BACKLOG.csv` changes
   **exactly one row** (ACBP-P4-001 → Done) with no dependency-column collateral — the P3-005 regex lesson held.

## Findings dispositioned
- **HIGH-1 (fixed) — `editRoadmap` reached a roadmap INSERT with no planning gate.** After a `reject` decision,
  `generateRoadmap` correctly returned `decision_rejected` but an edit still succeeded, making the company's CURRENT
  roadmap one authored *after* the strategy was rejected — contradicting CDR-039 §2 ("J-08 … is enforced here") and
  WORKFLOW's `→rejected` routing back to understanding review. **Fixed:** the edit path applies the same
  `classifyPlanningGate` and returns `decision_rejected`, ratified as **CDR-039 §7-G9**, with a real-PG test proving a
  rejection cannot be side-stepped by revising.
- **MEDIUM-1 (fixed) — `narrowRoadmapOutput` was a strictly weaker backstop than the parse.** It checked types only,
  so a caller wiring a different/missing gateway validator could persist an empty plan labeled `complete`, or a title
  only the DB would reject (surfacing a raw constraint error instead of `generation_failed`). **Fixed** by extracting
  `roadmapShapeOk` and applying it in BOTH the parse and the narrow (**§7-G10**), with unit tests.
- **MEDIUM-2 (fixed) — a milestone-less plan could be labeled `complete`.** The parse rejected only when *both* arrays
  were empty, so `{goals:[…], milestones:[]}` persisted as complete, violating ROAD-001's acceptance. **Fixed:** a
  one-sided plan is legal ONLY when honestly labeled `partial` (**§7-G11**).
- **MEDIUM-3 (fixed) — `tasks_milestone_fk` was not tenant-pinned.** RI checks bypass RLS, so company B could create a
  task naming company A's milestone (existence oracle; cross-tenant `SET NULL` when A dropped that version) — a
  tenant-isolation weakening newly introduced by this migration. **Fixed:** added `UNIQUE(id, company_id)` on
  `milestones` and made the FK `(milestone_id, company_id) → milestones(id, company_id)` with a column-scoped
  `ON DELETE SET NULL (milestone_id)` so the task's tenancy is never nulled (**§7-G14**); real-PG test added.
- **MEDIUM-4 (fixed) — a concurrent version conflict surfaced as a raw constraint error.** Both guards run at READ
  COMMITTED, so two writers can pass and the loser hit `roadmaps_company_version_uq`. **Fixed** with
  `isRoadmapVersionConflict`, scoped to that EXACT constraint (never a blanket 23505, per CLAUDE.md), mapping to
  `stale_decision`/`stale_version` (**§7-G13**).
- **MEDIUM-5 (fixed) — re-flagging silently stopped after the first revision.** The flag query keyed on the superseded
  version, but tasks are never re-pointed, so a second edit found nothing and a two-revisions-stale task was never
  flagged again. **Fixed:** the query is company-scoped (**§7-G12**), with a real-PG test proving a second revision
  still flags.
- **MEDIUM-6 (fixed) — `CLOSED_TASK_STATES` restated the contract.** A hand-copied list would misclassify a
  newly-added terminal state as "open". **Fixed** by deriving `TERMINAL_TASK_STATES` from the transition table and
  consuming it.
- **LOW-1 (fixed)** — `insertTaskReviewFlag` is now genuinely idempotent (`ON CONFLICT DO NOTHING`), matching the
  migration comment. **LOW-2 (fixed)** — the blank-reason CHECK is now proved on a *different* (task, version) pair so
  the UNIQUE constraint cannot fire first and let it pass for the wrong reason. **LOW-6 (fixed)** — generation now
  fails closed when the decided content cannot be resolved, rather than asking the model to plan from a bare mode +
  version line. **LOW-7 (fixed)** — an unresolvable goal ordinal throws rather than silently unlinking the milestone.
- **LOW-3 (accepted)** — the `ON DELETE SET NULL` path is exercised via the superuser because the app role has no
  DELETE on `roadmaps`, so the product path is unreachable; the test still pins the column-scoped behaviour.
- **LOW-4 (accepted, recorded)** — API-CONTRACTS names `expected_version` as the concurrency token; the code uses
  `expectedRoadmapId`, which is equivalent-or-stronger (an id pins the exact row, a number could collide across a
  regenerate). Recorded here rather than silently diverging.
- **LOW-5 / LOW-8 (accepted, precedent)** — `latestDecisionForCompany` tie-breaks on a random UUID (matches every
  sibling `latest*` reader), and `roadmaps_supersedes_fk` is self-referential CASCADE (unreachable: the app role has no
  DELETE grant on `roadmaps`).

## Status
Re-verified after the fixes: recursive typecheck + lint + secrets + boundaries clean; contracts planning + task unit
suites green; the real-PG planning (13), roadmap-generation (12) and roadmap-edit (9) suites discovered and
structurally green (local PG unreachable → skipped). Hosted exact-head CI on the exact SHA is the authoritative
zero-skip run.
