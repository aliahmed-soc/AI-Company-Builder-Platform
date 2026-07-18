# Architecture Owner Review — ADR-006 … ADR-018

**Date:** 2026-07-18 · **Reviewer:** Owner (decisions supplied) · **Recorder:** Claude (session under `.cursor/rules/model-routing.mdc`)
**Inputs:** Master PRD v1.1.0-draft, `REQUIREMENTS.csv`, accepted ADR-001…005, owner provider selections (AOQ-01→ADR-019, AOQ-02→ADR-020, AOQ-04→ADR-021, AOQ-05→ADR-022), architecture invariants, MVP non-goals, launch gates.
**Method:** each ADR reviewed individually against its mapped requirements — no bulk acceptance.

## Result table

| ADR | Title | Recommendation | Owner result | Required amendment | Risk accepted |
|---|---|---|---|---|---|
| ADR-006 | Application architecture style | Accept | **Accepted** | — | Module-boundary erosion (mitigated by lint-enforced dependencies) |
| ADR-007 | Tenancy and data isolation | Accept | **Accepted** | — | RLS/pool complexity (tested per-request set/reset) |
| ADR-008 | Task and workflow execution | Accept with amendment | **Accepted with amendment** | Explicit capacity/migration triggers recorded (below); no Redis unless evidence; runs on Render PostgreSQL (ADR-020) | Postgres queue throughput ceiling (bounded by stated triggers) |
| ADR-009 | Approval enforcement model | Accept | **Accepted** | — | Hash-normalization bugs fail closed (UX cost only) |
| ADR-010 | Policy evaluation model | Accept | **Accepted** | — | Rule gaps default to most-restrictive |
| ADR-011 | Model gateway contract | Accept with amendment | **Accepted with amendment** | Initial model configuration recorded **separately** in ADR-019; gateway contract stays configuration-free | Two-adapter maintenance |
| ADR-012 | Worker and tool boundaries | Accept | **Accepted** | — | Chokepoint latency (cheap checks, metered) |
| ADR-013 | Usage and cost ledger | Accept (incl. account rollups) | **Accepted** | USAGE-001 amendment executed this review (account rollups now in the requirement text) | Reconciliation drift (alerted) |
| ADR-014 | Credential and secret management | Accept with amendment | **Accepted with amendment** | Infisical Cloud bound as provider (ADR-021); bootstrap-only env vars; outage behavior documented | Vault outage blocks credential actions (fail closed — intended) |
| ADR-015 | Activity and audit events | Accept | **Accepted** | — | Audit volume growth (partition/archive) |
| ADR-016 | Generated artifact storage | Accept **only if provider contract portable** | **Accepted with condition satisfied** | Condition verified: contract is S3-compatible + open formats; provider selection stays open (AOQ-03) | Two-store consistency (commit-order rule) |
| ADR-017 | Observability and error handling | Accept | **Accepted** | — | Redaction gaps (double-scanner net) |
| ADR-018 | MVP deployment topology | Accept with amendment | **Accepted with amendment** | Render bound as initial provider (ADR-020); single region; **no strict-residency promise** restated | Single-region availability ceiling (accepted for beta) |

**Summary: 8 accepted as written · 5 accepted with amendment · 0 rejected · 0 deferred.** All 13 ADR files updated to `Status: Accepted` with owner blocks filled and amendments noted.

## Detailed dispositions

### ADR-006 — Application architecture style — ACCEPTED
Satisfies NFR-005/013, TASK-*, APPR-* transactional needs. Consistent with PRD §20 exclusions and the small-team operational constraint. Deployment maps cleanly onto Render web service + background worker from one artifact (ADR-020). No amendment needed.

### ADR-007 — Tenancy and data isolation — ACCEPTED
Two-layer enforcement (app scoping + RLS) directly serves launch gates 1/2 and invariants 1/2/19. Render PostgreSQL is standard Postgres, so the RLS layer carries over unmodified — provider selection introduces no isolation change. Clerk's arrival (ADR-022) does **not** weaken this: Clerk supplies identity only; internal membership remains the tenant authority (reviewed against the required authorization flow — no conflict).

### ADR-008 — Task and workflow execution — ACCEPTED WITH AMENDMENT
Postgres-backed durable jobs satisfy TASK-001/009, NFR-005/006/007 with transactional enqueue. **Amendment (recorded here and in the ADR):** (a) capacity triggers made explicit and binding — sustained >50 jobs/sec, or job-table p95 pickup latency >5s over 24h, or multi-day cross-service sagas → evaluate Temporal-class engine (AOQ-17); sustained DB connection pressure from queue polling → evaluate dedicated queue (Redis-class) *only on that evidence* (owner boundary: no Redis dependency without demonstrated need); (b) runs on Render PostgreSQL with private networking (ADR-020); **no Render Workflows dependency for MVP**; (c) job/workflow tables must remain standard SQL (exit-path requirement).

