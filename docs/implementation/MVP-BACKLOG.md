# MVP Backlog

Status: **Approved by owner as working plan (2026-07-18)**, amendable via controlled planning changes. **Phase 0 decision sprint executed same day:** P0-001…004 and P0-006…010 are **Done** (CDR-001…009); **P0-005 is Blocked** (owner object-storage selection; recommendation: Cloudflare R2); dependent DoR gates cleared accordingly in `BACKLOG.csv`. Owner condition recorded: **DoR split review required for P5-001, P5-003, P6-001, P6-007** before implementation. **Canonical registry: `BACKLOG.csv`** (101 tickets — full 28-field schema per ticket). This file organizes tickets by phase/epic and adds **model-routing recommendations** (capability categories per the standing protocol — no claim that a specific named model executes any ticket).

**Phase 0 implementation progress (as of 2026-07-18):** Foundation tickets **P0-011…P0-017 are Done** in `BACKLOG.csv` (scaffold; dependency boundaries; static analysis; test foundation; config validation; structured errors; **P0-017 correlation + redacted logging** — `@acbp/observability` provider-neutral logger with explicit-context correlation and a trust-critical redaction pipeline, documented in `packages/observability/README.md`). **P0-018 (Postgres foundation) is PARTIAL, not yet Done:** the `@acbp/database` package (Kysely + node-postgres, connection lifecycle, transactions, migration tooling + discipline, compile-level tenant context, RLS-ready session settings, structured/redacted errors) is implemented, unit-tested, and documented in `packages/database/README.md`; the required **real-PostgreSQL integration suite is written but has not executed** because no PostgreSQL runtime is available in the build environment (Docker daemon would not start; no local Postgres; `ACBP_TEST_DATABASE_URL` unset). It remains `Planned` in `BACKLOG.csv` until the integration suite runs green against real Postgres. P0-005 remains Blocked (owner object-storage selection).

**Hierarchy:** Initiative `ACBP MVP` (1) → Phases P0–P7 (8) → Epics (below) → tickets.

Routing legend: **[R]** Routine implementation · **[H]** High-reasoning implementation/validation · **[T]** Trust-critical maximum reasoning · **[A]** Architecture/specification review.

## Epic consolidation note
The required epic topics (task brief §10) were consolidated into 36 coherent epics; the mapping is explicit below — every required topic appears as an epic name or as the named scope of a listed ticket. Nothing was dropped; consolidation avoids one-ticket epics.

## Phase 0 — Engineering foundation (21)
**Blocking decisions** *(topic coverage: resolve implementation-blocking questions)*: P0-001 [A] pinned models · P0-002 [A] eval dataset/thresholds · P0-003 [A] Render region · P0-004 [R] Render plans · P0-005 [A] object storage · P0-006 [R] Infisical identity method · P0-007 [R] Clerk social logins · P0-008 [A] webhook strategy · P0-009 [A] interim caps/limits · P0-010 [A] retention/backup objectives
**Repository & boundaries** *(repository/workspace foundation)*: P0-011 [R] scaffold · P0-012 [H] dependency boundaries
**Quality gates** *(type checking/linting; testing foundation; CI)*: P0-013 [R] static analysis · P0-014 [R] test foundation · P0-020 [R] CI
**Runtime foundations** *(configuration validation; logging/correlation; error handling; database foundation; migration discipline; provider adapter contracts; local dev)*: P0-015 [R] config validation · P0-016 [R] error taxonomy · P0-017 **[T]** redacted logging · P0-018 [H] Postgres foundation + migrations · P0-019 [H] adapter contracts · P0-021 [R] local dev

## Phase 1 — Identity, accounts, companies, tenant isolation (15)
**Identity & mapping** *(Clerk auth; internal user mapping)*: P1-001 [H] Clerk integration · P1-002 **[T]** user mapping + webhook replay
**Accounts, membership & companies** *(account creation; membership; company lifecycle; company switching)*: P1-003 [R] accounts/profile · P1-004 [H] membership/roles · P1-010 [H] company lifecycle · P1-011 [R] switching/portfolio · P1-012 [H] provisioning
**Tenant isolation & authorization** *(tenant-scoped repositories; authorization middleware; isolation tests)*: P1-005 **[T]** tenant-context primitives · P1-006 **[T]** RLS layer · P1-007 **[T]** authz middleware · P1-014 **[T]** adversarial suite
**Audit & activity foundation**: P1-008 **[T]** audit foundation · P1-009 [R] activity foundation
**Admin access** *(administrative-access foundation)*: P1-013 [H] admin foundation
**Vertical slice**: P1-015 [H] Slice A

