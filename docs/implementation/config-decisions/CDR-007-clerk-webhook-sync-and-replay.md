# CDR-007 — Clerk Webhook Synchronization and Replay Strategy

1. **ID:** CDR-007
2. **Title:** Convergence-based webhook synchronization with replay safety
3. **Status:** Accepted
4. **Date:** 2026-07-18
5. **Owner:** Engineering (implements accepted ADR-022 §13)
6. **Source ticket:** ACBP-P0-008 (IOQ-08 / AOQ-24)
7. **Context:** ADR-022 requires signature-verified webhooks with idempotent, replay-safe consumers and drift reconciliation; identity integrity feeds NFR-002 and the launch gates.
8. **Decision:** Webhooks are **convergence triggers, never an ordered event stream**: (a) events consumed — user created/updated/deleted; organization + organization-membership created/updated/deleted; session-revocation-class events; (b) **signature verification mandatory** — unsigned/invalid rejected and audited; (c) **idempotency** — processed-event-id table; duplicates no-op; (d) **out-of-order safety** — handlers upsert the full current object guarded by the provider's `updated_at` (last-provider-write-wins, never arrival order); (e) **replay safety** — full redelivery of any window converges to identical state (trust-critical test in ACBP-P1-002); (f) **reconciliation** — nightly diff of provider state vs internal mappings; drift alerts + repair job; (g) **deletion synchronization** — provider deletion events *initiate* the internal ACC-005-governed flow; platform retention rules govern; IdP state never silently deletes platform data; (h) missed-webhook backfill via reconciliation, no manual replay dependence.
9. **Scope:** Identity-sync mechanics; membership/role authority remains internal (ADR-022 critical boundary).
10. **Alternatives:** ordered-delta application (breaks under reordering); poll-only (latency + waste).
11. **Reasons:** Convergence semantics are the only design correct under duplication, loss, and reordering simultaneously.
12. **Security impact:** Signature rejection audited; forged-webhook negative tests required; sync can never elevate authority (internal checks unchanged).
13. **Reliability impact:** Webhook outage degrades to next reconciliation sweep — bounded staleness, no corruption.
14. **Operational impact:** Drift metric + alert; reconciliation job in ops cadence.
15. **Cost impact:** Negligible fetch traffic on upserts.
16. **Portability impact:** Pattern is IdP-generic; supports the ADR-022 replacement boundary.
17. **Reversal cost:** Low.
18. **Requirement IDs:** ACC-002, ACC-004, NFR-002, NFR-008.
19. **Governing ADRs:** ADR-022, ADR-015.
20. **Implementation tickets unblocked:** ACBP-P1-002.
21. **Review trigger:** Drift incidents; Clerk webhook contract changes; reconciliation findings above threshold.
