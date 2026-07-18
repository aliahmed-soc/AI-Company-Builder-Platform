# Implementation Roadmap v1 — AI Company Builder Platform

## Document control

| Field | Value |
|---|---|
| Title | Implementation Roadmap v1 |
| Version | 1.1.0 |
| Status | **Approved by owner (2026-07-18)** — roadmap, milestone plan, first implementation wave, and the 101-ticket backlog approved as the working implementation plan |
| Approval conditions | (1) **Mandatory DoR split review** for ACBP-P5-001, ACBP-P5-003, ACBP-P6-001, ACBP-P6-007 — split any whose trust boundaries, failure modes, or verification cannot complete as one coherent change (recorded in their DoR fields). (2) Backlog remains amendable via controlled planning changes only; **every backlog change updates traceability**. (3) Accepted requirements and ADRs remain authoritative; approval does not authorize silent PRD/ADR changes. (4) Application implementation is **not started** by this approval. |
| Product version | AI Company Builder Platform MVP |
| PRD version | Master PRD v1.2.0-draft |
| Architecture version | Technical Architecture v1.1.0-accepted |
| Accepted ADR range | ADR-001 … ADR-022 (all accepted) |
| Creation date | 2026-07-18 |
| Change log | 1.0.0 (2026-07-18): initial roadmap from PRD v1.2.0-draft + ADR-001…022 · 1.1.0 (2026-07-18): owner approval recorded with conditions; Phase 0 decision sprint executed — 9/10 decision tickets resolved (CDR-001…009), ACBP-P0-005 BLOCKED pending owner object-storage selection; see PHASE-0-DECISION-PACK.md and PHASE-0-EXECUTION-ORDER.md |

Canonical registries: requirements `../../product-specification/REQUIREMENTS.csv` · tickets `BACKLOG.csv` · mappings `REQUIREMENT-TO-TICKET-TRACEABILITY.csv`.

## Planning principles

1. Vertical delivery over horizontal component completion — every phase ends in a demonstrable user outcome (slices A–F).
2. One complete usable flow before broad capability expansion — the MVP loop is the product until it works end to end.
3. Security and tenant isolation from the first database-backed feature (P1, not P6).
4. Audit and usage recording built **with** business mutations, not retrofitted (audit foundation lands in Phase 1; usage events land with the first model call in Phase 2).
5. Server-side enforcement before UI controls.
6. Negative tests accompany every trust-critical requirement (TEST-AND-VERIFICATION-STRATEGY.md §Trust-critical).
7. No fake or placeholder success states (invariant 20 applies to the build itself).
8. No external action without an explicit approved scope — MVP workers structurally have no external tools (ADR-012).
9. No dependency added solely for hypothetical scale (no Redis/Kafka/k8s; ADR-008/018 triggers govern).
10. Every implementation ticket references requirement IDs and governing ADRs.
11. Every ticket has an executable verification procedure.
12. Every milestone ends with a demonstrable user outcome (MILESTONE-PLAN.md).

## Roadmap summary — phases

Sizing: T-shirt (XS–XL) per ticket; no calendar dates (no team/capacity data). Phase totals from `BACKLOG.csv` (101 tickets).

### Phase 0 — Engineering foundation (21 tickets: 10 Decision + 11 Foundation)
- **Purpose:** a repository another agent can safely build in: boundaries, checks, contracts, and the ten blocking configuration decisions.
- **User-visible outcome:** none (deliberately) — M0 demo is a trustworthy empty platform.
- **Epics:** Blocking decisions · Repository & boundaries · Quality gates (static/tests/CI) · Runtime foundations (config, errors, logging, DB, adapters, local dev).
- **Entry criteria:** this roadmap approved; scaffold spec approved.
- **Exit criteria:** M0 demonstration passes; all 10 decision tickets produce ADR/amendment/configuration records.
- **Requirements covered:** NFR-009/010/013/018 foundations; INTEG-002 (adapter contract).
- **ADRs governing:** 006, 007 (schema discipline), 008 (job tables reserved), 011, 014, 017, 019–022.
- **Dependencies:** none.
- **Risks:** boundary rules too loose to enforce later; decisions stall the wave (mitigation: recommended defaults in IMPLEMENTATION-OPEN-QUESTIONS.md).
- **Demonstration:** install → lint/typecheck/test green → config validation rejects bad bootstrap → redacted log with correlation ID emitted.
- **Verification:** CI spec runs all gates; import-boundary lint proves a forbidden dependency fails the build.
- **Deferred:** all business features.

