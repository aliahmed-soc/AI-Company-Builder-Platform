# ADR-018 — MVP Deployment Topology

1. **Title:** Single-region managed-services topology: api + worker processes, managed Postgres/storage/secrets, no Kubernetes
2. **Status:** Accepted with amendment (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** ADR-002 (managed defaults), ADR-005 (single region permitted, non-foreclosure binding), PRD §20 (no k8s/multi-region), NFR-003/017 targets.
5. **Decision proposal:** One region. Application platform (PaaS or container-hosting VMs — provider AOQ-02-adjacent) runs two process types from one codebase: stateless `api` ×N (serves web assets, REST, SSE) and `worker` ×M (separate from day one). Managed PostgreSQL (also durable-job store per ADR-008, backups meeting RPO ≤24h), managed S3-compatible storage, managed secret store, external monitoring SaaS, external model providers via gateway, external billing provider (Phase 7). Environments local/test/staging/production with separated config, secrets namespaces, databases, buckets; provider test modes below production; migration discipline: expand-migrate-contract, one-release backward compatibility, rehearsed in staging; rollback = redeploy previous artifact. Future generated-app zone is a separate trust zone (invariant 18) — designed for, not built. Regional expansion not foreclosed: no region-hardcoded identifiers in data or storage paths (ADR-005 discipline).
6. **Requirement IDs:** NFR-003, NFR-005, NFR-011, NFR-017, ADR-002/005 obligations; DEPLOY-001 (future boundary).
7. **Alternatives:** Kubernetes (excluded by PRD §20; ops burden unjustified); serverless-everything (poor durable-work fit); single process for api+worker (AI work starves API latency — rejected).
8. **Benefits:** Minimal ops for a small team; clean promotion path; honest recovery story.
9. **Costs:** PaaS pricing premium; provider selection work (AOQ-02/03/04).
10. **Risks:** Provider limits discovered late (staging is prod-shaped to surface them); single-region availability ceiling (accepted for beta, NFR-003).
11. **Security implications:** Managed services carry SOC2-class baselines; subprocessor register (ADR-005) documents them.
12. **Operational implications:** Restore drills pre-beta + quarterly (NFR-017); deployment promotion on green staging.
13. **Reversal cost:** Low-Medium (stateless processes move easily; data migration is the real cost of any provider change).
14. **Scale trigger:** Sustained load beyond PaaS economics → container platform; regional expansion → new-region ADR (ADR-005 trigger).
15. **Open questions:** AOQ-02/03/04 (providers), AOQ-15 (backup objective confirmation).
16. **Owner approval:**

```text
Owner decision:
[ ] Accept   [x] Accept with changes   [ ] Reject   [ ] Defer
Notes: AMENDMENT — initial provider bound to Render (ADR-020): web service (api), background worker, Render PostgreSQL, private networking, separate staging/production, one production region for beta. No Render Workflows dependency; no strict-residency promise (ADR-005 restated); exit path documented; no one-click portability promise.
Date: 2026-07-18
```