## Phase 2 — Discovery and understanding (12)
**Interview engine** *(interview sessions; Q&A persistence; adaptive orchestration)*: P2-001 [H] sessions · P2-002 [R] Q&A · P2-005 [H] adaptive orchestration
**Gateway & usage core** *(model gateway; prompt registry)*: P2-003 **[T]** gateway v1 + usage events · P2-004 [R] template registry
**Memory & context** *(facts/preferences/constraints/assumptions; context assembly)*: P2-006 [H] typed memory · P2-007 **[T]** context assembly · P2-010 [R] memory browser
**Understanding** *(understanding generation; review/confirmation)*: P2-008 [H] generation · P2-009 [H] review/confirm
**Model evaluation** *(discovery-behavior evaluation)*: P2-011 [H] discovery eval
**Vertical slice**: P2-012 [H] Slice B

## Phase 3 — Strategy (7)
**Strategy generation** *(generation; distinctness)*: P3-001 [H] options · P3-002 [H] distinctness check
**Selection & decisions** *(comparison; selection; decision history; revision)*: P3-003 [R] comparison/recommendation · P3-004 [H] selection/edit/combine/phase-limit · P3-005 **[T]** immutable decision records
**Model evaluation**: P3-006 [R] strategy eval area
**Vertical slice**: P3-007 [R] Slice C

## Phase 4 — Planning (7)
**Planning objects** *(goals; roadmaps; milestones)*: P4-001 [R] planning objects · P4-003 [H] task generation + chat steering
**Task model** *(tasks; dependencies; state machine)*: P4-002 [H] state machine · P4-004 [R] dependencies/board · P4-005 [R] detail/controls
**Planning transparency** *(planning audit events)*: P4-006 [R]
**Vertical slice**: P4-007 [R] Slice D

## Phase 5 — Safe internal execution (15)
**Durable execution** *(durable workflow records)*: P5-001 **[T]** job runner + checkpoints · P5-002 [H] workflow coordinator
**Dispatcher & runtime** *(worker definitions; worker runtime; tool registry core — see roadmap sequencing note)*: P5-003 **[T]** tool registry + dispatcher core · P5-004 [R] worker definitions · P5-005 [H] worker runtime
**Workers** *(research/strategy/document workers)*: P5-006 [H] research · P5-007 [R] strategy · P5-008 [R] document
**Gateway hardening** *(model gateway completion; structured-output validation)*: P5-009 **[T]** fallback (no-silent rule) · P5-010 [H] output validation
**Artifacts & revision** *(document storage; revision workflow)*: P5-011 [H] artifact storage · P5-012 [R] revision
**Run economics** *(failure recovery; credits)*: P5-013 [H] failure detail/retries · P5-014 **[T]** preflight + credit ledger (race)
**Vertical slice**: P5-015 [H] Slice E

## Phase 6 — Approvals, policies, usage, emergency (12)
**Policy & enforcement** *(policy engine; dispatcher integration; autonomy levels)*: P6-001 **[T]** policy engine · P6-002 **[T]** enforcement integration · P6-006 [R] levels 1–2
**Approvals** *(request/decision; payload binding; invalidation)*: P6-003 **[T]** engine + inbox · P6-004 **[T]** binding/expiry/revocation · P6-005 **[T]** edit-invalidation proof
**Emergency stop**: P6-007 **[T]** stop + resume review
**Decision Room & timeline** *(activity timeline; audit completion)*: P6-008 [H] Decision Room + evidence-joined marking
**Usage rollups & limits** *(company usage; account rollups; limits/alerts; reconciliation)*: P6-009 **[T]** rollups + reconciliation · P6-010 [H] limits/alerts
**Idempotency hardening**: P6-011 **[T]** replay hardening
**Vertical slice**: P6-012 [H] Slice F

## Phase 7 — Beta readiness (12)
**Export & lifecycle** *(export; deactivation)*: P7-001 [H] export · P7-002 [H] deactivation
**Operations** *(dashboards; alerting; runbooks; staging validation)*: P7-003 [R] dashboards · P7-004 [R] alerting · P7-005 [R] runbooks · P7-006 [H] staging + restore drill
**Validation passes** *(security testing; failure testing; E2E)*: P7-007 **[T]** security pass · P7-008 [H] failure-injection pass · P7-009 [H] E2E suite
**Release & beta** *(release gates; closed-beta readiness)*: P7-010 [A] gate execution · P7-011 [R] beta readiness/disclosure
**Model evaluation**: P7-012 [H] final eval gate

