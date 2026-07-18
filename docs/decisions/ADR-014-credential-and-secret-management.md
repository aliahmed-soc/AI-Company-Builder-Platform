# ADR-014 — Credential and Secret Management

1. **Title:** Managed secret store with opaque references, server-side resolution, and per-worker resolution grants
2. **Status:** Accepted with amendment (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** ADR-003 (accepted) mandates platform-managed AI keys, secret isolation, server-side credential use, no keys to clients. NFR-018 requires zero-findings scanning; INTEG-002 extends to future customer connections.
5. **Decision proposal:** All secret values live in a managed KMS-backed secret store. The database holds only opaque `credential_ref` rows (provider, scope, tenant, rotation state — never values). Resolution happens server-side at use time through a vault facade requiring tenant context; resolution grants are scoped per component (the gateway resolves model keys; a research worker cannot resolve billing credentials). Rotation via dual-validity windows; revocation via reference tombstoning effective before next resolution. Client serializers carry a denylist; log pipeline and CI run secret scanners; negative API tests prove no secret egress (launch gate 12).
6. **Requirement IDs:** NFR-018, INTEG-002, ADR-003 controls; BUILD-004 (future user app secrets follow the same pattern).
7. **Alternatives:** Encrypted DB columns (custody + rotation burden, weaker isolation); env-var-only secrets (no rotation, no scoping); per-service vaults (premature).
8. **Benefits:** Invariants 12/13 structurally enforced; rotation without downtime; BYOK-later slots in as new reference types.
9. **Costs:** Provider dependency (AOQ-04); facade development.
10. **Risks:** Vault outage blocks credential-using actions (fail closed — accepted behavior, FAILURE §5-analog); mis-scoped grants (reviewed as code).
11. **Security implications:** The central secrecy control; break-glass access alarmed.
12. **Operational implications:** Rotation runbook; leak-response runbook (immediate rotation).
13. **Reversal cost:** Medium.
14. **Scale trigger:** Customer-connection volume (post-MVP integrations) → per-tenant sub-scoping already designed in.
15. **Open questions:** AOQ-04 (provider selection).
16. **Owner approval:**

```text
Owner decision:
[ ] Accept   [x] Accept with changes   [ ] Reject   [ ] Defer
Notes: AMENDMENT — provider bound to Infisical Cloud (ADR-021): dev/test/staging/prod scopes, machine identities per process type, least-privilege paths, bootstrap-only env vars, short-lived controlled caching, no enterprise dynamic-secrets dependency, outage behavior documented. Hosting-provider env vars are NOT the store for dynamic per-tenant integration credentials.
Date: 2026-07-18
```
