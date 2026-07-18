# ADR-020 — Initial Hosting and Database Provider

1. **Title:** Render as the initial production hosting and PostgreSQL provider
2. **Status:** Accepted
3. **Date:** 2026-07-18
4. **Owner:** Product owner
5. **Context:** ADR-018 (accepted with amendment) defines the topology — api + worker processes, managed Postgres, no Kubernetes, single region. AOQ-02 asked which provider hosts it first. ADR-002 requires managed defaults with no unnecessary migration barriers.
6. **Decision:** **Render** for the first production topology: Render **web service** for the application/API; Render **background worker** for asynchronous execution; **Render PostgreSQL** as the primary relational database; **private networking** between applicable services; **one production region** for the initial beta; **separate staging and production resources**. Application and worker deploy from the same repository and build artifact while running as distinct processes (ADR-006).
7. **Scope:** Initial hosting/database provider selection. Object-storage provider remains a separate open choice (AOQ-03, per owner instruction). Secret management is Infisical (ADR-021), not Render env vars.
8. **Explicit boundaries:** Preserves unchanged: modular monolith (ADR-006); separately scalable worker; Postgres-backed durable jobs (ADR-008); no Kubernetes; no microservice-per-agent; **no Render Workflows dependency for MVP**; **no Redis dependency unless later evidence demonstrates need** (ADR-008 amendment); no strict regional-residency promise (ADR-005). **Render environment variables are not the storage system for dynamic per-tenant integration credentials** — bootstrap configuration only (ADR-021).
9. **Alternatives considered:** Fly.io / Railway (comparable class; Render selected by owner for managed-Postgres + worker ergonomics); AWS directly (more control, materially higher ops burden for a small team); Kubernetes anywhere (excluded by PRD §20).
10. **Positive consequences:** Minimal ops; private networking; staging/production separation native; one build artifact → two process types matches ADR-006 exactly.
11. **Negative consequences:** PaaS pricing premium at scale; plan-level connection/compute ceilings must be watched (ADR-008 triggers).
12. **Security implications:** Render becomes a subprocessor (register + data-location documentation per ADR-005); private networking reduces exposure; database encryption at rest per NFR-011.
13. **Operational implications:** Backups/restore drills must meet NFR-017 on the selected plan (AOQ-15 confirms objectives); queue-health and connection-pressure metrics watch the ADR-008 triggers.
14. **Portability implications — documented exit path (not a portability promise):** standard PostgreSQL (dump/restore, no Render-proprietary extensions); portable application containers or ordinary Node.js processes; provider-neutral S3-compatible object-storage contract (ADR-016); source-controlled deployment configuration when implementation begins; exportable source code and customer-owned data (EXPORT-001). **No one-click infrastructure portability is promised.**
15. **Reversal cost:** Low-Medium — stateless processes move trivially; database migration is the real cost (standard-Postgres discipline bounds it).
16. **Requirement IDs:** NFR-003, NFR-005, NFR-011, NFR-017, NFR-001 (RLS carries over on standard Postgres), BILL-002 (transactional ledger unchanged).
17. **Governing architecture ADRs:** ADR-018 (topology), ADR-008 (jobs on this Postgres), ADR-007 (RLS on this Postgres), ADR-002 (managed defaults, accepted), ADR-005 (residency posture, accepted).
18. **Follow-up work:** AOQ-20 select Render region (with ADR-005 documentation duties); AOQ-21 select service plans sized against NFR-003/004; connection-pooling configuration; restore-drill on the chosen plan pre-beta.
19. **Review triggers (scale/migration):** Sustained database or connection pressure; job throughput exceeding ADR-008 thresholds; region requirements from D-08 remainder; availability requirements unsupported by the selected plan; material cost disadvantage vs alternatives; need for stronger infrastructure isolation (enterprise/regulated tenants).
