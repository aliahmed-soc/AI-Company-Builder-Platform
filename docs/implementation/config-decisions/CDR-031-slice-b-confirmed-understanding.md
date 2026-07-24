# CDR-031 — Slice B integration: confirmed understanding (ACBP-P2-012)

**Status:** Accepted (autonomous lead, standing Phase 2 authorization). **Requirements:** DISC-001, UNDER-001,
UNDER-003, MEM-001 (+ the M2/M3 exit demonstration). **Governing:** MILESTONE-PLAN §M2/M3, ADR-011 (gateway), ADR-019
(non-silent fallback). **Depends on:** P2-009 (Done) + P2-010 (Done) — and composes the already-merged P2-001/002/005/
006/008 use cases. **No owner gate; no live provider** (BACKLOG Usage = "Usage events verified", not billed).

The M2/M3 **Slice B** milestone-exit demonstration: an end-to-end founder-discovery journey
**interview → follow-ups → classification → understanding → edit → confirm**, proven against the deterministic
**FakeModelProvider** (CDR-026 §3) — no live model, no real key, no snapshot pin. This is a **vertical-slice
integration + runnable demo** ticket (type "Testing"): it wires and regression-guards the already-merged discovery/
understanding tickets (P2-001/002/003/005/006/008/009/010) into
one journey; it adds NO migration, NO new authz/audit event, NO new architecture/authorization/tenant-isolation
decision.

## 1. Home + no-drift (the Slice A precedent, CDR-021)

The journey is implemented ONCE as `runSliceBJourney` in **@acbp/test-support** (test-only; never a production
dependency — boundary rule 9) and consumed by BOTH the CI integration suite and a runnable demo (`pnpm demo:slice-b`),
so the two can never drift — exactly as `runSliceAJourney` backs the Slice A demo + suite. `@acbp/test-support` is
already permitted to import `@acbp/core` + `@acbp/adapters` (boundary allow-list), so the journey drives the exported
**use cases** directly (not HTTP routes): P2-008/P2-009 deferred their HTTP routes with the live provider (CDR-026 §0),
so — unlike Slice A, which drove real routes — Slice B composes the core use cases + the P2-003 gateway wired to the
fake provider. This is the honest surface: the engine is proven end-to-end; the request surface + live provider remain
the deferred owner gate.

## 2. The journey (every step records a falsifiable verdict + evidence; never throws for a failed step)

1. **Start interview** — `startInterviewSession` (not_started → in_progress); DISC-001.
2. **Adaptive follow-ups** — `generateAdaptiveBatch(focusArea)` persists ≤3 questions flagged `source='adaptive'`,
   metered; DISC-002/003.
3. **Classification — fact** — a CLEAR answer (`evaluateAnswer`) writes a `user_fact` typed memory item (MEM-001).
4. **Classification — assumption** — an "I don't know" (`suggestAssumptionForSkip`) writes a labeled `ai_assumption`
   memory item (facts vs assumptions remain distinct — UNDER-002/MEM-001).
5. **Resumability** — `suspendInterviewSession` → `resumeInterviewSession` round-trips the state
   (in_progress ⇄ waiting_for_user) and the Q&A is intact afterward (DISC-007 "resumability live-demoed").
6. **Understanding generated** — `generateUnderstanding` reads that typed memory and produces a versioned, classified
   document via the gateway (UNDER-001). (With the deterministic fake the model→document *derivation* is fixed, not
   exercised — the step proves the generation pipeline versions/classifies/persists + audits/meters; the live
   derivation is the deferred live-provider surface, CDR-026 §0.)
7. **Planning blocked pre-confirm** — `isCurrentUnderstandingConfirmed` = false (the strategy gate is closed).
8. **Edit** — `recordUnderstandingReview` (an `edited` decision on an item of the current version) records the
   owner's correction (UNDER-003).
9. **Confirm gates planning** — `confirmUnderstanding` flips the gate to true (strategy unlocked); audited.
10. **Corrections flag dependents** — `correctUnderstanding` supersedes the confirmation → gate false again
    (DISC-008 dependents flagged).
11. **Usage events verified** — one `usage_events` row per model call (metered, not billed — "Usage events verified").
12. **Trail verified** — the durable audit trail contains `interview.started`, `memory.item_created`,
    `understanding.generated`, `understanding.confirmed`, `understanding.corrected`, all tenant + actor stamped.
13. **NEGATIVE — fallback-flag demo (ADR-019):** (a) a follow-up generation FAILURE falls back to the static bank
    **flagged `static_fallback`** (honest, never silently presented as adaptive); (b) an understanding-generation
    FAILURE returns `generation_failed` and **persists nothing** (a generation-class task never silently falls back to
    a fabricated document). This is the "fallback-flag negative demo".

## 3. Verification

- **CI integration test** (`apps/web` or `packages/core` test tree) drives `runSliceBJourney` against the real
  isolated PostgreSQL under the restricted `acbp_app` role (dual-keyed FORCE RLS) and asserts every step ok. Zero
  skips on hosted CI.
- **Runnable demo** `pnpm demo:slice-b` runs the SAME journey, prints each step + evidence, exits non-zero on any
  failure (the BACKLOG "Run demo script" procedure + "demo doc").

## 4. Out of scope / deferred

Strategy generation + selection (Slice C / P3-001); the HTTP request surface + live provider (CDR-026 §0);
interview-session-state sync to the understanding confirmation gate (still P2-012-adjacent but the gate is the
authoritative signal — see CDR-030 §1; this journey demonstrates the gate at the version grain, the honest engine
surface). No new migration (0001–0020 untouched); no new authz action or audit event.
