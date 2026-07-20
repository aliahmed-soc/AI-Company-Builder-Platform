# CDR-008 — Internal User Mapping: Implementation Decisions

1. **ID:** CDR-008
2. **Title:** Identity-root user mapping, verified webhook envelope, and successful-only receipts
3. **Status:** Accepted
4. **Date:** 2026-07-19
5. **Owner:** Product owner (implements ADR-022 §13 via CDR-007)
6. **Source ticket:** ACBP-P1-002
7. **Context:** ADR-022 §13 and **CDR-007** define the convergence-based, signature-verified, replay-safe webhook strategy. This CDR records only the **implementation-level** decisions for ACBP-P1-002; it does not restate or amend ADR-022 or CDR-007 (both remain the governing authorities).
8. **Decisions:**
   1. **Identity-root `users`.** `users` is a global identity-root table — **no `tenant_id`, no `account_id`, and no account RLS** on identity-root records. Account membership is separate and belongs to **ACBP-P1-004**.
   2. **Webhook-first synchronization** with authoritative server-side **read-through reconciliation on mapping miss**: an authenticated server path may fetch the authoritative provider Backend User and converge the mapping when a webhook has not yet arrived (Clerk documents webhook delivery as asynchronous and not a gate on synchronous onboarding). **Users are never created from browser claims or unverified session data.**
   3. **Soft deletion.** On provider deletion: `status='deleted'`, set `deleted_at`, **redact stored email** (`primary_email = NULL`), `email_verified = false`, and **deny resolution**. A deleted provider identity is **never automatically resurrected**.
   4. **Minimal PII.** Store only the normalized **primary email** and its **verification state**. **No display name** in P1-002. Email is **not unique**.
   5. **Provider-instance isolation.** Mapping uniqueness is `(provider, provider_instance_id, provider_user_id)`. Clerk webhook envelopes carry `instance_id`, an event timestamp, and user payloads carry `created_at`/`updated_at`.
   6. **Separate webhook contract.** Introduce a provider-neutral **verified webhook envelope + verifier contract**, distinct from the session-oriented `IdentityProvider` (which is not overloaded).
   7. **Users only.** Memberships, organizations, roles, and permissions remain **P1-004** scope, despite the ticket's broad `users;memberships` data-object reference.
   8. **Reconciliation** logic plus a runnable `apps/worker` command; default cadence **nightly**. Production scheduler wiring may remain an explicit deployment follow-up if no scheduler exists yet.
   9. **Receipts retained indefinitely** for MVP; no automatic pruning until production volume/replay needs are known.
   10. **Endpoint:** `POST /api/webhooks/clerk`.
   11. **Subscribed events:** `user.created`, `user.updated`, `user.deleted` only. Every other **verified** event (including `session.revoked`) is an **acknowledged no-op**.
   12. **Ordering:** out-of-order safety via last-provider-write-wins guarded by the provider `updated_at` (CDR-007 (d)); arrival order is never authoritative.
   13. **Receipts record successful events only.** The processed-event receipt is written **in the same transaction** as the user mutation; a failed user mutation **rolls back the receipt** so retries are never suppressed. There is **no `failed` status and no `attempt_count`** in the receipt table.
   14. **Receipt duplicate handling:** same `event_id` + same `payload_sha256` ⇒ successful **no-op**; same `event_id` + **different** hash ⇒ **security conflict** → sanitized failure + audit event, **no user mutation**. The **raw payload is never stored** (only its lowercase 64-hex SHA-256).
   15. **Delivery:** one PR with reviewable commits; **no local tunnel** until the endpoint is locally complete and green and separate owner authorization is granted.
9. **Scope:** Identity-sync persistence + provider-neutral webhook contracts + configuration for ACBP-P1-002. Excludes memberships/orgs/roles/permissions/authorization (P1-004), billing, and any tenant-membership modeling.
10. **Alternatives:** tenant-scoped `users` (rejected — identity root precedes account context and webhooks have no tenant session); receipts with `failed`/`attempt_count` (rejected — would suppress legitimate retries and can desync from the atomic mutation).
11. **Security impact:** signature verification precedes any persistence (CDR-007 (b)); hash-mismatch on a known `event_id` is treated as a conflict, not silently accepted; only minimal PII stored; soft-deletion redacts PII.
12. **Reliability impact:** atomic receipt+mutation prevents partial commits; missed webhooks converge via read-through and nightly reconciliation (bounded staleness).
13. **Reversal cost:** Low — reversible migration; provider-neutral contracts keep the IdP-replacement boundary intact.
14. **Requirement IDs:** ACC-002, NFR-002 (deletion initiation relates to ACC-005, which remains Post-MVP; P1-002 performs soft-delete + audit and does not implement the full ACC-005 flow).
15. **Governing ADRs / CDRs:** ADR-022, ADR-023, CDR-007.
16. **Implementation slices:** (1) CDR + schema/migration + neutral webhook contracts + config + tests [this slice]; (2) signature adapter; (3) transactional idempotent processor + repository; (4) Next.js route; (5) reconciliation worker command; (6) live acceptance; (7) backlog sync.
17. **Review trigger:** Clerk webhook contract changes; reconciliation drift findings; ACC-005 flow implementation (revisit deletion behavior).
