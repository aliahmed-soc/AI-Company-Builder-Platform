# Architecture — AI Company Builder Platform

**Status: Accepted by owner (2026-07-18).** ADR-006…018 accepted (5 with amendment) — dispositions in `ARCHITECTURE-OWNER-REVIEW.md`; provider selections accepted as ADR-019 (models: GPT-5.1 primary / Claude Sonnet 4 fallback), ADR-020 (Render), ADR-021 (Infisical Cloud), ADR-022 (Clerk — identity only; internal authorization authoritative). Derived from Master PRD v1.2.0-draft and `REQUIREMENTS.csv` (canonical IDs). Foundation-blocking questions: **0** (AOQ-01/02/04/05 resolved; narrower AOQ-18…24 phase-scoped). **No application code, migrations, infrastructure config, or tickets exist yet, by design.**

| Document | Contents |
|---|---|
| `TECHNICAL-ARCHITECTURE-v1.md` | Anchor: summary, drivers, quality attributes, boundaries, logical/deployment architecture, alternatives, technology recommendations, **20 architectural invariants**, verification strategy |
| `COMPONENT-CATALOG.md` | 28 components with form (module/worker/infra/external/future), data, contracts, failure behavior |
| `DATA-ARCHITECTURE.md` | 41 logical objects, tenant-isolation design, facts-vs-assumptions provenance model |
| `API-CONTRACTS.md` | 25 implementation-neutral API domains + global mutation rules |
| `EVENT-CATALOG.md` | Proposed event contracts (envelope + ~45 events) — ours, not Polsia internals |
| `WORKFLOW-STATE-MACHINES.md` | Company, interview, strategy, task, approval, tool-call machines with legal transitions |
| `APPROVAL-AND-POLICY-ARCHITECTURE.md` | Authority chain, payload binding, scopes, deterministic policy engine, 3 evaluation points |
| `AI-AND-WORKER-ARCHITECTURE.md` | Gateway contract, worker definitions (research/strategy/document), injection boundaries |
| `USAGE-AND-BILLING-ARCHITECTURE.md` | Five-number separation, append-only ledgers, account rollups, charging rules |
| `SECURITY-ARCHITECTURE.md` | Full control matrix, secrets rules, administrative access |
| `FAILURE-AND-RECOVERY.md` | 16 failure scenarios × detection/retry/status/recovery |
| `OBSERVABILITY-AND-OPERATIONS.md` | Telemetry, required metrics, dashboards, runbooks |
| `DEPLOYMENT-ARCHITECTURE.md` | MVP topology, environments, future generated-project boundary |
| `REQUIREMENT-TRACEABILITY.csv` | Every requirement → component/document/ADR/verification |
| `ARCHITECTURE-OPEN-QUESTIONS.md` | AOQ-01…17 classified; 4 foundation-blocking |
| `diagrams/` | 16 Mermaid diagrams (context, containers, flows, isolation, stops, recovery, topology) |

Proposed ADRs: `../decisions/ADR-006…ADR-018` (all `Status: Proposed`).

**Rules:** architecture must not change product behavior (PRD amendment or accepted ADR required); requirement IDs come only from `../../product-specification/REQUIREMENTS.csv`; Halo Suite / Systevo material excluded; Polsia internals are unknown and never assumed (PRD §10).