### Phase 1 — Identity, accounts, companies, tenant isolation (15 tickets)
- **Purpose:** the trust boundary: Clerk identity → internal mapping → membership → two-layer tenant isolation → audit foundation.
- **User-visible outcome:** sign in, create account + company, switch companies; cross-tenant access provably denied (Slice A).
- **Epics:** Identity & mapping · Accounts/membership/companies · Tenant isolation & authorization · Audit/activity foundation · Admin access.
- **Entry:** M0 passed. **Exit:** M1 demo + adversarial isolation suite green in CI.
- **Requirements:** ACC-001/002/003, PORT-001/002/003, COMP-001..006/008, ADMIN-003, ACT-001/002 (foundations), NFR-001/002/008.
- **ADRs:** 006, 007, 015, 022.
- **Dependencies:** P0 complete (esp. P0-011/018/019, decisions P0-006/007/008).
- **Risks:** Clerk webhook drift (replay-safe consumers, reconciliation); RLS/pool leakage (per-request set/reset tests).
- **Demonstration:** Slice A script.
- **Verification:** ACBP-P1-014 adversarial suite; forged-Clerk-claim negative tests.
- **Deferred:** roles beyond owner+viewer; deletion flows (P7/post-MVP).

### Phase 2 — Discovery interview and business understanding (12 tickets)
- **Purpose:** the differentiator: adaptive interview → typed memory → understanding review; first model calls through the gateway with usage recording from call one.
- **User-visible outcome:** complete an adaptive interview; confirm an understanding document (Slice B).
- **Epics:** Interview engine · Model gateway v1 + templates + usage core · Memory & context assembly · Understanding generation & review · Discovery evaluation.
- **Entry:** M1; P0-001 (pinned models) decided. **Exit:** M2+M3-part demo; discovery eval areas pass initial thresholds (P0-002).
- **Requirements:** DISC-001..008, UNDER-001..005, MEM-001..004, USAGE-001 (event core), NFR-019 (primary path), NFR-021 (context rules).
- **ADRs:** 011, 019, 013 (event shape), 012 (context rules).
- **Dependencies:** P1 (tenancy, audit); gateway before understanding (critical path).
- **Risks:** adaptivity quality (eval suite from the start); prompt-injection via researched content deferred to P5 tools — interview input is user-only in P2.
- **Demonstration:** Slice B script.
- **Verification:** ACBP-P2-011 eval suite; session kill-and-resume.
- **Deferred:** research-tool calls (P5); fallback model path (P5-009).

### Phase 3 — Strategy options and owner decisions (7 tickets)
- **Purpose:** ≥3 distinct options, comparison, selection, immutable decision records.
- **User-visible outcome:** compare three genuinely different strategies and choose (Slice C).
- **Epics:** Option generation & distinctness · Selection & decision records · Strategy evaluation.
- **Entry:** M2/understanding confirmed flow works. **Exit:** M3 demo; similarity check proven on seeded near-duplicates.
- **Requirements:** STRAT-001..006.
- **ADRs:** 011, 015 (decision records), 019.
- **Dependencies:** P2 (understanding, gateway, memory).
- **Risks:** cosmetic-variant options (distinctness check is its own ticket with adversarial fixtures).
- **Demonstration:** Slice C. **Verification:** ACBP-P3-006 eval area; decision-record immutability tests.
- **Deferred:** phase-limited execution enforcement beyond flagging (full effect visible in P4 planning boundary).

### Phase 4 — Goals, roadmap, milestones, tasks (7 tickets)
- **Purpose:** planning objects + server-enforced task state machine (no execution yet).
- **User-visible outcome:** selected strategy becomes an inspectable plan with tasks (Slice D).
- **Epics:** Planning objects · Task model & board · Planning transparency.
- **Entry:** M3. **Exit:** M4 demo; illegal state transitions rejected server-side.
- **Requirements:** ROAD-001/002, PLAN-001/002/004, TASK-001/002/008, STRAT-005 (phase boundary respected in generation).
- **ADRs:** 008 (state machine semantics), 015.
- **Dependencies:** P3.
- **Risks:** state machine drift from WORKFLOW-STATE-MACHINES.md (contract tests against the documented transition table).
- **Demonstration:** Slice D. **Verification:** transition-table conformance tests.
- **Deferred:** execution (P5), scheduling (post-MVP TASK-003).

### Phase 5 — Worker runtime and safe internal execution (15 tickets)
- **Purpose:** durable jobs, workflow coordinator, dispatcher core (allowlists + records + idempotency), three workers, artifacts, revision, failure detail, credit preflight.
- **User-visible outcome:** an approved research task runs and produces a real document with provenance; revision works (Slice E, with P6 approval mechanics arriving next phase — P5 uses level-1 recommend-then-user-run flow).
- **Epics:** Durable execution · Dispatcher core & worker runtime · Three workers · Gateway v2 (fallback) & output validation · Artifacts & revision · Run economics (preflight/credits) · Failure visibility.
- **Entry:** M4; P0-005 (object storage) decided. **Exit:** M5 demo; kill-and-resume + credit-race tests green.
- **Requirements:** TASK-004/005/006/007/009/010, WORK-001..006, TOOL-001/002, BILL-002 (ledger core), ACT-004/005, NFR-005/006/007/019 (fallback), EXPORT prep (artifact formats).
- **ADRs:** 008, 011, 012, 013, 016, 019.
- **Sequencing note (documented deviation):** the tool registry/dispatcher **core** lands here (execution is impossible without the allowlist chokepoint); Phase 6 adds the policy/approval enforcement integration into that dispatcher. This preserves the required-epic intent while keeping the architecture's single-chokepoint rule from day one.
- **Risks:** job-runner subtleties (library-backed, ADR-008); silent fallback (explicitly tested in P5-009).
- **Demonstration:** Slice E (level-1/2 flow). **Verification:** replay, resume, race, no-hollow-success tests.
- **Deferred:** policy engine + payload-bound approvals (P6) — P5 execution is gated by user-initiated runs on informational-class tools only.

