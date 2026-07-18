# CDR-004 — Render Service Plans

1. **ID:** CDR-004
2. **Title:** Service-plan selection criteria and provisional tiers
3. **Status:** Accepted (criteria binding; exact SKUs confirmed against live catalog at provisioning via addendum)
4. **Date:** 2026-07-18
5. **Owner:** Product owner (criteria); engineering (SKU confirmation within criteria)
6. **Source ticket:** ACBP-P0-004 (IOQ-04 / AOQ-21)
7. **Context:** ADR-020 selects Render; NFR-003 (99.5% beta), NFR-004 (latency), NFR-017 (RPO ≤24h / RTO ≤4h) must hold on whatever plans are chosen. Render's plan lineup changes; naming SKUs from memory would violate the verify-or-pending rule.
8. **Decision:** Binding criteria — production `api` and `worker`: smallest **paid, always-on** instance class with vertical-upgrade headroom; production PostgreSQL: smallest tier with **automated daily backups + point-in-time recovery + ≥50 usable connections** (pool sized for job-runner polling + per-request RLS session settings); staging: smallest paid tiers, prod-shaped, separate resources; private networking on. Exact SKUs read from the live Render catalog at provisioning and recorded as a dated addendum to this CDR. The P7-006 restore drill validates NFR-017 on the actual chosen plan **before** the closed-beta gate.
9. **Scope:** Plan selection; region is CDR-003; topology is ADR-018/020.
10. **Alternatives:** naming SKUs now (staleness risk); oversizing (cost without evidence).
11. **Reasons:** Criteria are the durable decision; SKU names are catalog data.
12. **Security impact:** None beyond ADR-020.
13. **Reliability impact:** Backup/PITR criterion is the NFR-017 carrier; connection floor protects ADR-008 job throughput.
14. **Operational impact:** Online upgrades; capacity watch per ADR-008 triggers.
15. **Cost impact:** Smallest-that-qualifies discipline.
16. **Portability impact:** None (standard Postgres preserved).
17. **Reversal cost:** Low (plan changes online).
18. **Requirement IDs:** NFR-003, NFR-017, NFR-005.
19. **Governing ADRs:** ADR-008, ADR-018, ADR-020.
20. **Implementation tickets unblocked:** ACBP-P7-006 (with CDR-003); staging provisioning steps inside Phase 0/1 documentation.
21. **Review trigger:** ADR-008 capacity triggers; NFR-003 misses; connection-pressure alerts; material Render pricing change.
