# CDR-028 — Adaptive question orchestration (ACBP-P2-005)

**Status:** Accepted (autonomous lead, standing Phase 2 authorization). **Requirements:** DISC-001..DISC-006.
**Governing ADRs:** ADR-011 (gateway contract), ADR-019 (model config + non-silent-fallback), ADR-015 (audit).
**Architecture:** diagrams/04, AI-AND-WORKER-ARCHITECTURE.md §1, INTERVIEW.md. **Depends on:** P2-003 (gateway),
P2-002 (Q&A), P2-006 (typed memory), P2-004 (template registry) — all Done. **No open question blocks it.**

The adaptive interview loop (diagram 04, `batch → ask → answer/IDK/pause → vague/contradiction check → store to
typed memory → required-fields? → loop`). P2-005 owns everything from **batch generation through store**; the
understanding document (`gen`) is P2-008 and review is P2-009 (out of scope). All model calls go through the
P2-003 gateway using the **deterministic FAKE provider** — building + testing an interview orchestration is
autonomous. **Live generation stays behind the pre-existing owner gate CDR-026 §0** (real key + `gpt-5.1`
snapshot pin + ADR-019 §13 eval gate); nothing here makes a production model call.

## 1. Batch generation (DISC-001, DISC-002)

A batch is **at most three** follow-up questions (`MAX_FOLLOWUP_BATCH = 3`). The orchestrator reads the session's
prior **answers** (P2-002 `getSessionQa`) directly, fills the `interview.followups@1` template
(`prior_answers`, `focus_area` slots — P2-004), and calls the gateway (`taskClass: generation`). The model output
is validated against `INTERVIEW_FOLLOWUPS_SCHEMA` → `{questions: string[]}` with **1..3 bounded, non-blank**
questions. **More than three is rejected** (never silently truncated → `invalid_output` → bounded re-ask). Full
context assembly (provenance-ranked memory + secret blocklist + MEM-004 precedence) is **P2-007**, not P2-005 —
consistent with the template-registry note that P2-005 consumes the template's own segments.

## 2. "Why we ask" rationale (DISC-006)

Each generated question is persisted with a **rationale** — a concise, honest explanation of why it is being
asked. In v1 the rationale is set **deterministically by the orchestrator per batch** (derived from the focus
area, e.g. "Follow-up on <focus_area> to understand your business."), NOT model-generated — this keeps the model
output minimal (just questions) and guarantees a truthful, non-hallucinated rationale. (A later template version
may have the model justify each question; deferred — additive.)

## 3. Vague / contradiction detection (DISC-003, DISC-004)

Model-assisted, per the diagram. A submitted answer is checked via a gateway call
(`ANSWER_QUALITY_SCHEMA` → `{verdict: 'clear'|'vague'|'contradictory', detail}`):
- **vague** → return ONE clarifying prompt (`detail`) + examples; the answer is NOT yet stored to memory (the
  founder re-answers). One clarify pass per answer (no unbounded loops).
- **contradictory** → surface the conflict (`detail`) back to the founder as a question — **never a silent
  override** (MEM-004 spirit); the founder resolves it. No memory is written on a contradiction. Per the backlog,
  P2-005's audit column is "Model usage metered" — the accountability is the fail-closed metered model call; a
  registered conflict-EVENT audit is P2-007 ("Conflict events audited"), not P2-005.
- **clear** → store the answer to typed memory (P2-006 `createMemoryItem`, `user_fact`/`constraint`/… by the
  interview source path).
Detection is exercised by **seeded-defect / scripted-session** tests against the fake provider (backlog
acceptance "seeded vagueness/contradiction caught").

## 4. "I don't know" → labeled assumption (DISC-005)

When the founder answers "I don't know" (the P2-002 `skipped` answer status), the orchestrator asks the model for
a **labeled assumption** (`ASSUMPTION_SCHEMA` → `{assumption}`), then writes it as a typed memory item —
`type = ai_assumption`, `source_type = model_generation` (the type-by-source-path CHECK permits a generated source
to carry `ai_assumption`). The assumption is clearly labeled as an assumption (never stored as a `user_fact`).

## 5. Fallback static bank flagged non-adaptive (DISC-002; "Generation failure = flagged fallback")

