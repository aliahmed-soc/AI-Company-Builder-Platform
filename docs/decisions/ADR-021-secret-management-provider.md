# ADR-021 — Secret-Management Provider

1. **Title:** Infisical Cloud as the dedicated secret-management provider
2. **Status:** Accepted
3. **Date:** 2026-07-18
4. **Owner:** Product owner
5. **Context:** ADR-014 (accepted with amendment) defines the pattern — opaque references, server-side resolution, per-component grants. AOQ-04 asked which provider holds the values. ADR-003 (accepted) requires platform-managed AI keys with strict isolation.
6. **Decision:** **Infisical Cloud** stores: AI-provider keys; billing-provider keys; integration OAuth client secrets; integration access and refresh tokens; signing secrets; administrative credentials; sensitive runtime configuration. **Environment variables carry only the minimum bootstrap configuration** needed for a process to authenticate to Infisical and locate its environment.
7. **Scope:** All platform and (future) tenant-integration secret values. Non-secret configuration stays in ordinary config.
8. **Explicit boundaries / required controls:** separate development, test, staging, and production secret scopes; **machine identities** for application and worker access; least-privilege path access; separate application vs worker access where practical (per-component resolution grants, ADR-014); tenant and integration **metadata in the database, secret values only in the vault**; opaque `credential_ref` identifiers in normal application records; rotation support (dual-validity windows); revocation (tombstoning effective before next resolution); access auditing; redacted errors and logs; **no secret values to browsers** (invariant 13); **no secret values in model prompts, task outputs, activity events, or audit payloads** (invariant 12 + event envelope rules); controlled caching with short lifetime only when operationally necessary. **No enterprise-only dynamic-secret features required for MVP.**
9. **Alternatives considered:** Cloud-native secret managers (AWS/GCP — strong but couples to a cloud the hosting choice avoided); HashiCorp Vault self-hosted (ops burden for a small team); Render env vars as the store (rejected outright — no rotation/scoping/auditing, and explicitly barred for per-tenant credentials).
10. **Positive consequences:** Purpose-built scoping/rotation/auditing; environment separation native; machine identities match the two-process topology.
11. **Negative consequences:** Third-party dependency in the credential path; bootstrap chicken-and-egg handled via minimal env-var bootstrap.
12. **Security implications:** Infisical joins the subprocessor register (ADR-005); vault access audit feeds NFR-008; leak-response runbook = immediate rotation (NFR-018).
13. **Operational implications — outage behavior (documented fallback/recovery):** secret-manager unavailability ⇒ **credential-using actions fail closed** (FAILURE-AND-RECOVERY pattern); processes may serve non-credential paths normally; a **short-lived controlled cache** (bounded TTL, memory-only, per ADR-014 caching rule) provides operational grace for in-flight work; recovery = re-resolution on next use; prolonged outage alerts operators and surfaces honest status. Bootstrap failure at process start = process does not serve traffic.
14. **Portability implications:** Secrets are exportable by an administrator through provider tooling for migration; `credential_ref` indirection means a provider swap touches the vault facade only (ADR-014 §13); export/migration runbook required before beta.
15. **Reversal cost:** Medium — facade-contained; value migration is a controlled operation.
16. **Requirement IDs:** NFR-018, INTEG-002, NFR-008, NFR-009, NFR-011.
17. **Governing architecture ADRs:** ADR-014 (pattern), ADR-003 (key ownership, accepted), ADR-020 (bootstrap env vars on Render), ADR-005 (subprocessor documentation).
18. **Follow-up work:** AOQ-22 select machine-identity method (per-process identities recommended); scope/path layout design; rotation + leak runbooks; provider-migration/export runbook; subprocessor register entry.
19. **Review triggers:** Infisical availability/security incident; pricing change; enterprise requirement for cloud-KMS custody; self-hosting decision (future).
