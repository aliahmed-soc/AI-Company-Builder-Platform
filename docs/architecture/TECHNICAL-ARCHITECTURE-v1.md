# Technical Architecture v1 — AI Company Builder Platform

## 1. Document control

| Field | Value |
|---|---|
| Title | Technical Architecture v1 — AI Company Builder Platform |
| Version | 1.1.0-accepted |
| Status | **Accepted by owner (2026-07-18)** — ADR-006…018 accepted (5 with amendment) per `ARCHITECTURE-OWNER-REVIEW.md`; provider selections recorded in accepted ADR-019…022 |
| Architecture owner | _[pending assignment]_ |
| Product version | Master PRD v1.2.0-draft (USAGE-001 amendment applied) |
| PRD version | `product-specification/MASTER-PRD-v1.md` 1.2.0-draft |
| Accepted ADRs used | ADR-001…005 (product) · ADR-006…018 (architecture, accepted 2026-07-18) · ADR-019 (models: GPT-5.1 primary / Claude Sonnet 4 fallback) · ADR-020 (Render) · ADR-021 (Infisical) · ADR-022 (Clerk) |
| Proposed ADRs created | — (all architecture ADRs now Accepted) |
| Creation date | 2026-07-18 |
| Last updated | 2026-07-18 |
| Change log | 1.0.0-proposed (2026-07-18): initial architecture from PRD v1.1.0-draft + ADR-001…005 · 1.1.0-accepted (2026-07-18): owner review accepted ADR-006…018 (amendments in ARCHITECTURE-OWNER-REVIEW.md); providers bound via ADR-019…022; AOQ-01/02/04/05 resolved; §10 table updated |

Requirement IDs cited throughout are canonical per `product-specification/REQUIREMENTS.csv`. Full mapping: `REQUIREMENT-TRACEABILITY.csv`.

## 2. Architecture summary

**Primary responsibilities.** (1) Run the discovery → understanding → strategy → planning loop for non-technical founders (ADR-001); (2) execute safe knowledge-work tasks through policy-gated AI workers producing document artifacts with provenance; (3) enforce trust structurally: tenancy, approvals, policies, usage accounting, audit, emergency stop.

**MVP boundary.** The MVP slice is internal-only: account → company → interview → understanding → 3 strategy options → selection → roadmap/tasks → approved internal task → executed research/strategy/document work → artifact → activity/usage → revision. **Zero external actions** (no email/social/ads/payments/deploys). Software generation, hosting, and integrations are post-MVP/future boundaries defined but not built.

**Major components.** Three deployment units — `web` (browser client), `api` (modular backend), `worker` (separate background process) — over shared managed infrastructure: PostgreSQL, object storage, secret manager, monitoring, external model providers, external billing provider. All product modules live inside `api`/`worker` as a **modular monolith** (ADR-006); the model gateway is an internal module boundary (ADR-004/ADR-011), not a service.

**Trust boundaries.** Browser↔api (untrusted client); api/worker↔model providers (untrusted output); worker↔tools (least privilege); platform↔billing provider; tenant↔tenant (NFR-001); admin↔product (§SECURITY). Detailed in §6.

**Execution boundaries.** All state mutation flows through `api` modules with server-side authorization (NFR-002); all AI work runs in `worker` under explicit tenant context via durable jobs (ADR-008); all tool invocations pass the policy gate (TOOL-003) and, where required, approval verification (APPR-009) immediately before execution.

**Deployment boundary.** Single region (ADR-005 permits), managed services, no Kubernetes (PRD §20). See `DEPLOYMENT-ARCHITECTURE.md` / ADR-018.

**Deliberately excluded.** Microservice-per-agent, Kafka, service mesh, multi-region active-active, dynamic model routing (ADR-004), BYOK (ADR-003), customer-owned infrastructure paths (ADR-002 — future extension points only), generated-app hosting in MVP.

## 3. Architecture drivers

