# Deployment Architecture

Status: **Accepted with amendment (owner review 2026-07-18).** ADRs: ADR-018 (topology) + **ADR-020 (Render as initial provider)** + ADR-021 (Infisical) + ADR-022 (Clerk). Diagram: `diagrams/16`. Object-storage provider still open (AOQ-03); billing provider = AOQ-07. **No Kubernetes** (PRD §20); **no Render Workflows dependency**; **no Redis unless ADR-008 trigger evidence**. Single region (ADR-005; no strict-residency promise).

**Initial provider binding (ADR-020):** Render web service = `api` · Render background worker = `worker` · Render PostgreSQL = primary DB + durable jobs (ADR-008) · private networking between services · separate staging and production resources · one production region (selection = AOQ-20; plans = AOQ-21). Same repository and build artifact for both processes. **Documented exit path (not a portability promise):** standard PostgreSQL dump/restore; ordinary Node.js processes / portable containers; S3-compatible storage contract; source-controlled deploy config at implementation; exportable code and customer data.

## 1. MVP topology

| Unit | Form | Isolation rationale |
|---|---|---|
| Web frontend | Static/SSR assets — **may share the api deployment initially** | No independent scaling need at MVP |
| Backend/API process | One horizontally scalable stateless process | — |
| Background worker process | **Separate process from day one** (required isolation) | AI/long work must not affect API latency; independent scaling; least-privilege credentials (ADR-006/012) |
| PostgreSQL | Managed instance; also hosts durable job/workflow state (ADR-008) | One stateful system to operate, back up, and secure |
| Queue/durable workflow store | Inside Postgres (job tables) — no separate broker for MVP | ADR-008 rationale |
| Object storage | Managed S3-compatible bucket, tenant-prefixed paths | Artifact/document content |
| Secret manager | Managed KMS-backed store | ADR-014 |
| Monitoring/error tracking | External SaaS + structured logs/traces | ADR-017 |
| Model providers | External (primary + fallback vendors), gateway-mediated | ADR-004/011 |
| Billing provider | External hosted portal + webhooks (Phase 7) | BILL-004 |

**Shared vs isolated:** web+api may share; **worker is always a separate process**; Postgres/storage/secrets/monitoring are managed external services. Everything runs from one codebase and one deploy pipeline producing two process types (api, worker).

## 2. Environments

| Concern | Local | Test (CI) | Staging | Production |
|---|---|---|---|---|
| Purpose | Development | Automated suites (isolation, approval, replay) | Pre-release verification, restore drills | Live |
| Configuration | env-file, mock-friendly | Ephemeral per run | Prod-shaped, separate values | Authoritative |
| Secrets | Local dev secrets, never real | CI-scoped fakes | Separate secret-manager namespace | Separate namespace, least access |
| Database | Local Postgres | Ephemeral per suite | Dedicated instance | Dedicated instance |
| Object storage | Local emulator or dev bucket | Ephemeral buckets | Dedicated bucket | Dedicated bucket |
| Model providers | Mock gateway adapter (deterministic fixtures) | Mock + contract tests | Real providers, low caps | Real providers, full controls |
| Billing | Disabled | Mock | Provider test mode | Live |
| Migrations | Auto-apply | Fresh-apply per run | Gated apply, rehearsed | Controlled apply with rollback plan |
| Promotion | — | merge gate | deploy on green main | promote from staging after checks |
| Rollback | — | — | redeploy previous artifact | redeploy previous artifact; DB changes must be backward-compatible one release (expand-migrate-contract discipline) |

## 3. Platform-managed generated projects (future boundary)

Per ADR-002: generated customer applications are **not** part of the first knowledge-work slice and nothing here builds them. The topology preserves the later ability to add — in a **separate trust zone** (invariant 18): managed repositories per company; managed build/deploy with ephemeral sandboxes (SECURITY §1 worker-sandboxing trigger); customer-owned export always (BUILD-003/EXPORT); customer-owned infrastructure connections (hybrid direction, later ADR). No platform credentials, network paths, or shared runtimes cross that boundary.
