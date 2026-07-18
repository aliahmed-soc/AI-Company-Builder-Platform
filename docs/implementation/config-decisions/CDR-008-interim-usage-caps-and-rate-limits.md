# CDR-008 — Interim Usage Caps and Rate Limits

1. **ID:** CDR-008
2. **Title:** Interim technical caps, rate limits, and abuse thresholds (pre-alpha calibration)
3. **Status:** Accepted (interim; mandatory revisit at first alpha telemetry review)
4. **Date:** 2026-07-18
5. **Owner:** Product owner (interim values authorized; **no commercial entitlement or pricing decided — D-02 untouched**)
6. **Source ticket:** ACBP-P0-009 (IOQ-09 / AOQ-14 part)
7. **Context:** ADR-003's pre-beta control list requires hard limits, rate limits, budget alerts, and abuse detection; NFR-015 bounds overrun at ≤1 billing increment; final commercial numbers await D-02 + alpha data.
8. **Decision:** Seven separated layers with interim values (all configuration, all revisit-bound):
   - **Technical request limits:** per-session API ceiling 60 req/min sustained, burst 120; per-account 300 req/min.
   - **Model-call limits:** per-company 200 model calls/day and 2M tokens/day interim ceilings.
   - **Worker-execution limits:** max 2 concurrent runs per company; per-run budget deferred to IOQ-12 at ACBP-P5-004 (config record there).
   - **Commercial entitlements:** **explicitly not set** (D-02); interim alpha allowance = 5 manual runs/day per company as a *technical* courtesy cap, not a price signal.
   - **Abuse thresholds:** signup-velocity and usage-entropy anomalies → automatic soft-lock + operator review; repeated cap-hits flagged.
   - **Hard cost caps:** per-company platform-model-spend ceilings — $5/day, $50/month interim; enforcement halts within ≤1 increment (NFR-015); account-level cap = 3× company cap across companies.
   - **Warning thresholds:** 75% of any hard cap → `usage.limit_reached` soft alert + Decision Room notice.
9. **Scope:** Technical enforcement values in the policy/gateway/ledger layers; UI copy must present caps as platform safety limits, never as plan pricing.
10. **Alternatives:** no caps (violates ADR-003); generous caps (defeats purpose).
11. **Reasons:** Conservative-and-visible beats silent-and-unbounded; every value is one config change away after evidence arrives.
12. **Security impact:** Abuse posture active from first model call.
13. **Reliability impact:** Runaway-cost protection platform-wide.
14. **Operational impact:** Cap-hit dashboards; operator override path (audited).
15. **Cost impact:** Bounded worst-case alpha spend per company/account.
16. **Portability impact:** None.
17. **Reversal cost:** Low (pure configuration).
18. **Requirement IDs:** NFR-015, POL-001, USAGE-001.
19. **Governing ADRs:** ADR-003, ADR-010, ADR-013.
20. **Implementation tickets unblocked:** ACBP-P6-010 (values); structure already consumed by ACBP-P2-003/P5-014 designs.
21. **Review trigger:** **First alpha telemetry review (mandatory)**; any cost anomaly; D-02 decision (entitlement layer then supersedes the courtesy cap).