| Driver | Requirement IDs | Architectural consequence |
|---|---|---|
| Tenant isolation | NFR-001, MEM-003, PORT-003 | `company_id` on every tenant row; two-layer enforcement (app scope + DB row-level security, ADR-007); tenant context threaded to workers, tools, storage paths, cache keys |
| Adaptive discovery | DISC-001…008, UNDER-001…005 | Interview session state machine; model gateway with structured outputs; resumable sessions (NFR-005) |
| Strategy generation | STRAT-001…006, DEC-001 | Option/decision entities; similarity check step; immutable decision records |
| Durable task execution | TASK-001…010, NFR-005, NFR-007 | Postgres-backed durable jobs + task state machine (ADR-008); checkpointed workflows |
| Approval enforcement | APPR-001…010 | Approval engine with payload-hash binding, expiry, revocation, single-use consumption; enforcement in the tool dispatcher (ADR-009) |
| Policy enforcement | POL-001, POL-005, POL-006, TOOL-003 | Deterministic versioned policy engine; three evaluation points; fail closed (ADR-010) |
| AI-provider abstraction | NFR-019, ADR-004 | Internal model gateway: one contract, primary+fallback config (ADR-011) |
| Usage & cost accounting | USAGE-001, BILL-002, NFR-015 + ADR-003 per-account rollup | Append-only usage events + credit ledger + account rollups; compensating corrections (ADR-013) |
| Auditability | ACT-002, NFR-008, TOOL-002 | Append-only audit store; transactional audit writes for high-risk ops (ADR-015) |
| Emergency stop | ADMIN-001, ADMIN-002 | Stop-state table checked in the tool dispatcher pre-execution; scoped stops (task/worker/capability/integration/company/external/account) |
| Export & ownership | EXPORT-001, BUILD-003, NFR-014 | Artifact storage with open formats + manifests (ADR-016); tenant-scoped export paths |
| Platform-managed infra defaults | ADR-002, ADR-003 | No user infra config anywhere in onboarding; provider abstractions at gateway/storage/secret boundaries |

## 4. Quality attributes (measurable)

| Attribute | Expectation | Source |
|---|---|---|
| Security | 100% pass on adversarial tenant-isolation suite; negative authz test per privileged endpoint; zero secret findings in CI/log scans; pen review pre-beta with high+ closed | NFR-001/002/010/018 |
| Reliability | All workflows checkpoint-resumable; kill-and-resume tests pass; zero duplicate external effects in replay tests | NFR-005/006 |
| Availability | 99.5% monthly (beta) for dashboard + Decision Room; measured and reported | NFR-003 |
| Performance | Dashboard FMC <2.5s p75 warm; interview question generation <10s p90; long work async with progress | NFR-004 |
| Recoverability | RPO ≤24h, RTO ≤4h (beta); restore drill pre-beta and quarterly | NFR-017 |
| Auditability | 100% of registered action types emit immutable audit records ≤5s; range export | NFR-008 |
| Maintainability | CI lint/typecheck/test gates on every merge; per-module ownership docs | NFR-013 |
| Portability | Documented open export format per artifact type; no proprietary-only user artifact | NFR-014, EXPORT-001 |
| Cost control | Hard per-task/per-company AI caps; overrun ≤1 billing increment; reconciles with provider bills | NFR-015 |
| Accessibility | WCAG 2.1 AA on core flows (post-MVP gate) | NFR-012 |
| Privacy | Encryption in transit/at rest; data map + retention pre-beta; no personal data in logs | NFR-011, ADR-005 |

## 5. System boundaries

| Boundary | Contents | Notes |
|---|---|---|
| User-facing product | `web` client; public API surface of `api` | Untrusted input origin |
| Internal platform services | `api` modules, `worker` runtime, model gateway, policy/approval engines, ledgers | The trusted core |
| AI providers | External model APIs (primary + fallback vendors) | Server-side credentials only (ADR-003); outputs treated as untrusted data (NFR-021) |
| External integrations | None in MVP; future connector boundary (INTEG-001…003) | Defined, not built |
| Generated customer applications | **Future.** Strictly outside the platform trust zone; may never access platform internals (invariant 18) | ADR-002 boundary |
| Managed infrastructure | Postgres, object storage, secret manager, monitoring | Provider-abstracted where practical (ADR-002) |
| Customer-owned exports | Archives + manifests leaving the platform | Ownership checks + no secrets (EXPORT-001, NFR-018) |
| Administrative systems | Admin controls, break-glass access | §SECURITY-ARCHITECTURE administrative access |

**Core platform vs generated software:** the platform is *our* trusted multi-tenant system; a generated customer application is a *product output* — single-tenant, customer-owned in direction (ADR-002), hosted (future) in an isolated zone with no credentials for, network path to, or shared runtime with platform internals.

## 6. Trust boundaries

