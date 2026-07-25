# CDR-034 — Strategy option generation (ACBP-P3-001)

**Status:** Accepted (autonomous lead, standing authorization). **Requirements:** STRAT-001 (≥3 genuinely distinct
options; honest fewer-than-3 path), STRAT-002 (the 16-field option content standard; no fake precision — unknown fields
labeled). **Governing ADRs:** ADR-011 (structured model generation), ADR-019 (anti-fabrication / honest degradation).
**Architecture:** PRD §11.3, diagrams/05-strategy-decision-flow (`gen` node), AI-AND-WORKER-ARCHITECTURE §2 (strategy
worker), DATA-ARCHITECTURE (Decision/strategy options), EVENT-CATALOG (`strategy.generated`). **Depends on:** P2-009
(understanding confirm gate, Done), P2-008 (understanding, Done), P2-003 (model gateway, Done). **No open question
blocks it.** No live model (deterministic FakeModelProvider now; the live provider is the already-established deferred
gate CDR-026 §0, exactly as P2-008/P2-009). No owner gate.

Generate a set of strategy **options** from the company's **confirmed** understanding version. Each option carries the
**16-field content standard**; the set is presented only when ≥3 genuinely distinct options exist, otherwise the system
states honestly why fewer (STRAT-001 — no padding). Options are **immutable** once written. This ticket implements the
`gen` node of the strategy flow; the rigorous cosmetic-variant **distinctness engine** (STRAT-001 similarity check that
*rejects* near-duplicates) is **P3-002**, and comparison/recommendation (STRAT-004), selection/edit/combine (STRAT-003),
phase-limited approval (STRAT-005), and the immutable decision record (STRAT-006) are **P3-003/004/005** — the
`interview.ts`/`P2-008` precedent (define the full contract now; implement this ticket's effect only).

## 1. The 16-field option content standard (PRD §11.3, verbatim)
`description · customer · offer · business_model · scope · benefits · risks · cost_range · effort · time_to_validate ·
time_to_launch · required_resources · key_assumptions · validation_method · success_metrics · confidence`. Exactly 16.
**ADR-019 no-fake-precision:** every field is REQUIRED to be present, but a field the model cannot determine MUST carry
the explicit sentinel `"unknown"` (labeled), never a fabricated value. The contract validator (`parseStrategyOptions`)
rejects an option missing any of the 16 keys or with an empty/whitespace value; `confidence` is one of the 16 (the
option's self-reported confidence, a bounded label). The honesty obligation is also pinned in the generation template.

## 2. What P3-001 IMPLEMENTS vs. defines
- **Executed now:** `generateStrategyOptions` — gate on `isCurrentUnderstandingConfirmed` (strategy is BLOCKED until the
  owner confirms understanding — UNDER-003/P2-009); read the confirmed understanding + typed memory → call the injected
  gateway (registered template `strategy.options@1` + the strategy-options output schema) → validate ≥3 options each
  16-field (else the honest `fewer_than_three` status + a bounded reason) → persist ONE immutable generation + its
  options + `strategy.generated` in a SINGLE company-scoped transaction (audit-or-nothing); usage metered by the gateway.
  `listStrategyOptions` / `getStrategyGeneration` reads (owner+viewer). "Request another" = a NEW generation (never a
  mutation); the latest generation is the current option set.
- **Defined now, effect DEFERRED:** `similarity_check_result` (closed enum `pending | distinct | insufficient_distinct`)
  is written `pending` by P3-001; the **P3-002** distinctness engine evaluates it. The 16-field schema is fully defined
  and validated now.
- **Out of scope (later tickets):** distinctness/cosmetic-variant rejection (P3-002); comparison + AI recommendation
  (P3-003, STRAT-004); selection/edit/combine/reject + phase-limited approval (P3-004, STRAT-003/005); the immutable
  decision record + `decision.recorded` (P3-005, STRAT-006); the HTTP route (deferred with the live provider, CDR-026 §0);
  planning objects (P4-001). No migration 0023.

## 3. Schema — migration 0022 (additive; two tables)
Additive (0001–0021 untouched; **no new SECURITY DEFINER** — allowlist stays three; no new role; no BYPASSRLS). Two
company-owned, dual-keyed FORCE-RLS, **immutable (`I`)** tables (the `understanding_documents`/`usage_events` pattern —
SELECT + INSERT only; a re-generation is a new row, never an in-place edit):
- `strategy_generations`: `id`, `account_id`, `company_id`, `understanding_document_id` (FK understanding_documents),
  `understanding_version` (int), `status` (text CHECK `complete | fewer_than_three`), `option_count` (int ≥ 0),
  `fewer_reason` (nullable, bounded — set only when `fewer_than_three`; a labeled reason, never fabricated content),
  `similarity_check_result` (text CHECK `pending | distinct | insufficient_distinct`, default `pending`),
  `model_flagged_partial` (bool — the gateway's honest partial flag, ADR-019), `created_by_user_id`, `created_at`.
- `strategy_options`: `id`, `account_id`, `company_id`, `generation_id` (FK strategy_generations cascade), `ordinal`
  (int; UNIQUE `(generation_id, ordinal)`), `fields` (jsonb — the validated 16-field object; contract-validated at
  write, all 16 keys present), `created_at`. UNIQUE `(generation_id, ordinal)`. A cross-company option is impossible
  (FK + the dual key confine to one company).

Every schema-reset list + the two-tenant harness `ALL_TABLES` + every catalog/grant assertion is updated in the SAME
slice (the P2-003 reset-list lesson).

## 4. Audit + authz
- **Audit (ADR-015):** `strategy.generated` (subject = the generation id; bounded metadata `{understanding_version,
  option_count, similarity_check_result}` — NEVER option content/fields/reason text) written in-tx with the generation
  (audit-or-nothing). The other `strategy.*` events (`strategy.selected`, `decision.recorded`) are registered by the
  tickets that implement their transitions (incremental per-ticket registration — the memory/understanding precedent).
- **Authz:** `strategy:generate` (generate + request-another) and `strategy:read` — checked against the caller's
  COMPANY-membership role. MVP grant: both `owner|viewer` (any active member drives discovery→understanding→strategy
  generation, like `understanding:generate`; the owner-only SELECTION gate is STRAT-003/P3-004, a later ticket). DISTINCT
  closed actions; deny-by-default.

## 5. Slice plan
1. Contracts (16-field schema + StrategyOption/Generation DTO + parse/validate + similarity-result enum + gateway
   template `strategy.options@1` + output schema) + `strategy.generated` audit + `strategy:generate`/`:read` authz + CDR.
2. Migration 0022 (strategy_generations + strategy_options) + repo/schema + every reset list/catalog + real-PG
   RLS/privilege/lifecycle.
3. Core `generateStrategyOptions` (confirm gate → gateway → validate → persist + audit + meter, audit-or-nothing) +
   `listStrategyOptions` + real-PG integration (gated pre-confirm; 16-field/no-fabrication; fewer-than-3 honest;
   cross-tenant; audit-or-nothing).
4. Docs + review + finalize.

## 6. Out of scope / deferred
Distinctness engine (P3-002); comparison/recommendation (P3-003); selection/edit/combine/approval (P3-004); decision
records (P3-005); HTTP route + live provider (CDR-026 §0); planning objects (P4-001). No migration 0023.
