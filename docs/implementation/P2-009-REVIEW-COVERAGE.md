# ACBP-P2-009 — Review coverage ledger (Understanding review and confirmation)

Independent adversarial review of the P2-009 change set (`9e11466..HEAD`; branch `p2-009-understanding-review`) across
ten dimensions. **Verdict: no Blocker/Critical/High defects.** All findings Low/Medium; every one dispositioned below.

## Dimensions — all CLEAN
1. **Correctness / gate / idempotency / staleness** — `isVersionConfirmed = confirmed && !corrected` (deny-by-default);
   `isExpectedVersionCurrent` rejects non-integer/NaN/string/stale; item-ownership guard rejects reviews against a
   superseded version's item; confirm/correct idempotent via `ON CONFLICT (document_id, kind) DO NOTHING` (no second
   audit); a corrected version cannot be re-confirmed.
2. **Security / tenancy / authz** — dual-keyed FORCE-RLS SELECT/INSERT-only on both tables (cross-company read
   impossible; fail-closed without the company GUC; cross-tenant INSERT refused by WITH CHECK — real-PG proven);
   `understanding:review`/`:confirm` owner-only (viewer + non-member denied, unit + real-PG); NO content/PII in audit
   metadata; server-resolved actor; no browser-trusted identity.
3. **Migration 0020** — additive (0001–0019 untouched); SELECT+INSERT grants only (append-only proven); decision/kind/
   version/note/correction_ref/shape CHECKs each with a failing-case test; `UNIQUE(document_id, kind)`; FK cascade
   tested; `down()` symmetric + reapplyable by name; **exactly 3 SECURITY DEFINER**, `acbp_app` NOBYPASSRLS/NOSUPERUSER,
   no new role.
4. **Concurrency** — no reachable invalid state; `{corrected}`-without-`confirmed` impossible; `UNIQUE` caps one of
   each kind; gate transitions monotonically false→true→false; no flicker.
5. **Canon fidelity** — session-vs-version confirmation boundary honestly stated (gate at the version grain;
   session-state sync deferred to P2-012); "dependents flagged" honest (MVP `STRATEGY_DEPENDENT_COUNT = 1`).
6. **Scope discipline** — no live model call (evidence/research recorded, not executed); no HTTP route; no P2-011/
   P3-001 leakage; no owner-gate crossing.
7. **Test coverage** — genuine, no retry/skip masking (only `skipIf(!hasTestDatabase)`); acceptance proven (5 controls
   record + audit; planning blocked pre-confirm / unlocked post-confirm; correction re-blocks + flags dependents) plus
   idempotency, staleness, audit-or-nothing rollback (seam-injected), cross-company isolation, no-understanding,
   viewer/non-member denial.
8. **Boundaries** — `contracts/review.ts` zero-dep/pure; `core` imports no provider SDK; `database` Kysely
   parameterized queries + `sql.ref` identifiers only (no raw value interpolation).
9. **Audit completeness** — 3 events registered + produced (no orphan); `AUDITED_OPERATIONS` partition exhaustive
   (compile-time guard); exact-set enumeration tests updated (`audit.test.ts`, `audit-operations.test.ts`).
10. **Docs** — reset lists updated across ~33 integration files + `ALL_TABLES` + catalog `TENANT_TABLES`/
    `EXPECTED_GRANTS`; AUTHORIZATION/AUDIT/DATA-ARCHITECTURE/INTERVIEW/PROJECT-STATE accurate.

## Findings dispositioned (4 Low/Medium — all fixed)
- **D1 (Low, doc/impl divergence).** `understanding.confirmed` documented as `{version, confirmed_by}` but implemented
  (correctly) as `{version}` — the confirming actor is the server-stamped audit actor. **Fixed:** CDR-030 §3/§6 +
  EVENT-CATALOG row corrected to `{version}`.
- **D2 (Low, latent trap).** `listReviews`/`listConfirmationEvents` ordered by random-UUID `id` while the comment
  claimed "oldest→newest / latest row". No functional bug today (the gate is order-independent), but a future
  "latest-wins" consumer would be wrong. **Fixed:** ordered by `created_at, id` (genuinely chronological); comments
  corrected.
- **P1 (Low, canon fidelity).** CDR §3 phrased the confirm precondition as "version-currency **+ reviewed**" but the
  code does not require ≥1 review. **Fixed:** softened CDR §3 to the ENFORCED precondition (document-present +
  current-version + expected_version + not-superseded); per-item review is available but deliberately NOT a hard gate
  (canon does not quantify "review done" — the safer, non-inventing interpretation).
- **P2 (Low, plausible).** `correction_ref` "never content" is a caller convention, bounded (≤256) but not
  content-validated. **Fixed:** doc wording made honest (CDR §6, AUDIT.md) — bounded reference, not content-validated,
  stays within the caller's own tenant-scoped audit trail.

## Completeness
API-CONTRACTS status annotation + EXECUTION-LOG entry added (the CDR §7 slice-plan items the review flagged as not yet
in the diff). No production fix altered behavior except D2 (repository ordering) — re-verified: core review suite +
migration suites green after the change; full recursive typecheck clean.
