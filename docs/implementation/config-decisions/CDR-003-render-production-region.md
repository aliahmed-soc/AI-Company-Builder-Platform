# CDR-003 — Render Production Region

1. **ID:** CDR-003
2. **Title:** Interim production region selection (US-East-class)
3. **Status:** Accepted (interim default; D-08 review trigger binding)
4. **Date:** 2026-07-18
5. **Owner:** Product owner (default authorized within ADR-005/020 boundaries; region re-review owed at D-08 remainder)
6. **Source ticket:** ACBP-P0-003 (IOQ-03 / AOQ-20)
7. **Context:** ADR-020 requires one production region for beta; ADR-005 makes no residency promise and requires data-location documentation; the initial-market decision (D-08 remainder) is still open.
8. **Decision:** Default to a **US-East-class Render region** (Virginia preferred, Ohio acceptable — confirmed against Render's live region list at staging creation). Rationale: lowest-latency connectivity to both model providers' primary endpoints. Staging and production in the same region. Data-location and subprocessor register updated at provisioning. **This is not a residency guarantee and must never be presented as one.**
9. **Scope:** Region selection only; plans are CDR-004; migration posture per ADR-020 §14.
10. **Alternatives:** US-West (no identified advantage); EU (unjustified before D-08); waiting (blocks staging + P7-006).
11. **Reasons:** Provider-connectivity dominance for an AI-loop product; ADR-005 explicitly permits a non-promising default; earliest-cheapest reversal window is before beta data accumulates.
12. **Security impact:** Register/data-location documentation obligations attach at provisioning.
13. **Reliability impact:** Single region per ADR-018; NFR-003 target unaffected.
14. **Operational impact:** None beyond documentation.
15. **Cost impact:** Region-neutral at MVP scale.
16. **Portability impact:** No region-hardcoded identifiers in data or storage paths (ADR-005 non-foreclosure discipline restated as binding here).
17. **Reversal cost:** Medium (pre-beta migration cheap; post-beta = documented migration).
18. **Requirement IDs:** NFR-011, NFR-003.
19. **Governing ADRs:** ADR-005, ADR-018, ADR-020.
20. **Implementation tickets unblocked:** ACBP-P7-006 (with CDR-004); staging environment creation within ACBP-P0-018/P0-021 documentation.
21. **Review trigger:** **D-08 remainder (initial market/region) decision** — mandatory re-check; any strict-residency design partner (ADR-005 trigger).