| # | Boundary | Controls |
|---|---|---|
| T1 | Browser → backend | AuthN session, server-side authz (NFR-002), input validation, no client-supplied tenant authority (invariant 2), no secrets to client (NFR-018) |
| T2 | Backend → model provider | Server-side keys (ADR-003), redacted prompts policy, response schema validation, output-as-data (NFR-021) |
| T3 | Backend → worker environment | Signed job payloads with explicit tenant context (invariant 3); workers hold no standing credentials beyond their needs |
| T4 | Worker → external tools | Tool registry + per-worker allowlist (WORK-005), policy gate + approval check pre-execution (invariant 6), idempotency keys (NFR-006) |
| T5 | Platform → generated applications (future) | Hard isolation; one-way provisioning; no shared secrets (invariant 18) |
| T6 | Platform → billing provider | Hosted portal handoff; webhook signature verification; no card data touches the platform (BILL-004) |
| T7 | Tenant ↔ tenant | Two-layer isolation (ADR-007); storage-path/cache-key/log scoping; adversarial test suite (NFR-001) |
| T8 | Administrative access | Reason-captured, audited, time-limited; no silent impersonation; break-glass procedure (§SECURITY) |

## 7. Logical architecture

**Style: modular monolith + separately scalable worker process (ADR-006).** One TypeScript codebase; `api` and `worker` are two processes built from the same modules; module boundaries are enforced by the dependency graph, not the network. **Explicitly rejected:** microservice-per-agent (PRD §20), serverless-function decomposition (durable state machine fit is poor), premature service extraction.

Modules (full detail in `COMPONENT-CATALOG.md`): identity & access · account & company · discovery interview · business understanding · strategy & decision · planning · task · workflow coordinator · worker runtime · tool registry · model gateway · policy engine · approval engine · memory · document/artifact · activity event · audit · usage ledger · billing · integration (post-MVP) · credential vault facade · notification (post-MVP) · admin controls · emergency-stop controller · export (post-MVP) · generated-project provisioning (future).

**The one hot path everything protects** (diagrams 06–08):
`task.run request → policy evaluate (propose) → [approval request → decision] → job enqueued (durable, tenant-stamped) → worker picks up → policy re-evaluate (pre-execution, mandatory) → approval verify+consume (hash, expiry, revocation, stop-state) → tool dispatch (allowlist) → model gateway call(s) → artifact persist + usage event + activity + audit → task state transition`.

## 8. Deployment architecture (summary — full: DEPLOYMENT-ARCHITECTURE.md / ADR-018)

Smallest production-ready MVP topology: `web` + `api` (may share one deployment initially) · `worker` (separate process, required isolation) · managed PostgreSQL (also hosts durable job/workflow state, ADR-008) · managed object storage · managed secret manager · monitoring/error tracking (external SaaS) · model providers (external) · billing provider (external). Environments: local / test / staging / production with separated config, secrets, databases, and storage. **No Kubernetes.** Realtime updates via SSE with polling fallback (§14).

## 9. Architecture alternatives (with recommendations)

| Choice | Options compared | Recommendation | Why / rejected because | Reversal cost | Scale trigger | Security implications | Req IDs |
|---|---|---|---|---|---|---|---|
| Application style | Modular monolith · microservices · serverless · hybrid modular+workers | **Modular monolith + worker process** (ADR-006) | Small team, one domain, transactional integrity across task/approval/ledger; microservices add network failure modes to trust-critical paths; serverless fits poorly with long-running durable work | Medium (module boundaries make later extraction tractable) | Sustained worker CPU saturation or team >~8 engineers | Fewer network trust boundaries to defend | NFR-005/013, TASK-*, APPR-* |
| Workflow execution | DB-backed jobs · Redis-style queue · durable workflow engine · external automation platform | **Postgres-backed durable jobs** (ADR-008) | One datastore = transactional enqueue with state changes (task row + job + audit in one tx); Redis adds an unneeded second stateful system at MVP scale; Temporal-class engines are the scale-up path, not the start; external automation platforms violate control requirements | Medium | >~50 jobs/sec sustained or complex multi-day sagas | Fewer systems holding tenant data | TASK-001/009, NFR-005/006/007 |
| Worker execution | In-process · separate worker processes · isolated containers · ephemeral sandboxes | **Separate worker process(es)** (ADR-006/012) | Isolates AI/long work from API latency; containers/sandboxes deferred until untrusted code execution exists (software generation, future — then mandatory) | Low→Medium | Software-generation phase (then: ephemeral sandboxes required) | Worker holds least-privilege creds; blast radius contained | WORK-005, NFR-004/005 |
| Realtime updates | Polling · SSE · WebSockets | **SSE + polling fallback** | One-directional progress/feed updates fit SSE exactly; WebSockets add bidirectional complexity nothing in MVP needs | Low | Collaborative editing (future) | Simpler authn story than WS | ACT-001, DEC-001, NFR-004 |
| Tenant isolation | App filters only · DB row-level enforcement · separate schemas · separate DBs | **App-enforced scope + DB row-level security (two layers)** (ADR-007) | Either alone is one bug away from breach; schemas/DBs-per-tenant don't fit self-serve volume | High (foundational) | Regulated/enterprise tenants (then: consider dedicated DBs per tenant tier) | Defense in depth for the #1 risk | NFR-001, MEM-003 |
| Model-provider abstraction | Direct SDKs · thin internal gateway · external AI-gateway product · full routing platform | **Thin internal gateway** (ADR-004 accepted; contract in ADR-011) | Accepted decision; external gateway products add a third-party in the data path against ADR-003/005 disclosure posture; routing platform excluded by ADR-004 | Low (gateway is the hedge) | Per ADR-004 review triggers | Keys in one place; single redaction point | NFR-019, ADR-003/004 |

