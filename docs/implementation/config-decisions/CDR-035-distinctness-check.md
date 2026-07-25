# CDR-035 — Distinctness check (ACBP-P3-002)

**Status:** Accepted (autonomous lead, standing authorization). **Requirements:** STRAT-001 ("≥3 genuinely distinct
strategic options (different customer, offer, or model — not cosmetic variants); a similarity check rejects
near-duplicates; fewer than 3 viable options is stated honestly with reasons rather than padded"). **Governing ADR:**
ADR-019 (anti-fabrication / honest degradation). **Architecture:** PRD §11.3 + J-07 ("options differ on
customer/offer/model; similarity check passes"), MASTER-PRD §103 anti-pattern ("the same plan with different titles"),
AI-AND-WORKER-ARCHITECTURE §1 (the similarity check is DOMAIN OUTPUT VALIDATION — a post-schema check, alongside
field-completeness and citation-presence), WORKFLOW-STATE-MACHINES §4 (`generating → ready_for_review`: "≥3 distinct
options passing similarity check, OR honest fewer-with-reasons"). **Depends on:** P3-001 (strategy generation, Done).
**No open question blocks it** (canon fully specifies distinctness — see §1). No live model, no metering, no owner gate.

Add the **similarity / distinctness check** that P3-001 deferred (P3-001 recorded `similarity_check_result = 'pending'`).
It rejects **cosmetic variants** — "the same plan with different titles" — so a strategy set only counts as ≥3 options
when at least three are **genuinely distinct**; otherwise the outcome is the honest fewer-with-reasons path.

## 1. The distinctness definition (canon, verbatim)
Two options are **genuinely distinct** IFF they differ on **at least one of the three axes** `customer`, `offer`,
`business_model` (STRAT-001; PRD J-07 "options differ on customer/offer/model"). A **cosmetic variant / near-duplicate**
is an option that matches another on **all three** axes (only the title / prose differs — MASTER-PRD §103 "the same plan
with different titles"). This is a **deterministic, model-free** post-schema check (AI-AND-WORKER §1) — no embeddings, no
metering. Normalization (case-fold, trim, internal-whitespace collapse) catches trivial rewording of the axis values;
semantic paraphrase beyond that is not part of STRAT-001's bar and is not attempted here.

## 2. What P3-002 IMPLEMENTS
- **Contract (pure):** `DISTINCTNESS_AXES = ['customer', 'offer', 'business_model']`; `distinctnessKey(fields)` (the
  normalized 3-axis key); `dedupeByDistinctness(options)` → `{ distinct: StrategyOptionFields[], result:
  SimilarityCheckResult, duplicatesRejected: number }` — groups options by their distinctness key, keeps the FIRST
  representative of each group (model ordering preserved), and yields `result = 'distinct'` when ≥3 distinct groups
  exist else `'insufficient_distinct'`. Adversarial-fixture unit tested.
- **Core wiring:** `generateStrategyOptions` runs `dedupeByDistinctness` after 16-field validation and BEFORE persisting
  — it persists ONLY the distinct set (re-ordinaled `0..n-1`), sets `option_count` = distinct count, derives `status`
  from the distinct count (`complete` iff ≥3), records the real `similarity_check_result` (never `'pending'` again), and
  when near-duplicates collapsed the set below three writes an **honest** `fewer_reason` derived from the check (factual
  — "N genuinely distinct option(s); the rest were near-duplicates on customer/offer/business_model" — never fabricated,
  ADR-019). The near-duplicates are REJECTED (not persisted) — the transparency record is the distinct set + the honest
  verdict/reason, exactly STRAT-001's "near-duplicates rejected honestly".

## 3. Schema / audit / authz — NO change
No new table or column (BACKLOG "Data objects: —"): the `similarity_check_result` column + its closed enum already exist
(migration 0022); P3-002 only writes the real verdict into it. The P3-001 DB CHECK `(complete ∧ option_count ≥ 3) ∨
(fewer_than_three ∧ option_count < 3)` STILL HOLDS because only the distinct set is persisted (`option_count` = distinct
count). No migration (migrations stay at 0022). No new audit event (`strategy.generated` already carries
`similarity_check_result`; BACKLOG "Check result recorded"). No new authz (reuses `strategy:generate`/`:read`).

## 4. Slice plan
1. CDR + distinctness contract (`dedupeByDistinctness` + axes + normalization) + adversarial unit tests.
2. Core wiring into `generateStrategyOptions` (persist distinct set; real verdict; honest reason) + update the P3-001
   integration fixtures (identical → genuinely distinct) + adversarial real-PG integration.
3. Docs + review + finalize.

## 5. Out of scope / deferred
Semantic/embedding near-duplicate detection beyond normalized-axis equality (not required by STRAT-001); comparison + AI
recommendation (P3-003, STRAT-004); selection/edit/combine/approval (P3-004); decision records (P3-005); the
distinctness EVAL area (P3-006, gated on P2-011). No migration 0023.
