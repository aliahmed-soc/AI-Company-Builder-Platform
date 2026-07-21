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

## Live-acceptance fixes (2026-07-20) — three real defects only live runtime could surface
- **Clerk webhook envelope contract corrected.** Verified against real signed deliveries: Clerk webhook
  BODIES carry NO top-level `instance_id` or `timestamp` (only `type|object|data|event_attributes`). The
  Slice-2 verifier read both from the body (per the CDR-008 assumption), so EVERY real event was rejected
  as `WEBHOOK_PAYLOAD_MALFORMED`. Fix (`packages/adapters/src/clerk/webhook.ts`): `providerInstanceId`
  now comes from the CONFIGURED expected instance id (the delivery is cryptographically bound to one
  instance by the instance-specific signing secret; `CLERK_WEBHOOK_INSTANCE_ID` is now load-bearing on
  the webhook path, fail-closed if unset), and `occurredAt` comes from the signed `svix-timestamp` header
  (Unix seconds). Per-event ordering still uses the user's own `updated_at` (present in `data`). The
  payload-instance-mismatch check was removed (nothing to compare; isolation is via the signing secret).
  Not an owner gate: it corrects an internal normalization to the provider's real contract; it does not
  change data ownership, authorization, tenant isolation, deletion semantics, or the neutral event shape.
- **Web app pinned to the webpack bundler.** Next 16 defaults to Turbopack, which cannot resolve our
  workspace-package barrels that re-export files importing OTHER workspace packages (returns "module has
  no exports at all"). `apps/web` scripts pass `--webpack` and `next.config.ts` adds `transpilePackages`
  (so Next transpiles the `@acbp/*` TS source) + a webpack `extensionAlias` (so NodeNext-style `.js`
  specifiers resolve to `.ts` sources). The webhook route is the first path importing `@acbp/*` as runtime
  VALUES, so this never surfaced before (P1-001 used only an erased type import).
- **UTF-8 BOM stripped from 47 files + a guard added.** Several scaffold-written `package.json`/`.ts`
  files began with a UTF-8 BOM. Node/tsc/vitest strip it silently (so all gates were green), but bundlers
  reject a BOM'd `package.json` ("Unexpected token '﻿'"), which blocked the route at runtime. New
  `tools/check-encoding.mjs` (wired into `check:static`) fails the build on any BOM — the regression
  coverage CI was missing.

## ACBP-P1-003 — Account creation and profile (opened 2026-07-21)
- **Account-model seam resolved → CDR-010 (owner-accepted, Option A).** On first sign-in a **personal
  account** is auto-provisioned per user; the founder is recorded as an **immutable, unique**
  `accounts.created_by_user_id` (bootstrap owner). It is **provenance only** — P1-004 backfills a
  `role='owner'` membership from it and authorization derives from memberships thereafter. Alternatives B
  (defer all linkage to P1-004 → orphaned account, fails acceptance criterion) and C (create a full
  memberships row now → pre-empts P1-004) were rejected. Source: owner decision 2026-07-21 + DATA-ARCHITECTURE
  Account/Membership rows + `account.created` event `{account_id, plan_state}`.
- **Account is A-root, not company-scoped.** `accounts` has no `company_id` and no company RLS (RLS is
  P1-006). Status `active|suspended|closed`; `plan_state` default `'free'` (matches the event payload).
- **Profile is account-owned (1:1 `account_profiles`, `display_name`+`locale`).** Identity-root `users`
  stays minimal (CDR-008 #4) — no platform-owned mutable profile columns on `users`.
- **Email stays Clerk-authoritative + read-only.** ACC-003 "email re-verification on change" is delegated
  to Clerk and syncs back via the P1-002 `user.updated` path; P1-003 mutates no email and needs no Clerk
  secret at runtime. In-app email mutation (Clerk Backend API) is a deferred follow-up.
- **Idempotent provisioning** via `INSERT … ON CONFLICT (created_by_user_id) DO NOTHING` + re-read
  (mirrors P1-002 `insertIfAbsent`), scoped to the exact unique constraint; unrelated violations sanitize.
- **Interim audit** = structured `account.created`/`account.profile_updated` events (ADR-017/P0-017); the
  durable append-only store is P1-008. Tests assert emitted PII-safe shape, not a durable write.

### Slice 2 (schema/migration/repositories) infra decisions
- **Integration test files now run serially (`fileParallelism: false` in `vitest.config.ts`).** Every
  real-PostgreSQL suite targets the ONE shared `ACBP_TEST_DATABASE_URL` and does destructive setup (drops
  all tables in `beforeAll`; the migration suites run `migrate-down` mid-test). Running files concurrently
  let one suite drop/rebuild tables another was mid-read on — latent timing-dependent flakiness that
  P1-002 survived only on CI's low core count. Adding the 6th (accounts) suite made it deterministically
  fail locally. Serial files make the shared-DB run deterministic on every core count; the suite is small
  so wall-clock cost is negligible. Fixes the root cause for all current and future DB suites.
- **`updated_at` is DB-authoritative (`sql\`now()\``) in `AccountProfileRepository.update`.** `created_at`
  is DB-set (default `now()`); stamping `updated_at` from the app clock (`new Date()`) let app↔database
  clock skew make `updated_at < created_at` (surfaced by a ~384 ms Windows↔WSL2 skew locally, and a real
  production risk). Sourcing both timestamps from the database clock guarantees `updated_at >= created_at`.
- **One migrate-down across the whole integration set.** Migration reversibility for `0003` is covered by
  the existing database/user-mapping reversibility tests (made migration-count-agnostic: reverse batches
  until the target tables are gone, then re-apply). The accounts suite deliberately runs no migrate-down,
  keeping exactly one destructive migration cycle in the shared-DB run.
- **All suites' cleanup drop-lists include `accounts`+`account_profiles`** (child-first) so a suite that
  wipes `kysely_migration` and re-migrates cannot hit a stale later-ticket table (the P1-002
  `_acbp_migration_probe` lesson).

## ACBP-P1-004 — Membership and roles (opened 2026-07-21)
- **Membership/invitation model → CDR-011 (owner-accepted, Option A).** Account-level `memberships`
  (owner/viewer), owner backfilled from `accounts.created_by_user_id`; **email-bound single-use invites**
  (hashed token; acceptance requires the accepting user's VERIFIED primary email to match the invited
  email — a leaked token can't let anyone join); revocation immediate; roles server-authoritative (Clerk
  claims never authorize), deny by default. `memberships.company_id` is a **nullable column with no FK
  yet** — the companies FK + company-scoped invite behavior land in **P1-010** (companies), because the
  dependency graph forces membership before companies and unvalidated company-scoping is unsafe.
  Alternatives rejected by owner: token-only invites (B — leaked token risk), omit company_id now (C —
  later table-altering migration), full unvalidated company-scoping (D). Source: owner decision +
  DATA-ARCHITECTURE (membership has company scope) + backlog ordering (companies = P1-010).
- **Role enforcement is scoped to membership operations** (owner-only invite/revoke; viewer read-only) —
  NOT the general `authz.check` middleware (P1-007), and NOT a retrofit of the P1-003 profile route (which
  operates on the caller's own personal account and is unaffected). Interim audit via structured
  `membership.invited/accepted/revoked/role_changed` events (non-PII: account/membership id + role; never
  the invited email or token); durable store is P1-008.
