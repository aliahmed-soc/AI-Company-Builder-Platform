# ACBP-P3-003 — Review coverage ledger (comparison + AI recommendation)

Independent **security + scope + correctness** review of the full P3-003 diff (`p3-003-comparison-recommendation` vs
`main`): the recommendation contracts (`@acbp/contracts/strategy`), migration 0023 (`strategy_recommendations`), and the
core use case (`@acbp/core/strategy`). Calibrated for the two load-bearing STRAT-004 guards (never auto-selects; no
defensible rationale → no recommendation), tenant isolation, immutability, and scope.

## Verdict
**PASS — no Blocker/Critical/High.** All nine dimensions clean; four Low/informational notes. Three fixed, one accepted.

## Dimensions — CLEAN (confirmed)
1. **Never auto-selects.** `recommendStrategy` writes exactly ONE `strategy_recommendations` row and nothing else — no
   selection, no decision record, no chosen/selected flag, no state transition, no planning unlock. Advisory only.
2. **No defensible rationale → no recommendation.** `resolveRecommendation` is strict deny-by-default (integer ordinal
   in range + non-blank bounded rationale + non-blank bounded sensitivities; else null → nothing persisted,
   `recommendation: null`). The parse/narrow/resolve split is correct: the gateway validates the camelCase shape, the
   core re-narrows that already-validated value WITHOUT re-parsing raw text (`narrowStrategyRecommendation`), then
   resolves. `narrowStrategyRecommendation` can't be tricked (rejects non-object / non-integer / non-string).
3. **Tenant isolation / RLS.** `strategy_recommendations` is `ENABLE`+`FORCE` RLS, dual-keyed on both account + company
   in USING + WITH CHECK; the recommended option id is derived internally from `listOptions(generationId)` (never caller
   input). Cross-company read/write/attempt proven impossible.
4. **Least privilege / immutability.** Grant is exactly SELECT+INSERT (no UPDATE/DELETE, no column grant, no grant
   option); append-only; every column `never`-on-update; no new SECURITY DEFINER (allowlist stays 3) / role / BYPASSRLS.
5. **Audit / metering.** NO new audit event registered (correct per CDR-036 §4); the model call is metered by the
   gateway (usage event); the DTO + logs carry no accountId/actor id/option content/PII.
6. **Model/gateway discipline.** FakeModelProvider only; the model call runs BETWEEN scoped transactions (never in a
   held tx); a gateway failure or corrupted seam value → `recommendation_failed`, nothing persisted.
7. **Scope.** Matches CDR-036 §1 exactly — recommend + surface-on-read only; no selection/edit/combine/approval (P3-004),
   no decision record (P3-005), no comparison UI/HTTP route, no re-run of distinctness (P3-002); the generation is not
   mutated. `strategy:recommend` is a distinct closed action.
8. **Reset-list hygiene.** `strategy_recommendations` added to the two-tenant-harness `ALL_TABLES`, catalog.adversarial
   TENANT_TABLES + grant + column-privilege expectations, the database existence assertions, and every per-suite drop
   list — all FK-safe (before `strategy_options`/`strategy_generations`).

## Findings dispositioned
- **LOW-1 (fixed) — `recommended_option_id` had no DB-level tie to `generation_id`.** The single-writer always derived
  the option from the generation, but the FK only guaranteed the option EXISTED. **Fixed:** migration 0023 adds a
  `UNIQUE(id, generation_id)` on `strategy_options` and makes the recommendation's option FK COMPOSITE —
  `(recommended_option_id, generation_id) → strategy_options(id, generation_id)` — so a cross-generation recommendation
  is impossible at the DB. Real-PG test added (an option from a different generation is refused).
- **LOW-2 (fixed) — index-vs-ordinal coupling.** The write path resolved the model's ordinal as `pre.options[ordinal]`
  (array index), correct only because ordinals are contiguous `0..n-1`. **Fixed:** it now resolves the option by
  `pre.options.find(o => o.ordinal === ordinal)` — robust even if ordinals were ever non-contiguous.
- **LOW-4 (fixed) — a concurrent cascade-delete would surface as an FK-violation throw** (the generation deleted between
  the read and the persist). **Fixed:** the persist transaction re-verifies the generation still exists and returns a
  clean `not_found` instead of a raw throw (robustness parity with `generateStrategyOptions`).
- **LOW-3 (accepted) — latest-wins tiebreaker on a random UUID.** `latestRecommendation` orders by `created_at desc, id
  desc`; under an identical `created_at`, `id desc` on a `gen_random_uuid()` is non-deterministic. Accepted: it matches
  the established `latestGeneration` precedent and is practically unreachable (separate user actions → distinct
  transaction timestamps). Not diverging from the precedent for a Low.

## Status
Re-verified after the fixes: recursive typecheck + lint + secrets + boundaries clean; full unit suite green; real-PG
recommendation 7/7, migration 7/7 (incl. the composite-FK cross-generation test), and the P3-001 migration + catalog +
existence suites 74/74 (the new `strategy_options` unique constraint disturbs nothing), zero skips. Hosted exact-head CI
is the authoritative zero-skip run.
