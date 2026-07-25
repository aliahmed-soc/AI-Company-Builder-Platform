# ACBP-P3-001 — Review coverage ledger (strategy option generation)

Independent **security + scope** review of the full P3-001 diff (`p3-001-strategy-option-generation` vs `main`): the
16-field strategy contract (`@acbp/contracts/strategy`), migration 0022 (`strategy_generations` + `strategy_options`),
and the core use case (`@acbp/core/strategy`). Calibrated for the load-bearing properties: the **confirm gate**
(strategy blocked pre-confirm), **tenant isolation** (dual-keyed FORCE RLS + least privilege), **ADR-019 no fake
precision**, and **audit-or-nothing**.

## Verdict
**PASS — no Blocker/Critical.** One Medium (confirm-gate TOCTOU, fixed), two Low (both fixed), one Info (accepted).

## Dimensions — CLEAN (confirmed)
1. **Tenant isolation / RLS.** Both tables are `ENABLE`+`FORCE` RLS, dual-keyed on BOTH `app.current_account` AND
   `app.current_company` in USING (select) and WITH CHECK (insert); `nullif(current_setting(...))` fails closed. Proven
   real-PG: cross-company read = 0, missing company key fail-closed, cross-tenant INSERT rejected.
2. **Least privilege.** Grants are exactly `SELECT, INSERT` on both tables — no UPDATE (table or column), no DELETE, no
   grant option, no other roles. SECURITY DEFINER allowlist stays 3; `acbp_app` remains NOSUPERUSER/NOBYPASSRLS — all
   re-asserted.
3. **ADR-019 no fake precision.** `STRATEGY_OPTION_FIELDS` matches PRD §11.3 exactly (16 fields, correct order);
   `isCompleteOptionFields` requires exactly the 16 keys, each non-blank/bounded (rejects missing AND extra keys);
   `"unknown"` is a legal labeled value; `narrowStrategyOutput` re-checks completeness + status/count consistency. The
   template pins the honesty obligation.
4. **Audit / audit-or-nothing.** `strategy.generated` is written in the same transaction (rollback proven); metadata is
   exactly `{understanding_version, option_count, similarity_check_result}` — no content; only `strategy.generated`
   registered; the `AUDITED_OPERATIONS` partition stays compile-time exhaustive.
5. **Immutability.** No update/delete path or grant; every column `never`-on-update; `UNIQUE(generation_id, ordinal)`;
   the `jsonb_typeof(fields) = 'object'` CHECK. UPDATE/DELETE by the app role proven to throw.
6. **Model/gateway discipline.** FakeModelProvider only; the model call runs BETWEEN scoped transactions (never in a
   held tx); a gateway failure or malformed output persists nothing; usage metered by the gateway; no secret/PII/
   provider text in logs or the DTO.
7. **Scope.** `similarity_check_result` hardcoded `pending`; no distinctness engine / comparison / recommendation /
   selection / decision record / HTTP route / migration 0023; no `apps/web` change. All required pieces present.
8. **Reset-list hygiene.** Both tables added to the two-tenant-harness `ALL_TABLES`, `catalog.adversarial`
   TENANT_TABLES + grant + column-privilege expectations, the database existence assertions + cleanup, and the
   strategy-suite drop list. FK ordering is safe: the strategy tables precede `understanding_documents` in every
   non-cascade delete list, so `truncateFixtures` deletes the FK child first.

## Findings dispositioned
- **MEDIUM (fixed) — confirm-gate TOCTOU across the two-transaction window.** The confirmed-understanding gate was
  checked only in the pre-read transaction; the persist transaction re-checked authz but not the confirmation state, so
  a concurrent owner correction/regeneration during the model call could let a strategy set persist against an
  understanding that is no longer the current confirmed version. **Fixed:** the persist transaction now RE-VERIFIES the
  current document id + version + confirmation, and returns `stale_understanding` (persisting nothing) if the
  understanding changed — optimistic concurrency mirroring understanding-review's version guard. Added a real-PG test
  (a `beforePersist` seam injects a concurrent `corrected` event → `stale_understanding`, nothing persisted, no audit).
- **LOW-1 (fixed) — `narrowStrategyOutput` accepted a `fewerReason` on a `complete` status.** The defensive re-narrow
  checked status/count consistency but not that a reason is meaningful only for `fewer_than_three`. **Fixed:** it now
  rejects a non-null `fewerReason` when `status = 'complete'`. Contract test added.
- **LOW-2 (fixed) — no DB-level consistency CHECKs between `status`, `option_count`, and `fewer_reason`.** These
  invariants were app-enforced only. **Fixed:** migration 0022 now CHECKs `(complete ∧ count ≥ 3) ∨ (fewer_than_three ∧
  count < 3)` and `fewer_reason IS NULL OR status = 'fewer_than_three'` (immutable-table integrity against any future
  writer). Real-PG CHECK tests added.
- **INFO (accepted) — unused repository read methods (`findGeneration`, `listGenerations`).** Contract-completeness
  surface consistent with the "define the read API now" precedent; harmless, non-scope-violating. Left in place for the
  P3-003 comparison consumer.

## Status
Re-verified after the fixes: recursive typecheck + lint + secrets + boundaries clean; full unit suite green; real-PG
strategy migration 7/7 and core use cases 9/9 (incl. the new stale-understanding + CHECK tests), zero skips. Hosted
exact-head CI is the authoritative zero-skip run.
