# ACBP-P2-008 — independent review coverage

An independent security + scope reviewer examined the complete diff (`main...HEAD`) of understanding generation
against CDR-029, diagram 04, UNDER-001/005, the backlog row, and the CLAUDE.md rules — across ten dimensions
(canon/scope, migration lifecycle, tenant isolation, classification/confidence, provenance, versioning/concurrency,
audit atomicity, provider boundary, secrets, P2-009 compatibility).

## Security + scope review — CLEAN (no CRITICAL / HIGH / MEDIUM)

All ten dimensions PASS:
- **Canon/scope:** no P2-009 behaviour (no confirm/approve/review columns or events), no strategy (P3-001), no
  P2-007 context assembly, no live provider (gateway injected, fake-only, live deferred CDR-026 §0). The 6 classes
  + weakest-section + partial labeling + versioning trace to diagram 04 + UNDER-005 + CDR-029.
- **Migration 0019:** additive, company-scoped, dual-keyed FORCE RLS, SELECT+INSERT only (no UPDATE/DELETE
  grant/policy), no new SECURITY DEFINER/BYPASSRLS/owner runtime; unique `(company_id, version)`; FK cascade;
  CHECKs; clean down/up/reapply. **The P2-003 reset-list omission does NOT recur** — both tables are in
  `TENANT_TABLES` + `EXPECTED_GRANTS`, `ALL_TABLES`, and every reset list in correct FK order.
- **Tenant isolation:** cross-company read/insert refused; persist under `runInCompanyScope` (acbp_app) in one tx;
  model call BETWEEN scoped ops (never in the held tx); server-resolved account/company/actor (no forged fields).
- **Classification/confidence:** parseUnderstanding deny-by-default; section status present/assumed/unknown via the
  0.5 threshold; overall = weakest COVERED section — no off-by-one/wrong-direction.
- **Audit atomicity:** `understanding.generated` in the same tx as document+items (audit-or-nothing, proven);
  metadata `{version, status, item_count}` — no content.
- **Provider/secrets:** gateway failure OR malformed → persists NOTHING; only model-flagged `partial:true` →
  `status='partial'`; usage metered fail-closed; no provider SDK in core; no content in logs or audit.
- **P2-009 compatibility:** `status` (generation completeness) is orthogonal to review state — no premature
  confirmation column; P2-009 adds its lifecycle without reworking 0019.

## Finding dispositions

| # | Severity | Finding | Disposition |
|---|---|---|---|
| L1 | Low (robustness) | Two concurrent `generateUnderstanding` calls for one company could compute the same `version`; the loser's insert threw an UNCAUGHT duplicate-key error (the chain stayed valid + nothing partial persisted, so integrity was safe, but the loser failed loudly with no typed result). | **FIXED (code).** `insertDocument` is now `ON CONFLICT (company_id, version) DO NOTHING` (returns undefined on a race), and `generateUnderstanding` recomputes the next version and retries (bounded ≤5) — a valid, gap-free chain, never an uncaught throw; extreme contention returns a typed `generation_failed` with nothing persisted. New real-PG concurrency test: two concurrent generations → distinct versions [1, 2]. |
| L2 | Low (doc) | CDR-029 §3 literally said a failed/malformed model call is persisted as `status='partial'`, but the (safer) code persists NOTHING on failure and reserves `partial` for a model-flagged `partial:true`. | **FIXED (doc).** CDR-029 §3 rewritten to match: gateway failure OR malformed → persists nothing (`generation_failed`); `partial` is only a model-flagged, successfully-parsed output; an unknown section is a normal gap, not "partial". |
| L3 | Low (doc) | CDR-029 §1 claimed classification is provenance-derived via a `user_fact→fact` type map and each item carries a `source_ref`, but v1 classifies by model and stores `source_ref: null`. (NOT a UNDER-002 violation — `understanding_items` is a separate generated artifact, never written to authoritative memory.) | **FIXED (doc).** CDR-029 §1 tightened: the 6 classes CORRESPOND to the memory types; v1 classification is model-based; `source_ref` is null (per-item linkage deferred — memory is fed to the prompt without ids); UNDER-002 preserved because the generated artifact never writes to `memory_items`. |

## Residuals

None actionable. The one robustness fix (race-safe versioning + concurrency test) is applied; the two CDR wording
refinements match the safer implemented semantics. The reviewer confirmed no security/boundary/tenancy/correctness
defect and that the HTTP-route deferral (engine + composition seam proven by the scripted real-PG suite) is
defensible and precedent-consistent (P2-003/P2-005).
