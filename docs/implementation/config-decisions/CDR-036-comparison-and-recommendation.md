# CDR-036 — Comparison and AI recommendation (ACBP-P3-003)

**Status:** Accepted (autonomous lead, standing authorization). **Requirements:** STRAT-004 ("The system MAY recommend
one option, always with explicit rationale and its key sensitivities … shows why, what would change it, and NEVER
auto-selects … Absent a defensible rationale, no recommendation is shown"; priority **Should**). **Governing ADR:**
ADR-019 (anti-fabrication / honest degradation), ADR-011 (structured generation). **Architecture:** PRD J-07 line 373
("side-by-side comparison, optional AI recommendation with rationale"), diagrams/05 `present` node (recommendation lives
in presentation, upstream of the owner `choice`), API-CONTRACTS (Strategy options → "AI recommendation + rationale"),
AI-AND-WORKER §2 (the Strategy worker is a model producer). **Depends on:** P3-001 (strategy generation, Done). **No
open question blocks it** (see §6 for ratified design decisions). No live model (FakeModelProvider; live HTTP deferred
CDR-026 §0), no owner gate.

Add the **optional AI recommendation** over a generation's genuinely-distinct options (P3-001/P3-002). The recommendation
is **advisory** — it recommends ONE option with an explicit rationale + key sensitivities, or honestly abstains; it
**never selects** anything and unlocks nothing. The "comparison / side-by-side" is a READ over the already-persisted
distinct options (no new state); the UI is deferred (the HTTP-route precedent).

## 1. What P3-003 IMPLEMENTS
- **`recommendStrategy(generationId)` (core):** load the generation + its persisted distinct options (company-scoped)
  → call the P2-003 GATEWAY (injected, FakeModelProvider; live deferred) with the options rendered → validate the
  model's recommendation → persist ONE immutable `strategy_recommendations` row, OR (honest abstain / invalid) persist
  NOTHING. The model call runs BETWEEN scoped operations (never in a held tx), like `generateStrategyOptions`. Metered by
  construction (every gateway call emits a usage event).
- **The comparison read:** surface the latest recommendation on the strategy read (an optional `recommendation` field on
  `StrategyGenerationDTO`, or a sibling). `getLatestStrategyGeneration` already returns every option's 16-field object +
  ordinal — that IS the side-by-side dataset.

## 2. The two STRAT-004 guards (load-bearing)
- **"Never auto-selects" — STRUCTURAL.** P3-003 writes NO selection, NO decision record, sets NO "chosen"/"selected"
  flag, triggers NO state transition or planning unlock. A recommendation row merely *references* an option id. Selection
  is P3-004's owner-only action (`strategy.selected`); decision records are P3-005 (`decision.recorded`).
- **"Absent a defensible rationale, no recommendation is shown" — DENY-BY-DEFAULT.** A recommendation is accepted (and
  persisted) ONLY when the model (a) names exactly one option that EXISTS in this generation's distinct set (ordinal in
  `[0, option_count)`), (b) supplies a non-blank, bounded **rationale** ("why"), and (c) supplies a non-blank, bounded
  **sensitivities** ("what would change it"). Any miss → **abstain**: nothing is persisted; the read shows
  `recommendation: null`. The model may also explicitly abstain (recommended ordinal `null`).

## 3. Schema — migration 0023 (additive; one table)
Additive (0001–0022 untouched; **no new SECURITY DEFINER** — allowlist stays three; no new role; no BYPASSRLS). One
company-owned, dual-keyed FORCE-RLS, **immutable (`I`)** table (the `strategy_generations`/`strategy_options` pattern —
SELECT + INSERT only; append-only — a re-recommendation is a NEW row, latest-wins on read; "no recommendation" =
ABSENCE of a row):
- `strategy_recommendations`: `id`, `account_id`, `company_id`, `generation_id` (FK strategy_generations cascade),
  `recommended_option_id` (FK strategy_options — the recommended option; the core validates it belongs to the
  generation), `rationale` (text, bounded 1..RATIONALE_MAX), `sensitivities` (text, bounded 1..SENSITIVITIES_MAX),
  `created_by_user_id`, `created_at`. Dual-keyed fail-closed RLS. No UNIQUE(generation_id) (append-only history).

Every schema-reset list + the two-tenant harness `ALL_TABLES` + every catalog/grant assertion is updated in the SAME
slice (the P2-003 reset-list lesson); FK-safe drop order = before `strategy_generations` / `strategy_options`.

## 4. Audit + authz
- **Audit: NONE.** BACKLOG P3-003 "Audit behavior" = `—`; EVENT-CATALOG registers no `strategy.recommended`; the
  recommendation changes NO state, selects nothing, and is informational-class — not a high-risk lifecycle transition.
  The only durable trace is the automatic gateway usage event (`model.call_completed`). A future `strategy.recommended`
  event would be a NEW registered event = a new decision (owner gate) — NOT added here.
- **Authz:** reads reuse `strategy:read` (owner|viewer). The recommendation trigger is a new closed action
  `strategy:recommend` (owner|viewer) — consistent with the generate-class grants (`understanding:generate`,
  `strategy:generate` are owner|viewer; the owner-only hard gate in canon is SELECTION, P3-004). DISTINCT closed action,
  deny-by-default (the repo's strict per-operation convention).

## 5. Slice plan
1. CDR + recommendation contracts (parse/validate + abstain + DTO + `strategy.recommend@1` template) +
   `strategy:recommend` authz + adversarial unit tests.
2. Migration 0023 (strategy_recommendations) + repo/schema + every reset list/catalog + real-PG RLS/privilege/lifecycle.
3. Core `recommendStrategy` (gateway → validate → persist or honest abstain; never auto-selects; metered) + the read +
   real-PG integration.
4. Docs + review + finalize.

## 6. Ratified design decisions (canon-derived; documented, not guessed)
- **G-1 "defensible rationale" (undefined in canon):** ratified as the STRUCTURAL bar in §2 (one option-in-range +
  non-blank bounded rationale + non-blank bounded sensitivities + honest abstain). NO semantic-quality judge is invented
  (that would itself be a model call with no canon basis). Deny-by-default: uncertainty → no recommendation.
- **G-2 (BACKLOG Usage cell blank):** STRAT-004 is literally an "AI recommendation" → a MODEL call, metered by
  construction. The blank cell is reconciled as "model usage metered." A deterministic recommendation would contradict
  "AI recommendation" and could not honestly produce a rationale/sensitivities.
- **G-3 (PRD J-07 actor "owner" vs generate-class owner|viewer):** ratified `strategy:recommend` = **owner|viewer**,
  consistent with the other advisory generate-class grants; the recommendation is advisory (no state change), and the
  owner-only hard gate is drawn at SELECTION (P3-004). J-07's "owner" describes who drives the decision journey, not a
  per-action restriction.

## 7. Out of scope / deferred
Selection / edit / combine / reject / request-another + phase-limited approval (P3-004, STRAT-003/005); the immutable
decision record + `decision.recorded` (P3-005, STRAT-006); the comparison/recommendation UI + HTTP route (deferred with
the live provider, CDR-026 §0); a `strategy.recommended` audit event (a new decision — owner gate); any re-run of the
distinctness check (P3-002). No migration 0024.
