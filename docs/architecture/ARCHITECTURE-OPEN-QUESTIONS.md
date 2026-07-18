# Architecture Open Questions

Status: Maintained. IDs `AOQ-*` (distinct from product `OQ-*`). Classification: **[FOUNDATION]** blocks implementation foundation · **[PHASE]** blocks a later MVP phase · **[CONFIG]** non-blocking configuration choice · **[SCALE]** future scale choice · **[RESOLVED]** decided by owner with an accepted ADR. **No accepted product decision (ADR-001…005) is reopened here.**

> **2026-07-18 owner review:** the four foundation blockers are **resolved** — AOQ-01 → ADR-019 (GPT-5.1 primary / Claude Sonnet 4 fallback), AOQ-02 → ADR-020 (Render), AOQ-04 → ADR-021 (Infisical Cloud), AOQ-05 → ADR-022 (Clerk). Narrower implementation questions AOQ-18…24 added below. **Zero questions now block the implementation foundation.**

| ID | Question | Class | Notes / decision path |
|---|---|---|---|
| AOQ-01 | Exact primary and fallback models per task class | **[RESOLVED 2026-07-18 → `../decisions/ADR-019-initial-model-configuration.md`]** *(was FOUNDATION)* | Primary GPT-5.1 / fallback Claude Sonnet 4; exact snapshot pins = AOQ-18; evaluation thresholds = AOQ-19 |
| AOQ-02 | Hosting/database provider (= part of product OQ-26) | **[RESOLVED 2026-07-18 → `../decisions/ADR-020-initial-hosting-and-database-provider.md`]** *(was FOUNDATION)* | Render web service + background worker + Render PostgreSQL; region = AOQ-20; plans = AOQ-21 |
| AOQ-03 | Object-storage provider | [CONFIG] — **still open** (owner kept it separate) | S3-compatible API keeps this swappable |
| AOQ-04 | Secret-management provider | **[RESOLVED 2026-07-18 → `../decisions/ADR-021-secret-management-provider.md`]** *(was FOUNDATION)* | Infisical Cloud; machine-identity method = AOQ-22 |
| AOQ-05 | Authentication approach | **[RESOLVED 2026-07-18 → `../decisions/ADR-022-authentication-provider.md`]** *(was FOUNDATION)* | Clerk for identity/sessions; internal authz authoritative; social logins = AOQ-23; webhook sync = AOQ-24 |
| AOQ-06 | Web framework selection (React-based SSR/SPA) | [CONFIG] | Any mature TS option satisfies NFR-004/012 |
| AOQ-07 | Billing provider | [PHASE — Phase 7] | With D-02 resolution |
| AOQ-08 | Queue: confirm Postgres-backed jobs vs Redis queue (ADR-008 default) | [CONFIG] — ADR-008 was **accepted with amendment** at the 2026-07-18 review (Postgres-backed confirmed; no Redis without trigger evidence); retained open only as the evidence-trigger watchpoint, not as a pending decision | Triggers now binding in ADR-008 owner notes |
| AOQ-09 | Worker sandbox level for MVP — separate process suffices while no untrusted code executes in MVP; confirm | [CONFIG] now; **[PHASE]** hard requirement (ephemeral sandboxes) before software generation | SECURITY §1 escalation trigger |
| AOQ-10 | Realtime mechanism: confirm SSE + polling fallback | [CONFIG] | §14 alternatives table |
| AOQ-11 | Initial support tooling (correlation-ID lookup, support bundles) scope for beta | [PHASE — Phase 7] | OBSERVABILITY §3 |
| AOQ-12 | Data-retention periods per class (= product OQ-18) | [PHASE — before beta] | Owner + legal; NFR-016 |
| AOQ-13 | Audit-event retention period | [PHASE — before beta] | ≥ product-data retention; legal input |
| AOQ-14 | Initial usage caps, rate limits, alert thresholds (= product OQ-27) | [PHASE — before beta] | Needs alpha usage data (ADR-003 §16) |
| AOQ-15 | Backup/recovery objectives confirmation (RPO 24h / RTO 4h are NFR-017 proposals) | [PHASE — before beta] | Restore drill validates |
| AOQ-16 | Read-replica / partitioning strategy | [SCALE] | Not an MVP concern; triggers in ADR-018 |
| AOQ-17 | Durable-workflow engine adoption (Temporal-class) | [SCALE] | ADR-008 scale trigger (>~50 jobs/sec or multi-day sagas) |

## Follow-up questions from the 2026-07-18 provider decisions

| ID | Question | Class | Notes |
|---|---|---|---|
| AOQ-18 | Exact pinned API model identifiers/snapshots for GPT-5.1 and Claude Sonnet 4 | **[FOUNDATION-adjacent — blocks Phase 2 AI implementation]** | ADR-019 §8a: pin before implementation; record in configuration + ADR addendum |
| AOQ-19 | Initial model-evaluation thresholds (per the 10-area gate) | [PHASE — before Phase 2 AI features reach production paths] | ADR-019 §13; gate chooses config values only |
| AOQ-20 | Render production region | [PHASE — before staging setup, Phase 0/1] | With ADR-005 data-location documentation duties |
| AOQ-21 | Render service plans (api, worker, PostgreSQL) | [PHASE — Phase 0/1] | Sized against NFR-003/004; restore drill validates NFR-017 on chosen plan |
| AOQ-22 | Infisical machine-identity method | [PHASE — Phase 0 bootstrap] | Per-process identities recommended (ADR-021 §18) |
| AOQ-23 | Clerk social-login methods for the ADR-001 segment | [CONFIG] | Email/password baseline; socials chosen by segment fit |
| AOQ-24 | Clerk webhook synchronization strategy (ordering, backfill, drift reconciliation cadence) | [PHASE — Phase 1] | ADR-022 §13/§18; replay-safe consumers required |

**Foundation-blocking count: 0** (was 4 — all resolved via ADR-019…022). AOQ-18 blocks Phase 2 AI implementation specifically; remaining items are phase-scoped configuration.
