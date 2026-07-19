# DECISION-LOG.md — implementation decisions + sources (ACBP-P1-002)

Append significant decisions. Format: decision — source — consequence.

## CDR-008 (identity mapping) — owner-accepted
- Global identity-root `users` table, NOT tenant-scoped — CDR-008 #1 — no tenant session on identity repos.
- Uniqueness = `provider + provider_instance_id + provider_user_id` — CDR-008 #5 — provider-instance isolation.
- Minimal PII (primary email + verification only; no display name) — CDR-008 #4 — normalized email stored; deletes carry no PII.
- Soft delete + PII redaction + NO auto-resurrection — CDR-008 #3 — deleted rows tombstoned; later create/update → `deleted_identity_noop`.
- Successful-only receipts; PK `(provider, provider_instance_id, event_id)`; raw payload never stored (sha256 only) — CDR-008 #13 — idempotency ledger, no failure/attempt columns.
- Users only (`user.created/updated/deleted`); other events acknowledged no-op — CDR-008 #11.

## CDR-007 (convergence/ordering)
- Last-provider-write-wins on `provider_updated_at`; equal timestamps tie-broken by `eventId > stored last_event_id` (deterministic convergence tie-break, NOT a chronology claim) — CDR-007(d).

## Slice 2 verifier (ACBP-P1-002)
- Distinct stable public `ErrorCodes` per rejection class (headers missing/conflict, signature invalid, timestamp invalid, payload malformed, instance mismatch, verifier failed) — §4 hardening — category alone can't distinguish (5 are `authn`).
- Case-insensitive `svix-*`/`webhook-*` alias resolution; conflicting aliases → safe reject — Standard Webhooks + §5.

## Slice 3 (this slice)
- **Composition lives in `@acbp/core`** (`createClerkIdentityRuntime`), not apps/web — repo boundary map confines `apps/web` to core/contracts/config/observability; core is already allowed to import adapters+database, so this needs ZERO boundary-checker changes and keeps `@clerk/*` out of the web bundle. Consequence: web imports the domain only through `@acbp/core`.
- **Read-through convergence** uses `UserMappingRepository.insertIfAbsent` (`ON CONFLICT (identity cols) DO NOTHING` + re-read) — CDR-008 race safety — scoped to the exact identity constraint; unrelated 23505/23514 propagate as sanitized failures, never `duplicate`.
- **Read-through writes no webhook receipt** and sets `last_event_id = null` — read-through is authoritative sync, not a synthetic webhook. A later webhook with equal `provider_updated_at` applies (any non-empty id sorts after `null`) and keeps the immutable internal id.
- **Webhook processor left unchanged** across the read-through/webhook race — sequential "webhook after read-through" converges via find+update; the concurrent edge preserves the one-row invariant via the DB unique constraint (a losing webhook insert fails sanitized + is retried by the provider). Avoids churn to hosted-green Slice 2.
- New provider-neutral contract `AuthoritativeIdentityReader` — separate from session `IdentityProvider` and `IdentityWebhookVerifier` (CDR-008 #6 separation) — Clerk impl in adapters returns a neutral snapshot only.
- Webhook body cap **256 KiB**, dual-enforced (declared Content-Length precheck + streamed count) — DoS safety; no decode before verification.

## Nightly reconciliation (this slice)
- **Reconciliation is NON-DESTRUCTIVE**: it repairs FORWARD drift only (provider snapshot newer than stored → last-write-wins update of email/verification/provider_updated_at), never deletes. A provider `not_found` (404) or `unavailable` during reconciliation is counted/logged, NOT auto-tombstoned. — Source: safer-reversible-interpretation rule; CDR-008 keeps deletion **webhook-first** (delete webhook is the deletion mechanism); 404-based auto-deletion is dangerous (a transient reader/pagination fault could mass-delete). Consequence: reconciliation does NOT change deletion semantics, so it needs no owner gate. Auto-tombstone-on-provider-missing is a DEFERRED owner-gated decision (deletion semantics) if the owner wants webhook-miss deletes reconciled.
- Reconciliation reuses the existing convergence ordering (`isNewer` on `provider_updated_at`, tie-break by `last_event_id`); it enumerates only `active` rows (tombstones skipped → no resurrection) via keyset pagination on `id` (deterministic); re-reads the row inside a short transaction before updating (skips if it became deleted); leaves `last_event_id` unchanged (not a webhook event). Idempotent: a second run reports all `in_sync`.
- Worker command is runnable (`apps/worker`) but wires **no scheduler** and performs no deployment (out of scope; owner-gated) — it runs once per invocation and exits with a bounded summary.