If batch generation FAILS (the gateway returns a non-`ok` outcome — timeout / provider_unavailable /
invalid_output after re-ask), the orchestrator falls back to a small **static question bank** and persists those
questions with `source = 'static_fallback'` (flagged non-adaptive). A successful adaptive batch is
`source = 'adaptive'`. This is honest degradation, never a silent adaptive-looking result. No silent model
fallback is involved (that is the provider fallback of ADR-019/P5-009; here it is the ORCHESTRATOR's static bank).

## 6. Schema — migration 0018 (`interview_questions` additive columns)

Additive (0001–0017 untouched; no new SECURITY DEFINER — still three; no BYPASSRLS; no owner runtime). Two
columns on the immutable, SELECT+INSERT-only `interview_questions` table (set at INSERT, never updated):
- `rationale text` (nullable — the "why we ask"; bounded length CHECK).
- `source text NOT NULL DEFAULT 'adaptive'` with a CHECK in `('adaptive','static_fallback')` (the flagged-fallback
  marker). Default keeps the P2-002 `addInterviewQuestion` primitive backward-compatible.
No new grant beyond the existing SELECT+INSERT; the dual-keyed FORCE-RLS policies are unchanged.

## 7. Metering + audit + tenancy

Every model call meters usage (the gateway writes `usage_events`, fail-closed — P2-003); that IS P2-005's audit
per the backlog ("Model usage metered"). The orchestration composes the existing SCOPED primitives (getSessionQa,
addInterviewQuestion, createMemoryItem), each running under `runInCompanyScope` (the restricted `acbp_app` role,
dual-keyed RLS) — the model call happens BETWEEN scoped operations, never inside a held transaction. Memory
writes reuse `createMemoryItem` (audited `memory.item_created`). NO new audit event is registered in P2-005; the
conflict-EVENT audit is P2-007.

## 8. Slice plan

1. **Contracts**: output-schema refs + `parseFollowUps`/`parseAnswerQuality`/`parseAssumption` (deny-by-default) +
   the `QuestionSource` vocabulary + this CDR. (unit-tested)
2. **Migration 0018** `interview_questions.rationale` + `.source` + repo/schema extension + real-PG suite.
3. **Core orchestration** (`generateFollowUpBatch`, `checkAnswerQuality`, `suggestAssumption`, static fallback)
   with the gateway dependency injected; unit tests against the fake provider (≤3, seeded vague/contradiction,
   assumption-on-skip, fallback-flag-on-failure).
4. **Composition** (bound gateway + schema-dispatching validateOutput) + real-PG integration (persist with
   rationale/source under RLS; usage metered; assumption → memory item; contradiction audited).
5. **Adversarial/negative + docs** (INTERVIEW.md, AI-AND-WORKER, template registry) + reviews + finalize.

**HTTP routes — deferred with the live provider (decision).** Unlike P2-002's Q&A routes (pure persistence,
no model), every P2-005 orchestration endpoint invokes model generation, which is the **deferred owner gate
CDR-026 §0** (no real key / snapshot pin / eval gate). A single fake provider cannot honestly serve the three
distinct output schemas, and an interview-generation endpoint that only ever returns the static fallback adds no
verifiable value while the provider is deferred. So — mirroring how P2-003 shipped its gateway as an internal
service with **no HTTP route** — P2-005 ships the complete, fully-proven orchestration ENGINE + its composition
seam (`interviewOutputValidator`), and the thin HTTP wrapper (runtime methods + `*ForRequest` + routes) is
sequenced with the live-provider wiring. The adaptive behaviour (≤3, seeded vague/contradiction, assumption on
skip, static-fallback flag) is proven end-to-end by the **scripted real-PG integration suite** through the
composed gateway — the backlog's "scripted session" verification.

## 9. Out of scope / deferred

Understanding generation (P2-008), review/confirm (P2-009), context assembly + secret blocklist + MEM-004 full
precedence (P2-007), the evaluation suite (P2-011), live provider wiring (CDR-026 §0), the provider fallback
adapter (P5-009). No new HTTP verb beyond the interview API surface. No change to the P2-002 answer model (skip =
"I don't know" reuses the existing `skipped` status).
