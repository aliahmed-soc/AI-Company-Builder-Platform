# CDR-006 — Clerk Sign-In Configuration

1. **ID:** CDR-006
2. **Title:** Initial sign-in methods and verification requirements
3. **Status:** Accepted
4. **Date:** 2026-07-18
5. **Owner:** Product owner (segment-fit default authorized; additive changes data-driven)
6. **Source ticket:** ACBP-P0-007 (IOQ-07 / AOQ-23)
7. **Context:** ADR-022 selects Clerk; ADR-001's segment (non-technical solo founders) prizes low-friction consumer sign-in; ACC-001 requires email verification before activation.
8. **Decision:** Initial methods: **email/password + Google social login**. **Email verification required before any autonomous feature activates**, regardless of method (Google-verified emails satisfy verification per Clerk's assertion, still recorded internally). Additional social providers post-beta, justified by signup-funnel data. All identities flow through internal user mapping (ADR-022) — sign-in method carries zero authorization semantics.
9. **Scope:** Sign-in surface configuration; mapping/webhooks are CDR-007; authorization boundary unchanged.
10. **Alternatives:** email-only (more friction); broad social set (surface without evidence).
11. **Reasons:** One dominant consumer IdP covers the segment; smallest review/test surface.
12. **Security impact:** Google addition is identity-only; forged-claim negative tests unaffected.
13. **Reliability impact:** Clerk outage behavior per ADR-022 §13 (unchanged).
14. **Operational impact:** One OAuth app registration to manage.
15. **Cost impact:** None beyond Clerk MAU.
16. **Portability impact:** IdP-replacement boundary unchanged (ADR-022 §14).
17. **Reversal cost:** Low (additive/removable).
18. **Requirement IDs:** ACC-001, ACC-002.
19. **Governing ADRs:** ADR-001, ADR-022.
20. **Implementation tickets unblocked:** ACBP-P1-001.
21. **Review trigger:** Beta signup-abandonment data; segment change (D-01 review).
