# Test and Verification Strategy

Status: Proposed for owner review. Layers defined now; implemented incrementally from M0 (testing is never a single final ticket — each phase lands its layer additions).

## Test layers

| Layer | Responsible modules | Environments | Data strategy | Mocking policy | Real-provider policy | Entry gate (runs from) | Release gate | Reqs | ADRs |
|---|---|---|---|---|---|---|---|---|---|
| Static analysis (lint, typecheck, import boundaries, secret scan) | all | local + CI | n/a | n/a | n/a | M0 | every gate | NFR-010/013/018 | 006, 017 |
| Unit tests | domain, contracts, observability, config | local + CI | in-memory | fakes from test-support | never | M0 | every gate | NFR-013 | 006 |
| Domain tests (state machines, invariants) | domain | local + CI | transition-table fixtures | none needed (pure) | never | M1 | dev-foundation+ | TASK-001, APPR lifecycle | 008, 009 |
| Contract tests (API/event/gateway schemas) | contracts, apps/web, gateway | CI | schema fixtures | schema-level | never | M1 | alpha+ | TOOL-002 | 011, 015 |
| Persistence integration (repos, RLS, migrations) | database | CI ephemeral Postgres | seeded multi-tenant fixtures | no mocks — real Postgres | n/a | M1 | every gate | NFR-001 | 007, 020 |
| Provider-adapter tests | adapters, gateway | CI (mock) + staging (sandbox) | recorded fixtures | mock in CI | sandbox/test-mode in staging only | M1 (Clerk), M2 (models) | alpha+ | ACC-002, NFR-019 | 019, 021, 022 |
| Workflow tests (jobs, checkpoints, resume) | core/workflows, apps/worker | CI ephemeral Postgres | scripted job fixtures | fake gateway | never in CI | M5 | beta | NFR-005/007 | 008 |
| Authorization tests (negative per endpoint) | core/identity, apps/web | CI | role-matrix fixtures | fake Clerk assertions incl. forged claims | staging smoke with real Clerk | M1 | every gate | NFR-002 | 022 |
| Tenant-isolation tests (adversarial) | database, core/tenancy | CI + staging probes | two-tenant adversarial fixtures | none — real stack | staging probes continuous | M1 | **every gate, 100% pass** | NFR-001 | 007 |
| API tests | apps/web | CI | seeded fixtures | fake gateway/adapters | staging smoke real | M1 | alpha+ | per-domain | 006 |
| Worker tests | apps/worker, core/workers | CI | scripted tasks | fake gateway + fake tools | staging with real models (capped) | M5 | beta | WORK-* | 012 |
| Model-evaluation tests (the ADR-019 10-area gate) | gateway + eval harness | dedicated eval runs | curated eval dataset (P0-002) | none — real models, both configured | yes, budget-capped | M2 (areas 1–3), M3 (4), M5 (5–7), M7 (all 10) | **beta gate** | DISC/STRAT/WORK quality | 019 |
| Browser/E2E tests | apps/web | CI headless + staging | scripted MVP-loop personas | fake gateway in CI; real in staging run | staging | M1 (slice A) growing per slice | beta | slices A–F | — |
| Failure-injection tests | gateway, workflows, adapters | CI + staging | fault fixtures (timeout, crash, outage, invalid output) | fault-injecting fakes | controlled staging drills | M5 | beta | NFR-005/019/020 | 008, 011 |
| Performance tests | apps/web, gateway | staging | volume fixtures | real stack | staging | M6 | beta (NFR-004 targets) | NFR-004 | 018 |
| Migration tests | database | CI + staging rehearsal | production-shaped snapshots | none | staging rehearsal mandatory | M1 | every gate | NFR-017 | 020 |
| Release smoke tests | all | staging + production | synthetic tenant | none | real | M7 | every deploy | — | 018 |

## Trust-critical negative tests (mandatory, mapped to tickets in BACKLOG.csv)

1. Tenant A cannot retrieve Tenant B's company. *(P1-014)*
2. Tenant A cannot guess/enumerate Tenant B's artifacts (IDs, storage paths, exports). *(P1-014, P5-011, P7-001)*
3. A worker cannot run without explicit tenant context. *(P5-001/005)*
4. A tool not in the worker allowlist is denied. *(P5-003)*
5. Model output cannot approve an action. *(P6-003/004)*
6. Editing a material approved payload invalidates approval. *(P6-005)*
7. Expired approval cannot execute. *(P6-004)*
8. Revoked integration cannot execute. *(rig in P6-002; full when integrations exist)*
9. Paused company cannot start new autonomous work. *(P6-007)*
10. Emergency stop blocks new external execution (all scopes, ≤5s). *(P6-007)*
11. Replayed jobs do not duplicate authoritative effects. *(P6-011)*
12. Duplicate usage messages do not double count. *(P6-009/011)*
13. Usage corrections create compensating records (never edits). *(P6-009)*
14. Account usage equals the deterministic sum of eligible company usage. *(P6-009)*
15. Provider keys never appear in browser responses. *(P0-019, P7-007)*
16. Secret values never appear in logs or audit payloads. *(P0-017, P7-007)*
17. Raw untrusted content cannot directly trigger a tool call (injection corpus). *(P5-003/006, P7-007)*
18. Failed model output cannot create a completed task. *(P5-010/013)*
19. Silent fallback does not occur for a material decision. *(P5-009)*
20. A user cannot obtain elevated authority by altering a Clerk organization or role value in the client. *(P1-007, P1-014)*

## Verification discipline

Each ticket's `Verification procedure` is executable (command or scripted steps) and its evidence is recorded in the completion handoff. Slice tickets (A–F) run the demo script plus their negative-test set. Release gates re-run the accumulated gate suites — nothing passes on prior green alone.
