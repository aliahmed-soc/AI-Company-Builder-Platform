# Security Architecture

Status: Proposed. Governs NFR-001/002/010/011/018/021, INTEG-002, ADMIN-*, ADR-003/005 obligations. ADRs: ADR-007 (tenancy), ADR-009 (approvals), ADR-014 (secrets). Diagrams: `diagrams/12`, `13`.

## 1. Boundaries and controls

| Area | Architecture |
|---|---|
| Authentication boundary | **Clerk (ADR-022)** for registration, sign-in, sessions, identity; registration email-verified (ACC-001); failed logins rate-limited + audited. **Clerk supplies identity only** — see Authorization row |
| Session management | Clerk-managed sessions verified server-side on every request; revocation on deactivation; session-verification mode selected at implementation (ADR-022 §18); outage behavior per ADR-022 §13 |
| Authorization | Server-authoritative only (NFR-002, invariant 2); mandatory flow: Clerk session → internal user mapping → internal account/company membership → internal role check → tenant-scoped DB authorization → policy/approval check. **Never authorized by client-supplied company ID, Clerk org ID, role string, active-organization value, or UI state.** Role matrix per PRD §13 (MVP: owner+viewer); negative tests include forged-Clerk-claim scenarios; UI checks are UX, never security |
| Tenant isolation | Two-layer (app scoping + DB row-level enforcement, ADR-007); storage-path/cache-key/log scoping; adversarial suite = launch gate 1/2 |
| Role enforcement | Central `authz.check` in identity module; deny by default; role changes audited |
| Approval enforcement | ADR-009: payload-hash binding, expiry, revocation, single-use consumption, pre-execution verification (invariants 5/6/7); negative tests = launch gates 3/4 |
| Credential management | ADR-014 + §2 below |
| Encryption | TLS everywhere in transit; at-rest encryption on database, object storage, and backups (NFR-011); field-level protection for high-sensitivity columns where warranted |
| Secret rotation | All platform credentials rotatable without downtime (reference-resolution at use time enables this); rotation runbook; post-incident rotation mandatory (NFR-018 mitigation) |
| Audit access | Audit reads are themselves audited; company owners see own-company audit exports; cross-tenant audit access = admin surface only |
| Data export controls | Ownership verification per export (invariant 19); archives never contain secret values (EXPORT-001); signed URLs tenant-prefix-scoped |
| Deletion controls | Two-step + cooling-off (ACC-005, COMP-007); staged purge honoring retention; redacted audit trace survives deletion |
| Model-provider data path | Platform keys server-side (ADR-003); provider processing locations documented in the subprocessor register (ADR-005); user-facing disclosure copy required pre-beta (ADR-003 §16) |
| Integration scopes | Future: minimum scopes requested, displayed, revocable (INTEG-001/003); revocation = fail closed (invariant 15) |
| Worker sandboxing | MVP: separate least-privilege worker process (no untrusted code executes in MVP — workers run our code against model APIs). **Escalation trigger:** software generation (future) requires ephemeral sandboxes before any generated code runs (ADR-012 boundary) |
| Generated-code isolation | Future zone: no platform credentials, no network path to platform internals, separate trust zone entirely (invariant 18, ADR-002) |
| Prompt-injection controls | NFR-021 + AI-AND-WORKER-ARCHITECTURE §4: untrusted content is inert data; injection corpus in CI; quarantine flow |
| Dependency security | Lockfile + dependency scanning gating CI (NFR-010); high+ advisories block deploy |
| Incident response | Severity taxonomy, on-call rotation (beta), tenant-notification policy, post-incident review with audit-trail reconstruction (NFR-008 enables); breach playbook includes rotation + disclosure steps |

## 2. Secrets (ADR-014 + ADR-021 — Infisical Cloud)

Provider: **Infisical Cloud** (ADR-021) with separate dev/test/staging/production scopes and **machine identities** per process type (api vs worker, least-privilege paths). Environment variables carry **bootstrap configuration only** (authenticate to Infisical + locate environment); hosting-provider env vars are never the store for dynamic per-tenant integration credentials.

Secrets **must**: live outside normal application records (values only in Infisical; DB holds only opaque `credential_ref` rows) · be referenced through opaque identifiers resolved server-side at use time · never be returned to clients (serializer denylist + negative tests; invariant 13) · be redacted from logs (pipeline-level scanner + CI scans; NFR-018) · never appear in model prompts, task outputs, activity events, or audit payloads (invariant 12 + event envelope rules) · be scoped to tenant and integration (resolution API requires tenant context; platform-global keys scoped to the gateway only) · be revocable (reference tombstoning takes effect before next resolution) · support rotation (dual-validity windows) · be unavailable to workers that do not require them (per-worker resolution grants aligned to tool allowlists — a research worker cannot resolve billing-provider credentials) · use controlled caching only when operationally necessary (bounded TTL, memory-only). **Outage behavior:** credential-using actions fail closed; short-lived cache provides in-flight grace; bootstrap failure = process does not serve traffic (ADR-021 §13). No enterprise dynamic-secret features required for MVP.

## 3. Administrative access

| Control | Rule |
|---|---|
| Access model | Just-in-time elevation, tightly scoped, time-boxed; standing admin credentials minimized |
| Reason capture | Every admin action requires a stated reason at invocation — recorded verbatim |
| Audit | 100% of admin actions audit-graded with actor, reason, scope, before/after refs |
| Tenant visibility | Where appropriate (support actions on a tenant's data), the tenant's own audit export shows that access occurred |
| No silent impersonation | Impersonation-style debugging requires explicit flagging, is visible in the tenant audit trail, and is disabled for approval decisions (an admin cannot approve *as* a customer) |
| Break-glass | Sealed high-privilege path: dual-control activation, alarms on use, mandatory post-use review, automatic expiry |
