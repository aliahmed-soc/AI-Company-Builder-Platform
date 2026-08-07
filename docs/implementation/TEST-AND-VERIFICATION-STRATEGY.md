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
| Browser/E2E tests | apps/web | CI headless + staging | scripted MVP-loop personas | fake gateway in CI; real in staging run | staging | **staging, once company screens exist** (deferred from M1 by CDR-021 — the slice-A flows are API-only, so there is nothing to drive in a browser) | beta | slices A–F | — |
| Full-stack journey tests | apps/web → real PostgreSQL | CI + `pnpm demo:slice-a` | real route handlers over the restricted role; provider SDK seamed at its edge | synthetic Clerk | CI | M1 (slice A) growing per slice | beta | slices A–F | CDR-021 |
| Failure-injection tests | gateway, workflows, adapters | CI + staging | fault fixtures (timeout, crash, outage, invalid output) | fault-injecting fakes | controlled staging drills | M5 | beta | NFR-005/019/020 | 008, 011 |
| Performance tests | apps/web, gateway | staging | volume fixtures | real stack | staging | M6 | beta (NFR-004 targets) | NFR-004 | 018 |
| Migration tests | database | CI + staging rehearsal | production-shaped snapshots | none | staging rehearsal mandatory | M1 | every gate | NFR-017 | 020 |
| Release smoke tests | all | staging + production | synthetic tenant | none | real | M7 | every deploy | — | 018 |

## Trust-critical negative tests (mandatory, mapped to tickets in BACKLOG.csv)

1. Tenant A cannot retrieve Tenant B's company. *(P1-014)*
2. Tenant A cannot guess/enumerate Tenant B's artifacts (IDs, storage paths, exports). *(P1-014, P5-011, P7-001)*
3. A worker cannot run without explicit tenant context. *(P5-001a — the enqueue proof. **`/005` is UNEARNED**: `workers/runtime.ts:1` and `migrations/0040_worker_runs.ts:1` both DECLARE this negative, and no worker-runtime entry point is driven with absent context — ACBP-P7-007.)*
4. A tool not in the worker allowlist is denied. *(P5-003/004 — P5-003 built the chokepoint; the proof that the enforced list is the worker's own registered allowlist is P5-004's. Corrected by ACBP-P7-007.)*
5. Model output cannot approve an action. *(P6-003/004)*
6. Editing a material approved payload invalidates approval. *(P6-005 — **built**; launch gate 4. Evidence:
   `policy-enforcement.integration.test.ts` `describe('gate 4 …')` — one case per bound element plus a control,
   each ending at the dispatcher and each asserting the approval is not burned; rebinding in
   `approval-service.integration.test.ts`. Index in CDR-070 §2.)*
7. Expired approval cannot execute. *(P6-004 — proven at the REPOSITORY layer only. "Cannot EXECUTE" is never asserted at `dispatchToolCall`: both dispatcher suites contain zero expired-approval cases, while every sibling approval state has one. ACBP-P7-007.)*
8. Revoked integration cannot execute. *(**NOT BUILT, and the claimed rig does not exist.** There is no integrations entity anywhere — no table, no migration, no service, no contract, and no integration-related value in `TOOL_DENIAL_REASONS`. CDR-067, P6-002's own decision record, never mentions integrations. Cannot go green until integrations exist — ACBP-P7-007; CDR-080 §7.)*
9. Paused company cannot start new autonomous work. *(**P7-002**, not P6-007 — `packages/core/src/company/gate-14.integration.test.ts`. P6-007 shipped no company-lifecycle gate; nothing read `companies.status` before doing autonomous work until ACBP-P7-002 built the gate. Corrected by ACBP-P7-007.)*
10. Emergency stop blocks new external execution (all scopes, ≤5s). *(P6-007 — but "all scopes" is **five ENFORCEABLE scopes**, and the timing helper NAMED `activateStop` is a raw INSERT rather than the production use case, so the measured interval EXCLUDES activation. Annotated by ACBP-P7-007.)*
11. Replayed jobs do not duplicate authoritative effects. *(P6-011, on foundations from P5-001b (checkpoints) and P5-003b (per-tool idempotency) — ACBP-P7-007. `idempotencyKey` is caller-supplied and optional; no production producer derives one.)*
12. Duplicate usage messages do not double count. *(P6-009/011)*
13. Usage corrections create compensating records (never edits). *(P6-009)*
14. Account usage equals the deterministic sum of eligible company usage. *(P6-009)*
15. Provider keys never appear in browser responses. *(P0-019, P7-007)*
16. Secret values never appear in logs or audit payloads. *(P0-017, P7-007)*
17. Raw untrusted content cannot directly trigger a tool call (injection corpus). *(**P5-003c** built the suite; the **P5-006 credit is unearned** — ACBP-P7-007. ACBP-P6-002/CDR-067 §2-G9 restored this boundary after it went DEAD and is uncredited. Three gaps remain: `params.args` is never inspected, anything past `detectInjection`'s 64,000-character slice is unseen, and untrusted context PLUS a standing approval is AUTHORIZED by design and untested.)*
18. Failed model output cannot create a completed task. *(**P5-011 and P6-008**, not P5-010/013 — P5-010 self-files as "groundwork" and its own review coverage calls the criterion "honestly HALF met". Corrected by ACBP-P7-007. The seeded run state is `running`, not `failed`, so the claim AS WORDED is covered by construction rather than by execution.)*
19. Silent fallback does not occur for a material decision. *(P5-009 built the suite; the mechanism is P2-003 — ACBP-P7-007. Two assertions in that suite could not fail and were fixed by ACBP-P7-007; which decisions are MATERIAL is still unpinned for several template families.)*
20. A user cannot obtain elevated authority by altering a Clerk organization or role value in the client. *(P1-007, P1-014)*

## Verification discipline

Each ticket's `Verification procedure` is executable (command or scripted steps) and its evidence is recorded in the completion handoff. Slice tickets (A–F) run the demo script plus their negative-test set. Release gates re-run the accumulated gate suites — nothing passes on prior green alone.
