# Repository Scaffold Specification

Status: Proposed for owner review. **This document specifies the future repository — nothing here is created by the planning task.** Executed by ticket ACBP-P0-011 after wave approval.

## Recommended structure

A TypeScript monorepo (workspace-based) with two apps and consolidated packages. The suggested 28-package layout was evaluated and **consolidated to 12 packages** — separate packages for every domain module would create version/boundary overhead without enforcement benefit at this team size; module boundaries inside `core` are enforced by import-lint rules instead (same guarantee, less ceremony).

```text
apps/
├── web/          # web client + API host process (ADR-006 api process)
└── worker/       # background worker process (ADR-006; Render background worker)

packages/
├── contracts/    # shared types, zod schemas, API/event/gateway contracts, error taxonomy
├── domain/       # pure domain logic: entities, state machines, invariants (no I/O)
├── core/         # application modules (one folder per module, import-lint-fenced):
│               #   identity, tenancy, accounts, companies, discovery, understanding,
│               #   strategy, planning, tasks, workflows, workers, tools, policy,
│               #   approvals, memory, documents, activity, audit, usage, exports, admin
├── database/     # Postgres access, migrations, RLS policies, tenant-scoped repo layer
├── gateway/      # model gateway: internal contract impl + provider adapters (ADR-011/019)
├── adapters/     # external provider adapters: clerk/, infisical/, storage/ (ADR-020..022)
├── observability/# logging, redaction pipeline, correlation, metrics, traces (ADR-017)
├── config/       # bootstrap config loading + validation (bootstrap-only env vars)
└── test-support/ # fixtures, fakes, adversarial harnesses (never in production bundles)
```

## Per-package specification

| Package | Responsibility | Allowed deps | Forbidden deps | Owned contracts | Owned persistence | Test responsibility | Runtime | Req IDs | ADRs |
|---|---|---|---|---|---|---|---|---|---|
| apps/web | HTTP host, routing, SSE, UI; composes core modules | core, contracts, config, observability | database directly (must go through core), adapters directly, test-support | Public REST/SSE surface | none | API + E2E tests | api | NFR-002/004 | 006, 018 |
| apps/worker | Job pickup, worker runtime host | core, contracts, config, observability | UI code; adapters directly | Job-consumption contract | none | Worker + workflow tests | worker | NFR-005, WORK-* | 006, 008, 012 |
| contracts | Types, schemas, error taxonomy, event envelope, gateway request/response | (none — leaf) | everything else | All shared contracts | none | Schema tests | both | TOOL-002, NFR-009 | 011, 015 |
| domain | Entities, state machines, pure invariants | contracts | **any SDK, database, adapters, gateway** | State-machine transition tables | none | Domain unit tests | both | TASK-001, APPR-004 semantics | 006, 008, 009 |
| core | Application modules; orchestrates domain + database + gateway/adapters via contracts | domain, contracts, database, gateway (via interface), adapters (via interface), observability | provider SDKs directly; UI | Module APIs; policy/approval/dispatcher engines | via database pkg | Module + integration tests | both | most functional reqs | 006–017 |
| database | Connection, migrations, RLS, tenant-scoped repositories, job tables | contracts, config, observability | domain (inverted: core passes data), SDKs | Repository interfaces (tenant-context-required) | **all Postgres** | Persistence integration tests incl. RLS | both | NFR-001, invariants 1/2 | 007, 008, 020 |
| gateway | ADR-011 contract; OpenAI + Anthropic adapters; usage/cost recording hooks; redaction | contracts, config, observability, adapters/infisical (key resolution via interface) | domain, core, database (emits usage via callback contract) | ModelRequest/ModelResponse | none (records via core) | Adapter contract tests + fault injection | worker (and api for interview) | NFR-019, USAGE-001 | 004, 011, 019 |
| adapters | clerk/ (identity assertions, webhooks), infisical/ (secret resolution), storage/ (S3-compatible) | contracts, config, observability | domain, core, database | Provider-neutral interfaces defined in contracts, implemented here | none | Provider-adapter tests (mock + sandbox) | both | ACC-001/002, INTEG-002, TASK-005 | 014, 016, 021, 022 |
| observability | Structured logging, redaction, correlation, metrics | contracts, config | everything else | Log/trace/metric API | none | Redaction negative tests | both | NFR-009/018 | 017 |
| config | Bootstrap env loading + validation | contracts | everything else | Config schema | none | Validation negative tests | both | NFR-018 (bootstrap rules) | 021 |
| test-support | Fakes (gateway, clock, vault), fixtures, adversarial harnesses | all (dev-only) | — (but **never imported by production code** — lint-enforced) | Test utilities | ephemeral | n/a | dev/CI only | — | — |

## Required dependency rules (import-lint enforced, ACBP-P0-012)

1. `domain` never imports Clerk, Render, Infisical, or model-provider SDKs — nor any I/O package.
2. Product modules (`core/*`) use internal contracts, never provider SDKs directly.
3. Worker definitions never call provider tools directly — tool execution occurs **only** through the dispatcher (`core/tools`).
4. Authorization cannot depend on browser state — `core/identity`/`core/tenancy` take server-derived context only.
5. Tenant scope is established before repository access — `database` repository constructors require tenant context (compile-level).
6. Audit and usage events are not optional after successful authoritative mutations — mutation helpers in `core` bundle them transactionally.
7. Provider adapters depend inward on platform contracts (`contracts`), never outward on `core`/`domain`.
8. UI modules (`apps/web` views) cannot import `database`.
9. `test-support` never reaches production bundles (build-level exclusion + lint).
10. Cross-module imports inside `core` go through each module's public index (no deep imports) — keeps later package extraction possible (ADR-006 seams).

## Technology selection

| Capability | Accepted (ADR) | Recommended | Acceptable alternative | Deferred decision | Reversal cost |
|---|---|---|---|---|---|
| Language/runtime | TypeScript/Node (ADR-006) | Node LTS current at scaffold time | — | exact version pin at scaffold | Low |
| Hosting/DB | Render + Render PostgreSQL (ADR-020) | — | — | region/plans (P0-003/004) | Low-Med |
| Identity | Clerk (ADR-022) | — | — | social logins (P0-007) | Med |
| Secrets | Infisical Cloud (ADR-021) | — | — | machine-identity method (P0-006) | Med |
| Models | GPT-5.1 primary / Claude Sonnet 4 fallback (ADR-019) | — | — | snapshot pins (P0-001) | Low |
| Job runner | Postgres-backed (ADR-008) | pg-boss or graphile-worker (evaluate at P5-001) | — | library choice at P5-001 | Low-Med |
| Web framework | — | React-based TS framework (SSR or SPA per team familiarity) | Any mature TS framework | at scaffold | Low |
| ORM/query | — | Type-safe SQL layer compatible with RLS session settings | — | at P0-018 | Med |
| Object storage | S3-compatible contract (ADR-016) | — | — | provider (P0-005) | Low |
| Validation | — | zod-class schema library (contracts pkg) | — | at scaffold | Low |
No new vendors beyond ADR-019..022 without architectural need. Framework versions pinned at scaffold time, not here.
