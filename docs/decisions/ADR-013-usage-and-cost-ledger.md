# ADR-013 — Usage and Cost Ledger

1. **Title:** Append-only usage events and credit transactions with derived account rollups and five-number separation
2. **Status:** Accepted (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** USAGE-001, BILL-002, NFR-015, plus ADR-003's binding per-account recording refinement. D-02 (commercial formula) remains open — the ledger must be mechanism-neutral.
5. **Decision proposal:** Two append-only stores: usage events (every model/tool/run consumption with company+account attribution, invariant 9) and credit transactions (grants/reservations/consumptions/releases/refunds; corrections only via compensating entries referencing originals, invariant 10). Balances always derived. Account-period rollups are rebuildable projections. Five numbers kept distinct end-to-end: technical usage / provider cost / billable usage / included entitlement / user-visible credits. Credits (MVP) = commercial entitlement + display abstraction over task execution (1 manual run = 1 credit), not token mapping. Atomic reservation resolves the final-credit race. Charging rules: provider-fault failures not billable; retries billable once per logical task; cancellations released. Reconciliation jobs compare provider bills ↔ estimates ↔ events. Metering-write failure blocks metered work (fail closed).
6. **Requirement IDs:** USAGE-001, USAGE-002, BILL-002, BILL-003, NFR-015, TASK-004, ACT-004.
7. **Alternatives:** Mutable balance columns (race-prone, unprovable); provider-billing-as-truth (no per-task attribution); single merged "usage number" (explicitly forbidden by the five-number separation requirement).
8. **Benefits:** Provable accounting (launch gate 7); D-02 stays open without schema risk; corrections auditable.
9. **Costs:** Aggregation jobs; reconciliation tooling.
10. **Risks:** Rollup drift (rebuildable-by-design mitigates); estimate-vs-bill divergence (reconciliation alerts).
11. **Security implications:** Ledgers are tenant-scoped; no cost data crosses tenants.
12. **Operational implications:** Cost dashboards, cap alerts, reconciliation runbook.
13. **Reversal cost:** Medium.
14. **Scale trigger:** Ledger partitioning by period at volume (AOQ-16 adjacent).
15. **Open questions:** D-02 (commercial formula); AOQ-14 (initial caps).
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted including account rollups. The USAGE-001 specification amendment (account-level aggregation, reconciliation, no double counting, compensating corrections) was executed at this review — PRD change log 1.2.0-draft.
Date: 2026-07-18
```