## 10. Technology recommendations

Capability first; vendors are recommendations, not mandates. Nothing is required merely because the Polsia audit mentions it.

| Required capability | Recommended MVP technology | Acceptable alternative | Scale-up alternative | Lock-in risk | Decision status |
|---|---|---|---|---|---|
| Typed full-stack language | TypeScript end-to-end | — | — | Low | Proposed (ADR-006) |
| Web client | React-based SSR/SPA framework | Any mature TS framework | Same | Low | Proposed; AOQ-06 |
| Backend runtime | Node.js modular app (NestJS-class or equivalent structure) | Fastify/Express + explicit modules | Same, extracted services | Low | Proposed (ADR-006) |
| Relational store | **Render PostgreSQL** (standard Postgres — ADR-020) | Any managed Postgres | Read replicas, partitioning | Low (SQL standard; no proprietary extensions) | **Accepted (ADR-020)** |
| Durable jobs | Postgres-backed job runner (pg-boss/graphile-worker class) | Redis + BullMQ-class queue | Temporal-class engine | Low | Proposed (ADR-008) |
| Object storage | S3-compatible managed storage | — | Same | Low (S3 API is portable) | Proposed; provider = AOQ-03 |
| Secret management | **Infisical Cloud** (ADR-021; bootstrap-only env vars) | Cloud-native secret manager | Same | Medium (facade-contained) | **Accepted (ADR-021)** |
| AuthN | **Clerk** — identity/sessions only; internal authz remains authoritative (ADR-022) | Auth library + own sessions | Enterprise SSO (future) | Medium (identity-adapter boundary) | **Accepted (ADR-022)** |
| Monitoring/errors | Error-tracking SaaS + structured logs + OTel-style traces | Self-hosted stack | Same | Low | Proposed (ADR-017) |
| Billing | Hosted billing portal provider | — | Same | Medium | Phase 7; provider = AOQ-07 |
| Models | **Primary GPT-5.1 / fallback Claude Sonnet 4** via gateway (ADR-019; exact snapshots = AOQ-18; evaluation gate before production) | — | Config change | Low (gateway) | **Accepted (ADR-019)** |

**Excluded absent an explicit requirement:** Kubernetes, Kafka, service mesh, microservice-per-agent, multi-region active-active, dynamic AI routing.

## 11. Required architectural invariants

