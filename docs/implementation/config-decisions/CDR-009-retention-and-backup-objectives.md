# CDR-009 — Retention and Backup/Recovery Objectives

1. **ID:** CDR-009
2. **Title:** Initial retention defaults per data class and confirmed backup/recovery objectives
3. **Status:** Accepted (implementation defaults; legal review before the closed-beta gate; **no legal-compliance claim made**)
4. **Date:** 2026-07-18
5. **Owner:** Product owner (defaults); legal review owed pre-beta (RELEASE-GATES closed-beta data criteria)
6. **Source ticket:** ACBP-P0-010 (IOQ-10 / AOQ-12/13/15)
7. **Context:** NFR-016 requires documented, enforced retention; NFR-017 proposed RPO ≤24h / RTO ≤4h; ADR-005 requires honest documentation; D-08 remainder (jurisdiction) is open, so defaults must be conservative and adjustable.
8. **Decision:**
   - **Retention defaults:** application records — life of account + 30-day staged post-deletion purge · audit events — 7-year-class default (≥ product data; pending legal confirmation) · activity events — with company data · model-call metadata — ≥ billing retention · **prompt/response content — 90 days in restricted storage, then purged (references/digests remain)** · generated documents — user-owned, life of company, export-first deletion (COMP-007 pattern) · failed-workflow diagnostics — 90 days · usage events — 7-year-class default (billing-grade) · **deletion exceptions:** legal/security holds override purge, visibly flagged, audited.
   - **Backup/recovery (confirms NFR-017):** **RPO ≤ 24h, RTO ≤ 4h**; daily automated backups + point-in-time recovery where the plan supports it (CDR-004 criterion); **restore test pre-beta, then quarterly**; backup restores rehearsed in staging, never first-run in production.
9. **Scope:** Implementation defaults + drill cadence; legal confirmation is a gate item, not claimed here.
10. **Alternatives:** wait for legal (blocks four P7 tickets); minimal retention (conflicts with audit/billing needs).
11. **Reasons:** Conservative defaults are tighten-able after legal review without data loss; loosening later is also possible because nothing is purged early.
12. **Security impact:** Prompt-content minimization (90-day purge) reduces sensitive-data surface; holds are auditable.
13. **Reliability impact:** Drill cadence converts NFR-017 from aspiration to evidence.
14. **Operational impact:** Retention jobs + logs (NFR-016); drill scheduling.
15. **Cost impact:** Storage bounded by purge cycles.
16. **Portability impact:** Retention metadata travels with exports where relevant.
17. **Reversal cost:** Low (schedule config) — except shortening audit retention later, which requires explicit owner + legal sign-off.
18. **Requirement IDs:** NFR-016, NFR-017, NFR-008, NFR-011.
19. **Governing ADRs:** ADR-005, ADR-015, ADR-016, ADR-020.
20. **Implementation tickets unblocked:** ACBP-P7-001, ACBP-P7-002, ACBP-P7-005, ACBP-P7-006.
21. **Review trigger:** Legal review (pre-beta gate, mandatory); D-08 remainder decision; any hold/incident.
