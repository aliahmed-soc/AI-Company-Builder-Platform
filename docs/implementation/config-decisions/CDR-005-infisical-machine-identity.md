# CDR-005 — Infisical Machine-Identity Method

1. **ID:** CDR-005
2. **Title:** Per-process machine identities with least-privilege paths
3. **Status:** Accepted
4. **Date:** 2026-07-18
5. **Owner:** Engineering (implements accepted ADR-021 §18 recommendation)
6. **Source ticket:** ACBP-P0-006 (IOQ-06 / AOQ-22)
7. **Context:** ADR-021 requires machine identities for application and worker access with least-privilege paths, bootstrap-only env vars, rotation/revocation, and documented outage behavior.
8. **Decision:** **Separate machine identities per process type per environment** (api-prod, worker-prod, api-staging, worker-staging; test = CI-scoped identity limited to test paths; local dev = personal developer identities on the dev scope only). Mechanism: Universal-Auth-class client-credential identities; **OIDC-federated auth adopted for CI (and Render services if supported) as a no-static-credential enhancement where the provider supports it** — verified against Infisical's current auth catalog at ACBP-P0-019. Path grants: worker identities resolve model-provider keys; api identities resolve api-side secrets (webhook signing, future billing); neither reads the other's paths (ADR-014 per-component grants). Rotation via dual-validity; revocation tombstones effective before next resolution; bootstrap = the minimal identity credential set in env vars per ADR-021 §8; outage behavior per ADR-021 §13.
9. **Scope:** Secret-access identity design; vault facade contract is ACBP-P0-019.
10. **Alternatives:** shared identity (rejected — least-privilege violation); env-var secrets (barred by ADR-021).
11. **Reasons:** Blast-radius containment; per-process revocation; matches the two-process topology exactly.
12. **Security impact:** A compromised worker identity cannot read api-side secrets and vice versa; CI can never read production paths.
13. **Reliability impact:** Outage = fail closed with bounded cache grace (unchanged).
14. **Operational impact:** Identity inventory (≤8 identities) documented in the security runbook.
15. **Cost impact:** None material.
16. **Portability impact:** Identity pattern is provider-generic; swap contained in the vault facade.
17. **Reversal cost:** Low.
18. **Requirement IDs:** NFR-018, INTEG-002.
19. **Governing ADRs:** ADR-014, ADR-021.
20. **Implementation tickets unblocked:** ACBP-P0-015, ACBP-P0-019.
21. **Review trigger:** Infisical auth-catalog changes; any credential incident; addition of new process types.