## Vertical slices (integration tickets)
| Slice | Ticket | E2E acceptance | Negative tests | Demo | Gate |
|---|---|---|---|---|---|
| A — Secure company creation | P1-015 | sign-in→mapping→account→company→switch | live cross-tenant denial; forged claims | scripted | Internal prototype |
| B — Confirmed understanding | P2-012 | interview→follow-ups→classify→generate→edit→confirm | fallback flagged; confirm-gates-planning | scripted | Internal prototype |
| C — Strategy selection | P3-007 | understanding→3 options→compare→select→record | distinctness rejection; record-failure blocks | scripted | Alpha |
| D — Planned work | P4-007 | strategy→goals→roadmap→milestones→tasks→state | illegal transitions rejected | scripted | Alpha |
| E — Safe internal execution | P5-015 | task→preflight→run→document→activity/audit/usage→revision | no-hollow-success; credit race | scripted | Closed beta |
| F — Safety & recovery | P6-012 | policy block; edit-invalidation; stop; duplicate delivery; worker failure | the trust-critical set | scripted | Closed beta |

## Roadmap epics for excluded/post-MVP scope (no MVP tickets — by design)
External channels (email/social/ads/support) · Commercial launch (billing/subscriptions/payments) · Software generation & hosting (BUILD/DEPLOY, sandboxed) · Portability expansion (EXPORT-002/transfer) · Team roles expansion · Autonomy levels 3–5 · Data deletion completion (ACC-005/COMP-007).

## First implementation wave (recommended execution order)
> **Progress (2026-07-18):** P0-001…004, P0-006…010 resolved (CDR-001…009); P0-005 Blocked (owner object-storage selection). **ACBP-P0-011 (repository scaffold) — Done.** **ACBP-P0-012 (dependency-boundary enforcement) — Done** (`pnpm run check:boundaries` via `tools/check-boundaries.mjs`; 10 spec rules' structural subset enforced; see `DEPENDENCY-BOUNDARIES.md`). **ACBP-P0-013 (static analysis) — Done** (strict TS + ESLint + secret scan + aggregate `pnpm run check:static`; permanent 26-case boundary regression suite; intentional lint/type/secret failures proven; see `STATIC-ANALYSIS.md`). **ACBP-P0-014 (test foundation) — Done** (Vitest single runner; `pnpm test` / `pnpm run check`; 34 sample+regression tests green; boundary suite migrated onto Vitest; DB-layer/ephemeral-Postgres sample deferred to P0-018 per dependency order; see `TESTING.md`). **ACBP-P0-015 (configuration validation) — Done** (`@acbp/config` with zod; public/server + web/worker separation; `Secret` redaction; fail-fast; 24 config tests incl. sentinel-redaction; `.env.example`; see `CONFIGURATION.md`). **ACBP-P0-016 (structured errors) — Done** (`@acbp/contracts` error taxonomy: 10 canonical categories, stable `ErrorCodes`, `PlatformError` with public-envelope vs internal-report split, `normalizeError`, `toJSON`=public; 16 tests incl. secret/cross-tenant/stack redaction proofs; see `packages/contracts/README.md`). Next: ACBP-P0-017 (correlation + redacted logging) per execution order.

1. P0-001…010 decision tickets (parallel; [A]/[R] routing) — resolves every `Ready-pending-decision`
2. P0-011 scaffold → 3. P0-012 boundaries → 4. P0-013 static analysis → 5. P0-014 test foundation (parallel w/ 4)
6. P0-015 config validation → 7. P0-016 errors + P0-017 redacted logging (P0-017 **[T]** review)
8. P0-018 Postgres foundation → 9. P0-019 adapter contracts (Clerk/Infisical/model/storage)
10. P0-021 local dev + P0-020 CI
Then Phase 1 in order: P1-001 → P1-002 → P1-003/004 → P1-005 → P1-006 → P1-007 → P1-008/009 → P1-010…013 → P1-014 → P1-015.
**Routine-model assignable:** all [R] tickets. **Deep/trust-critical review required:** every [T] ticket (14 in the first two phases' path: P0-017, P1-002, P1-005/006/007/008, P1-014, then P2-003/007, P5-001/003/009/014, P6-001…) plus [A] decision tickets.