### Phase 6 — Approvals, policies, usage, emergency controls (12 tickets)
- **Purpose:** the full trust layer: deterministic policy engine, three evaluation points, payload-bound approvals, emergency stop, Decision Room, account rollups, limits, replay hardening.
- **User-visible outcome:** control demonstrably works (Slice F): blocks, invalidation, stop, no duplicates, reconciled totals.
- **Epics:** Policy engine & enforcement integration · Approval engine & binding · Emergency stop · Decision Room & timeline · Usage rollups, limits, reconciliation · Idempotency hardening.
- **Entry:** M5. **Exit:** M6 demo; launch gates 3/4/5/7/8 test-green.
- **Requirements:** POL-001/005/006, TOOL-003, APPR-001..010, ADMIN-001/002, DEC-001, ACT-003, USAGE-001 (rollups), NFR-006/015, TASK-009 (final proof).
- **ADRs:** 009, 010, 013, 015.
- **Dependencies:** P5 dispatcher core.
- **Risks:** hash-normalization edge cases (fail-closed by design); race conditions (dedicated replay ticket).
- **Demonstration:** Slice F. **Verification:** the trust-critical negative-test set (TEST-AND-VERIFICATION-STRATEGY.md).
- **Deferred:** autonomy levels 3–5, volume/window policies (post-MVP).

### Phase 7 — Beta readiness and release validation (12 tickets)
- **Purpose:** export, deactivation, observability, runbooks, staging validation, security/failure test passes, E2E suite, release gates, disclosure copy, final model-eval gate.
- **User-visible outcome:** a beta-ready product with proof.
- **Epics:** Export & lifecycle · Operations (dashboards/alerts/runbooks) · Validation passes (security/failure/E2E) · Release gates & beta readiness.
- **Entry:** M6. **Exit:** M7 = closed-beta gate passes with recorded evidence.
- **Requirements:** EXPORT-001, ACC-004, NFR-003/009/010/017 validation, NFR-011 (disclosure), all launch gates.
- **ADRs:** 005 (residency boundary on beta audience), 017, 018, 020, 021.
- **Risks:** gate failures late (mitigated: gates tested incrementally from P1).
- **Demonstration:** full MVP loop end to end. **Verification:** RELEASE-GATES.md closed-beta gate.
- **Deferred:** everything in the excluded list (external channels, billing commerce, generation hosting).

## Critical path

```
Repository foundation (P0-011..018)
→ identity integration (P1-001)
→ internal user/account mapping (P1-002/003)
→ tenant authorization (P1-005/006/007)
→ company data model (P1-010)
→ discovery persistence (P2-001/002)
→ model gateway v1 (P2-003)
→ understanding generation (P2-008/009)
→ strategy generation (P3-001..005)
→ planning objects (P4-001..003)
→ durable task execution (P5-001/002)
→ worker runtime + dispatcher core (P5-003/005)
→ document generation (P5-006/008/011)
→ activity/audit/usage completion (P1-008/009 + P2-003 + P6-009)
→ approval and emergency controls (P6-001..007)
→ end-to-end release validation (P7-009/010)
```

**Parallelizable:** the 10 P0 decision tickets (against foundation work); P1 admin-access + activity foundation (against company lifecycle); P2 template registry + memory browser (against orchestration); P3 eval suite (against selection UI); P4 board/detail UI (against generation); P5 workers 006/007/008 (against each other, after runtime); P5 artifact storage (against coordinator); P6 Decision Room UI (against policy engine); P7 runbooks/dashboards (against test passes).
**Strictly serial:** the chain above — notably gateway before understanding; dispatcher core before any worker; policy engine before Slice F; every phase's slice ticket last in its phase.

## Ticket routing (capability categories — see MVP-BACKLOG.md per ticket)

- **Architecture/spec review:** decision tickets producing ADR amendments; contract-changing work.
- **Routine implementation:** CRUD, UI, handlers, docs, straightforward tests.
- **High-reasoning implementation/validation:** coordinator, workflow semantics, integration debugging, cross-file work.
- **Trust-critical maximum reasoning:** tenancy, authorization, approval binding, idempotency, usage reconciliation, webhook replay, secrets/redaction, audit integrity, emergency stop.
No claim is made that a specific named model executes any ticket.