| # | Invariant | Enforcing component | Persistence constraint | Runtime check | Test strategy | Audit evidence |
|---|---|---|---|---|---|---|
| 1 | Every tenant-owned object has immutable tenant ownership | Data layer (ADR-007) | `company_id NOT NULL`, no UPDATE path on ownership columns | ORM/repo layer rejects ownership mutation | Migration lint + mutation attempt tests | Schema audit + change log |
| 2 | Requests cannot rely on client-supplied tenant ID | api authz middleware | — | Tenant resolved from session membership, never request body | Forged-tenant request tests (negative) | `authz.denied` audit events |
| 3 | Workers execute with explicit tenant context | Workflow coordinator | Job rows carry `company_id`/`account_id` NOT NULL | Worker refuses jobs lacking context | Context-stripped job tests | Job audit trail |
| 4 | Tools denied unless in worker capability allowlist | Tool dispatcher (ADR-012) | Allowlists versioned in worker definitions | Dispatcher checks registry before invoke | Non-allowlisted invoke tests | `tool.call_requested`→denied audit |
| 5 | Model output cannot grant approval | Approval engine (ADR-009) | Approval rows created only via approval API with human/delegated actor | Actor-type check on approval creation | Model-actor approval attempt tests | Approval records with actor provenance |
| 6 | Approval checked immediately before execution | Tool dispatcher | — | Mandatory pre-execution verify (3rd policy point) | Execute-after-revoke/expiry race tests | `policy.evaluated` + `approval.consumed` events |
| 7 | Materially changed payload requires new approval | Approval engine | Approval stores canonical payload hash | Hash comparison at consumption | Edit-invalidates tests | Hash mismatch audit events |
| 8 | External actions use idempotency where possible | Tool dispatcher | `tool_call.idempotency_key` unique | Key required for external risk classes | Replay/duplicate tests | Tool-call records + receipts |
| 9 | Usage events are append-only | Usage ledger (ADR-013) | No UPDATE/DELETE grants on usage tables | Repo layer exposes insert-only API | Mutation attempt tests | Ledger reconciliation reports |
| 10 | Usage corrections use compensating entries | Usage ledger | Correction rows reference original | — | Correction flow tests | Linked ledger entries |
| 11 | Audit records immutable via product APIs | Audit module (ADR-015) | Append-only store; no product-API mutation path | — | Mutation attempt tests | Audit-integrity checks |
| 12 | Secrets never enter model context unless explicitly required and scoped | Model gateway + context assembler | Secrets stored only as references (ADR-014) | Context assembler blocklist + redaction | Prompt secret-scan tests | Redacted-call logs |
| 13 | Provider secrets never reach browser clients | api response layer | Secret values absent from all read models | Serializer denylist | API response scan tests (negative) | CI scan reports |
| 14 | Emergency stop blocks new external executions | Emergency-stop controller | Stop-state rows per scope | Dispatcher checks stop state pre-execution | Stop-then-execute tests (≤5s) | `emergency_stop.activated` + blocked-call events |
| 15 | Revoked integration cannot be used | Integration module + dispatcher | Revocation timestamp on connection | Dispatcher validates connection status | Revoke-then-use tests | Revocation + denial events |
| 16 | Paused company cannot start new autonomous work | Workflow coordinator | Company lifecycle state | Job pickup checks company state | Pause-then-schedule tests | State-transition audits |
| 17 | Untrusted content cannot directly invoke tools | Worker runtime (NFR-021) | — | Tool calls originate only from worker control flow, never from parsed content instructions | Injection corpus tests | Quarantine events |
| 18 | Generated apps cannot access platform internals | Provisioning boundary (future) | Separate credentials/network zone | No platform secrets provisioned into generated apps | Boundary tests (when built) | Provisioning audit |
| 19 | No cross-tenant retrieval of objects/artifacts/logs/memory | ADR-007 layers + storage pathing | Tenant-prefixed storage paths; scoped cache keys | Two-layer query scoping | Adversarial suite (NFR-001) | Denial audits |
| 20 | Nothing displayed complete without execution evidence | Activity module (ACT-003) | Completion requires run record (+receipt for external) | Read models join evidence | Hollow-success rendering tests | Evidence-linked events |

## 12. Verification strategy

The architecture makes these future test families possible (design hooks noted): tenant isolation (adversarial ID substitution against two-layer scoping); role authorization (negative test per endpoint × role matrix); approval enforcement + invalidation (execute without/with-expired/with-edited approvals — all must fail closed); policy blocking (limit breach, forbidden action, out-of-window); emergency stop (all seven scopes, ≤5s halt assertion); duplicate job handling + idempotent tool calls (replay harness over the dispatcher); usage accounting + account rollups (ledger↔rollup↔provider-bill reconciliation); model fallback + provider timeout (fault-injected gateway adapters); worker crash recovery (kill-and-resume against checkpoints); revoked integration (revoke-then-use); secret redaction (CI + log-pipeline scanners, API response scans); audit immutability (mutation attempts); data-export ownership (cross-tenant export denial); cross-company memory isolation (MEM-003 scope tests); untrusted-content handling (injection corpus, zero unauthorized tool executions).

Test-rig requirement: policy engine, approval engine, gateway adapters, and tool dispatcher must each be constructible in isolation with injected clocks/fakes — a stated module-design constraint (ADR-006).
