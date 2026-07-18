# ADR-006 — Application Architecture Style

1. **Title:** Modular monolith with separately scalable worker process
2. **Status:** Accepted (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** A small team must ship the MVP slice with trust-critical transactional paths (task + credit + approval + audit in single transactions). PRD §20 excludes microservice-per-agent, Kubernetes, Kafka, service mesh.
5. **Decision proposal:** One TypeScript codebase organized as enforced modules; two process types built from it — stateless `api` and background `worker`. Module boundaries via dependency rules (lint/build-enforced), not networks. Modules must be constructible in isolation with injected dependencies (test-rig constraint). Service extraction later happens along existing module seams.
6. **Requirement IDs:** NFR-005, NFR-013, TASK-009, APPR-009, ACT-002, NFR-004.
7. **Alternatives:** Microservices (network failure modes inside trust-critical paths; ops burden for a small team); serverless functions (poor fit for durable long-running work and in-tx audit writes); modular monolith without separate worker (AI latency starves API).
8. **Benefits:** Transactional integrity where trust requires it; single deploy pipeline; cheap refactoring while the domain is young; worker isolation for latency and least privilege.
9. **Costs:** Discipline needed to keep module boundaries real; single-language commitment.
10. **Risks:** Boundary erosion into a big ball of mud; worker/api version skew.
11. **Security implications:** Fewer network trust boundaries; single authz layer; worker runs least-privilege credentials.
12. **Operational implications:** Two process types to operate; one database; simple rollback.
13. **Reversal cost:** Medium — module seams are the designed extraction points.
14. **Scale trigger:** Sustained worker CPU saturation, or team growth (~8+) making independent deploys valuable.
15. **Open questions:** AOQ-06 (web framework), AOQ-05 (auth approach).
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted as written. Deploys as Render web service + background worker from one artifact (ADR-020).
Date: 2026-07-18
```
