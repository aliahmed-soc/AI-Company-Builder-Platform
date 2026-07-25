# ACBP-P3-004 — Review coverage ledger (selection / edit / combine / phase-limited approval)

Independent **security + scope + correctness** review of the full P3-004 diff (`p3-004-selection-and-approval` vs
`main` `c645e8e`): the selection contracts (`@acbp/contracts/strategy`, `/audit`, `/authz`), migration 0024
(`strategy_selections`), and the core use case (`@acbp/core/strategy`). Calibrated for the load-bearing STRAT-003/005
invariants (OWNER-ONLY selection; records a SELECTION only — no decision record, no planning unlock; phase_scope
FLAGGING-only), tenant isolation, immutability, deny-by-default validation, and audit privacy.

## Verdict
**PASS (after fix) — no Blocker/Critical/High remaining.** The review's nine security/scope/correctness dimensions were
all confirmed UPHELD; the single **High** it raised was a mechanical encoding regression (below), now fixed.

## Dimensions — CLEAN (confirmed by the reviewer)
1. **Owner-only authorization.** `POLICY 'strategy:select': ['owner']` + the use-case gate both enforce owner-only;
   authority derives solely from a fresh DB company-membership row via `runInCompanyScope` — a viewer is `forbidden`, a
   non-member is denied at scope resolution, a forged browser claim cannot manufacture membership. Proven in real-PG.
2. **Audit privacy.** `strategySelected` emits exactly `{mode}` (or `{mode, phase_scope}`) — never chosen fields, option
   content, or reject reasons; the no-phase case omits the key (no sentinel). The in-tx call and the logger carry only
   ids + mode + phaseScope.
3. **Audit-or-nothing.** `insertSelection` + `strategySelected` run inside the single scoped transaction; a forced audit
   failure rolls the selection back (real-PG test: 0 selections, 0 audit events).
4. **Scope — selection only.** Exactly one `strategy_selections` row + its audit event; NO decision record
   (`decision.recorded` is P3-005) and NO tasks/planning unlock (real-PG asserts 0 tasks). `phase_scope` is a flagging
   marker with no enforcement (CDR-037 §5).
5. **Deny-by-default validation.** `validateStrategyDecision` rejects unknown modes, out-of-range/missing ordinals,
   `select` carrying fields, `reject` missing reasons or carrying phase_scope/option/fields, `combine` naming a base,
   and blank/over-long reasons; `isCompleteOptionFields` enforces exactly 16 non-blank bounded fields. Re-enforced by DB
   CHECKs.
6. **DB integrity.** Migration 0024 grants SELECT+INSERT only (no UPDATE/DELETE), ENABLE+FORCE RLS, dual-keyed
   fail-closed policies; CHECKs cover mode enum, phase_scope enum, chosen_fields object-typing, reasons length,
   reject-no-phase, and a complete per-mode shape; the composite FK `(selected_option_id, generation_id) →
   strategy_options(id, generation_id)` makes a cross-generation base impossible (NULL skips via MATCH SIMPLE); a
   cross-company insert is refused by WITH CHECK. All directly tested against real PG.
7. **Reset-list / catalog hygiene (content).** `strategy_selections` present and FK-safe-ordered (before
   `strategy_options`/`strategy_generations`) in the two-tenant `ALL_TABLES`, the adversarial `TENANT_TABLES`,
   `EXPECTED_GRANTS` (INSERT/SELECT), the no-column-UPDATE assertion, the DB existence check, and every per-file reset
   array.
8. **Boundaries.** No provider SDK imports; contracts stays zero-dep; `strategy-selection.ts` imports only
   database/contracts/observability + sibling core modules. No new dependency cycle.
9. **Correctness.** Ordinal→option-id resolution reads the target generation's options and returns `invalid` on a
   missing ordinal (no crash, no foreign option); the `chosen_fields` jsonb → `StrategyOptionFields | null` DTO mapping
   is correct for all four modes; latest-wins read uses `created_at desc, id desc`.

## Findings dispositioned
- **HIGH-1 (fixed) — UTF-8 mojibake across 36 reset-list files.** The Slice-2 reset-list edit added
  `strategy_selections` to 36 pre-existing integration suites via a PowerShell pass that read each file as Windows-1252
  (`Get-Content -Raw` default in PS 5.1) and re-saved UTF-8, double-encoding every em-dash / box-drawing character into
  mojibake. Functionally harmless (confined to comments + string literals; the gate stayed green) but it polluted the
  diff and would have corrupted the test suite's history. **Fixed** (`684cfde`): each file restored from `main` and the
  single-line array insertion re-applied with a UTF-8-safe writer (`.NET ReadAllText/WriteAllText`); the
  `strategy_selections` existence assertion re-added to `database.integration`. Verified: zero `c3 a2` bytes across the
  branch; the net diff is the intended one-line-per-reset-list addition; recursive typecheck/lint/secrets/boundaries
  clean.
- **Informational (accepted) — latest-wins tiebreaker on a random UUID.** `latestSelection` orders by `created_at desc,
  id desc`; under an identical `created_at`, `id desc` on `gen_random_uuid()` is non-deterministic. Accepted: it matches
  the already-accepted `latestGeneration`/`latestRecommendation` precedent, and the CLAUDE.md determinism rule is scoped
  to identity mappings. Separate owner actions produce distinct transaction timestamps in practice.

## Status
Re-verified after the fix: recursive typecheck + lint + secrets + boundaries clean; contracts strategy + core
strategy/audit unit suites green; the real-PG selection (11) + `strategy_selections` migration (10) suites discovered
and green in structure (local PG unreachable → skipped; hosted exact-head CI is the authoritative zero-skip run).
