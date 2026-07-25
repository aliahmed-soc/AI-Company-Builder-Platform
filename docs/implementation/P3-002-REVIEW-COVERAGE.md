# ACBP-P3-002 — Review coverage ledger (distinctness check)

Independent **security + scope + correctness** review of the full P3-002 diff (`p3-002-distinctness-check` vs `main`):
the distinctness contract (`dedupeByDistinctness`, `@acbp/contracts/strategy`) and its wiring into
`generateStrategyOptions` (`@acbp/core/strategy`). Calibrated for the ticket's core property (correct rejection of
near-duplicates WITHOUT dropping genuinely-distinct options), honesty (ADR-019), DB integrity, and scope.

## Verdict
**PASS.** One HIGH (axis-boundary collision — already caught + fixed pre-review), two Low + one Info (all fixed). No
schema/migration/audit/authz change, as designed.

## Dimensions — CLEAN (confirmed)
1. **Distinctness correctness.** Two options are distinct IFF they differ on ≥1 of {customer, offer, business_model}
   (canon: PRD J-07 / REQUIREMENTS STRAT-001). Normalization (trim/case-fold/whitespace-collapse) is one-directional
   (never a false negative — identical-axis options always collide). The axis key is NUL-separated so boundaries never
   collide (see HIGH below).
2. **No-fabrication / honesty (ADR-019).** The synthesized reason uses only fixed axis names + counts (no option
   content); `parseStrategyOptions` nulls a model reason whenever ≥3 raw options were returned, so it never bleeds into
   the collapse case; status is re-derived from the DISTINCT count (a model returning ≥3 raw but <3 distinct is
   correctly downgraded).
3. **Status / count / DB integrity.** `status = complete ⟺ similarity = distinct ⟺ distinctCount ≥ 3`, and
   `option_count = distinctOptions.length`, so the P3-001 CHECK holds for every persistable row; `similarity_check_result`
   is never `pending` from this path; migration 0022 already permits `insufficient_distinct`.
4. **Tenant isolation / audit-or-nothing.** Dedup runs BEFORE the persist transaction; the confirm-gate re-verification,
   audit-in-same-transaction, and RLS behavior are untouched; the audit payload stays bounded (no option content).
5. **Scope.** No migration/table/column/audit/authz; deterministic + model-free (no metering); no
   comparison/recommendation/selection/decision creep. The honest-reason path is reached + exercised end-to-end.
6. **Data loss / transparency.** Dropping cosmetic variants (identical on all three axes) is a defensible reading of
   STRAT-001 "rejects near-duplicates" (no strategic information lost; the rejected count is surfaced in the honest
   reason) — safe precisely BECAUSE the dedup key is correct (HIGH below).
7. **Test integrity.** The P3-001 fixture change (identical `option()` → `distinctOptions`) is necessary, not a
   weakening (identical-axis options now legitimately collapse); assertions were STRENGTHENED (the fewer test now also
   asserts the verdict + count; new real-PG adversarial tests assert near-duplicate rejection, persisted count, honest
   reason, and audit verdict).
8. **Correctness / edge.** First-wins representative selection is deterministic; empty/single → `insufficient_distinct`;
   the `FEWER_REASON_MAX` slice is applied; the two-transaction window is unaffected.

## Findings dispositioned
- **HIGH (fixed) — axis-boundary collision in `distinctnessKey`.** The key must join the three normalized axes with a
  separator that cannot appear in a normalized value, else token content shifting across an axis boundary (e.g.
  `customer="a b"/offer="c"` vs `customer="a"/offer="b c"`) produces an identical key → a genuinely-distinct option is
  silently dropped as a "near-duplicate" (false-positive dedup / data loss). This was **caught during self-review and
  fixed before the independent review returned**: the separator is a NUL character — the source now uses the explicit
  backslash-u-0000 escape (the prior source held a raw NUL byte, which renders as a space and misled a reading of the
  code). An
  adversarial boundary-collision unit test was added (the two options above assert `distinct`, length 2,
  `duplicatesRejected 0`). The independent review confirmed the direction and the fix.
- **LOW (fixed) — stale header comments.** The `strategy.ts` + `strategy-generation.ts` file headers still said the
  distinctness engine "is P3-002 … records `pending`". Updated to describe the implemented check.
- **LOW/INFO (fixed) — a `fewer_than_three` row could have a null reason** when the model returned <3 raw options with
  no reason and nothing was deduped (a pre-P3-002 shape gap). `honestFewerReason` now ALWAYS returns a factual reason on
  the fewer path ("The model produced only N genuinely distinct option(s) …"), so a fewer-than-three generation is never
  unexplained (STRAT-001 "stated honestly with reasons"). A real-PG test asserts it.

## Status
Re-verified after the fixes: recursive typecheck + lint + secrets + boundaries clean; full unit suite green; contracts
strategy 19 unit (incl. the boundary-collision case) + core strategy real-PG 12/12 (incl. near-duplicate rejection +
the null-reason case), zero skips. Hosted exact-head CI is the authoritative zero-skip run.
