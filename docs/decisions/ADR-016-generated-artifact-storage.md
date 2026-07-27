# ADR-016 — Generated Artifact Storage

1. **Title:** Object storage for artifact content with tenant-prefixed paths, versioned metadata rows, and export-ready open formats
2. **Status:** Accepted (owner review 2026-07-18 — portability condition verified; `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** TASK-005 requires persistent provenance-carrying artifacts; EXPORT-001/NFR-014 require open-format portability; ADR-002 requires export as the ownership guarantee.
5. **Decision proposal:** Artifact/document *content* lives in S3-compatible object storage under `company/{company_id}/...` prefixes (invariant 19 pathing); *metadata* (versions, provenance: worker@version, run, model@version, template@version, inputs refs, usefulness ratings) lives in Postgres rows. Documents stored in open formats (Markdown/JSON primary; renderers derive presentation). Content-addressed keys make writes idempotent. Versioning: new version per revision, lineage-linked (J-13); no destructive overwrite. Artifact persistence failure fails the task (no hollow success). Export jobs assemble archives + manifests from the tenant prefix after ownership verification; archives never include secret values. Future generated-code bundles (BUILD-003) follow the same pattern with reproducibility manifests (EXPORT-002 direction).
6. **Requirement IDs:** TASK-005, EXPORT-001, EXPORT-002, NFR-014, ROAD-002, BUILD-003 (future), COMP-007 (export offer).
7. **Alternatives:** Everything in Postgres (bloat, expensive exports); proprietary document formats (violates NFR-014); external DMS (unneeded dependency).
8. **Benefits:** Cheap durable content; clean export path; provenance queryable in SQL.
9. **Costs:** Two-store consistency (mitigate: metadata row committed only after content write confirms).
10. **Risks:** Orphaned objects (reconciliation sweep); signed-URL scope errors (prefix-scoped generation, tested).
11. **Security implications:** Tenant pathing + scoped signed URLs; at-rest encryption (NFR-011).
12. **Operational implications:** Storage lifecycle rules; export-job monitoring.
13. **Reversal cost:** Low-Medium.
14. **Scale trigger:** None foreseen for MVP scale.
15. **Open questions:** ~~AOQ-03 (storage provider)~~ — **RESOLVED 2026-07-27** by the owner decision recorded in docs/implementation/config-decisions/CDR-048-object-storage-provider.md: S3-compatible storage, one bucket per environment, `company_id`-scoped keys, no public bucket access, reads via short-lived signed URLs. The protocol class and topology are fixed; the concrete VENDOR is still unnamed, which blocks the subprocessor register row and any residency claim (see docs/architecture/SUBPROCESSOR-REGISTER.md) but blocks no engineering, since the contract is provider-neutral.
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted under the owner's portability condition, which is satisfied: S3-compatible contract, open formats, no provider-proprietary API. Object-storage provider selection remains open (AOQ-03).
Date: 2026-07-18
```
