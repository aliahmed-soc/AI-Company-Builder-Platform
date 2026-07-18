# ADR-007 — Tenancy and Data Isolation

1. **Title:** Shared database, two-layer tenant isolation (application scoping + database row-level enforcement)
2. **Status:** Accepted (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** Tenant isolation is launch gate 1/2 and the top-ranked platform risk. ADR-001's self-serve segment implies many small tenants (schema/DB-per-tenant impractical). ADR-005 permits single-region.
5. **Decision proposal:** Single PostgreSQL-class database, shared schema. Layer 0: tenant resolved only from session membership (invariant 2). Layer 1: repository layer requires tenant context to construct queries. Layer 2: database row-level security keyed to per-connection tenant setting. Every tenant row carries immutable `company_id` (invariant 1). Extends beyond the DB: storage-path prefixes, cache-key prefixes, job tenant context, log scoping (DATA-ARCHITECTURE §2).
6. **Requirement IDs:** NFR-001, NFR-002, MEM-003, PORT-003, ACT-002.
7. **Alternatives:** App-layer filters only (one bug = breach); separate schema per tenant (migration/ops explosion at self-serve volume); separate DB per tenant (cost/ops prohibitive; enterprise-tier option later).
8. **Benefits:** Defense in depth; single operational database; adversarial-testable.
9. **Costs:** Row-level policies add complexity to migrations and connection management.
10. **Risks:** Policy misconfiguration; connection-pool tenant-setting leaks (mitigate: per-request setting + reset, tested).
11. **Security implications:** Core control for the platform's #1 risk; admin bypass restricted to break-glass with alarms.
12. **Operational implications:** Migration review includes RLS policy checks; CI runs the adversarial suite.
13. **Reversal cost:** High — foundational.
14. **Scale trigger:** Regulated/enterprise tenants → dedicated-database tier (additive, not a reversal).
15. **Open questions:** AOQ-02 (exact database provider).
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted. Render PostgreSQL is standard Postgres — RLS layer unchanged. Clerk (ADR-022) is identity-only; internal membership remains the tenant authority.
Date: 2026-07-18
```