### ADR-009 — Approval enforcement model — ACCEPTED
Payload-hash binding + dispatcher-point enforcement satisfies APPR-004/005/006/009 and launch gates 3/4. Invariant 5 actor-type restriction confirmed compatible with Clerk: approval authority derives from **internal** role checks, never from Clerk claims (ADR-022 boundary).

### ADR-010 — Policy evaluation model — ACCEPTED
Deterministic, versioned, fail-closed, three evaluation points; model classifications as untrusted inputs. Satisfies POL-001/005/006, TOOL-003, PRD principles 16/17/21. No provider decision touches it.

### ADR-011 — Model gateway contract — ACCEPTED WITH AMENDMENT
The internal contract implements accepted ADR-004 faithfully (schema-first, one primary + one fallback, no routing). **Amendment:** the gateway ADR remains configuration-free; the **initial model configuration (primary GPT-5.1, fallback Claude Sonnet 4) is recorded separately in ADR-019** with the evaluation gate, non-silent-fallback rule, and pinned-snapshot follow-up. Provider-specific prompt dialects stay behind gateway adapters (owner boundary: no provider names in product-domain modules).

### ADR-012 — Worker and tool boundaries — ACCEPTED
Registry-enforced allowlists + single dispatcher chokepoint satisfy WORK-005, TOOL-001..003, NFR-021, invariants 4/17. The structural zero-external-actions MVP boundary is exactly what the PRD demands. Sandbox escalation trigger (before generated code executes) reaffirmed.

### ADR-013 — Usage and cost ledger — ACCEPTED
Append-only events + credit transactions + derived account rollups + five-number separation satisfy USAGE-001, BILL-002, NFR-015 and the ADR-003 binding refinement. The **USAGE-001 specification amendment** was executed as part of this review (see PRD change log 1.2.0-draft): account-level aggregation, reconciliation, no-double-counting, and compensating corrections are now requirement text, not just architecture. D-02 neutrality preserved.

### ADR-014 — Credential and secret management — ACCEPTED WITH AMENDMENT
Pattern (opaque references, server-side resolution, per-component grants) satisfies NFR-018/INTEG-002. **Amendment:** provider bound to **Infisical Cloud** (ADR-021): dev/test/staging/prod scopes; machine identities per process type; least-privilege paths; env vars for bootstrap only; short-lived controlled caching; no enterprise dynamic-secrets dependency; outage behavior = fail closed for credential-using actions with cached-lease grace where operationally necessary (documented in ADR-021). Hosting-provider env vars are **not** the store for dynamic per-tenant integration credentials (owner boundary honored).

### ADR-015 — Activity and audit events — ACCEPTED
Append-only audit + in-transaction writes for high-risk operations + activity projection satisfy ACT-001/002/003, NFR-008, invariant 11, launch gate 11. No provider impact.

### ADR-016 — Generated artifact storage — ACCEPTED (portability condition satisfied)
Owner condition: accept **only if the provider contract remains portable.** Verified: the ADR specifies an S3-compatible contract, open formats (Markdown/JSON), content-addressed keys, tenant-prefixed paths — no provider-proprietary API in the contract. Object-storage provider selection remains **open (AOQ-03)** per the owner's instruction that it stays separate unless already resolved.

### ADR-017 — Observability and error handling — ACCEPTED
Correlation threading, redaction pipeline, normalized errors satisfy NFR-009, TASK-006, launch gate 12 support. Render log/metric surfaces complement but do not replace the structured pipeline.

### ADR-018 — MVP deployment topology — ACCEPTED WITH AMENDMENT
Topology (api + worker processes, managed Postgres/storage/secrets, no k8s, single region) stands. **Amendment:** initial provider bound to **Render** (ADR-020): web service (api), background worker, Render PostgreSQL with private networking; separate staging/production resources; one production region for beta; **no strict-residency promise** (ADR-005 restated); no Render Workflows; exit path documented (standard Postgres dumps, ordinary Node processes/containers, S3-compatible storage contract, source-controlled deploy config at implementation, exportable code/data). **No one-click portability promise.**

## Consistency confirmations

- No accepted product decision (ADR-001…005) is contradicted by any disposition above.
- Dynamic routing remains excluded; one primary + one fallback only (ADR-019 records config).
- BYOK remains post-MVP; provider keys server-side (ADR-019/021).
- Full infrastructure portability remains un-promised; exit path ≠ portability promise (ADR-020).
- Clerk is identity-only; the platform backend remains the tenant/authorization authority (ADR-022; invariant 2 intact).
- PRD remains **Draft for owner review — architecture-blocking decisions resolved** (not fully approved).
