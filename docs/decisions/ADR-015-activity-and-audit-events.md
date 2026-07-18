# ADR-015 — Activity and Audit Events

1. **Title:** Append-only audit store with transactional writes for high-risk operations; activity feed as tenant-facing projection
2. **Status:** Accepted (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** ACT-001/002/003 and NFR-008 require complete, immutable, timely history with a founder-readable feed distinguishing proposed from executed work.
5. **Decision proposal:** One append-only audit-event store (actor, timestamp, context, correlation, tenant) with no mutation path through product APIs (invariant 11). High-risk operations (approvals, policy decisions, lifecycle transitions, ledger writes, stops) write audit records **in the same transaction** — write failure blocks the action. Lower-risk events flow through a transactional outbox. The activity feed is a company-scoped projection with honest lag ("as of") and mandatory proposed-vs-executed marking backed by evidence joins (invariant 20). Audit reads are audited; owners export their own company's records; retention ≥ product data (AOQ-13).
6. **Requirement IDs:** ACT-001, ACT-002, ACT-003, ACT-005, NFR-008, DEC-001, TOOL-002.
7. **Alternatives:** Log-file-as-audit (mutable, unqueryable, no tenant scoping); external event-sourcing platform (Kafka-class — excluded by PRD §20); audit-after-the-fact (loses the blocking guarantee).
8. **Benefits:** Non-repudiable history; incident reconstruction; the honesty principles become queryable properties.
9. **Costs:** Audit volume management (archival policy); in-tx writes add latency to high-risk ops (acceptable).
10. **Risks:** Table growth (partition/archive by period); over-auditing noise (event taxonomy discipline).
11. **Security implications:** Tamper-evidence; admin access to cross-tenant audit is itself audited.
12. **Operational implications:** Audit-write-failure is a page-level alert (OBSERVABILITY §2).
13. **Reversal cost:** Medium.
14. **Scale trigger:** Volume → partitioning + cold storage export.
15. **Open questions:** AOQ-13 (audit retention period).
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted as written.
Date: 2026-07-18
```
