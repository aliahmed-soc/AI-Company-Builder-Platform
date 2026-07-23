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

## ACBP-P1-005 — Tenant-context primitives (opened 2026-07-21)
- **Account-vs-company tenancy-primitive seam → CDR-012 (owner-accepted, Option B).** P0-018 already
  delivered the *company-level* primitive (`TenantContext {accountId, companyId, actorId?}`, branded
  `TenantScope`, `withTenantTransaction`, `TenantRepository`, `app.current_account/company/actor` GUCs,
  compile proof) — so "repos require tenant context structurally" is already true. P1-005 adds the missing
  *membership-resolution* half, but memberships are account-level (CDR-011) and companies don't exist until
  P1-010, so the company-level `TenantContext` (companyId required) can't carry account context. Owner chose
  **Option B**: a SEPARATE, type-distinct account-level primitive — `AccountContext {accountId, actorId?}`
  (NO companyId), branded `AccountScope` (distinct brand; unforgeable outside `@acbp/database`),
  `withAccountTransaction` (only scope-minting path; applies `app.current_account` + `app.current_actor` via
  `SET LOCAL`; NEVER sets `app.current_company`), and an `AccountScopedRepository` base requiring `AccountScope`.
  The company primitive is left UNCHANGED and companyId stays required (Option A — making companyId optional
  — was rejected: it would put an empty-company state into the company primitive and make company fail-
  closure a runtime rather than a type-level guarantee). No alias/shared brand may collapse the two scopes;
  an account-only scope must never construct a company repository. P1-006 adds account-level RLS keyed to
  `app.current_account`; P1-010 provides real company resolution. Source: owner decision 2026-07-21 +
  ADR-007 (two-layer isolation; membership is the tenant authority) + DATA-ARCHITECTURE §2 (A vs C tenancy).
- **Resolution is membership-backed and deny-by-default.** The resolver takes a SERVER-VERIFIED internal
  `userId` + a REQUESTED `accountId` (treated only as a request, never as authority) and returns a resolved
  `AccountContext` only when the caller has an ACTIVE membership in that account; invited/revoked/missing/
  inactive/cross-account all deny with a COARSE reason (no existence/state oracle). No Clerk org/role claim
  is ever consulted; revocation is effective on the next resolution; multi-membership is deterministic
  because resolution is keyed to the explicit requested account. Database scope is minted ONLY after
  membership validation. Interim `tenant.context_denied` structured audit event carries only non-PII
  (account id, actor id, coarse reason); durable store is P1-008.

## ACBP-P1-006 — Database row-level security layer (opened 2026-07-21)
- **RLS enforcement model → CDR-013 (owner-accepted, Option A + A1).** FORCE RLS on the three account-owned
  tables (accounts, account_profiles, memberships); global users/receipts excluded. Normal app traffic runs
  as a **restricted role** (`acbp_app`: NOSUPERUSER/NOBYPASSRLS/non-owner) subject to RLS; the migration/owner
  role (BYPASSRLS in prod, superuser in CI) owns tables+functions and runs migrations only. Exactly **three**
  narrow SECURITY DEFINER bootstrap functions form a closed allowlist — `acbp_provision_account`,
  `acbp_resolve_own_membership`, `acbp_accept_invite` — each fixed-search_path, schema-qualified, no dynamic
  SQL, EXECUTE revoked from PUBLIC + granted only to `acbp_app`, bypassing RLS only for its exact atomic
  transition. **A1** (owner-approved): the accept bootstrap is required because the invitee is not yet an
  active member and cannot obtain AccountScope pre-activation; it takes `(invite_token_hash, auth_user_id)`
  and binds the email from **platform-authoritative** `users.primary_email` (active + verified), never a
  caller parameter. **A token-bearing RLS policy/GUC was rejected** (owner); owner-role execution from normal
  app code was rejected; ENABLE-only/latent was rejected. Fail-closed policies via TEXT comparison (no
  uuid-cast exceptions). Company RLS deferred to P1-010. Source: owner decisions 2026-07-21 + ADR-007 +
  DATA-ARCHITECTURE §2 + CDR-008/010/011/012.

## ACBP-P1-007 — Authorization middleware (opened 2026-07-21)
- **No new owner decision / no CDR.** P1-007 introduces the central `authz.check` (ADR-022 flow's internal
  role-check step) as a **behavior-preserving centralization** of the owner/viewer gates that already exist
  inline in each core use case (`isOwner`/`isMember`). It changes WHO-can-do-WHAT for nobody, and is fully
  derived from accepted decisions (ADR-022 §8 mandatory flow; ADR-006 "single authz layer"; ADR-007 tenant
  authority; SECURITY-ARCHITECTURE §1 "Central `authz.check` in identity module; deny by default; denials
  audited"). Because there is no fork and no change to authorization/data-ownership/tenant-isolation
  semantics, this ticket records NO CDR (contrast CDR-012/CDR-013 which resolved genuine owner forks).
- **Decision model (grounded, minimal):** role × action → allow/deny, deny-by-default, actions a CLOSED set
  (`resource:verb`), resource implicit in the action. `authz.check` is a 4th INDEPENDENT control layered
  above authn (Clerk session + verified identity), AccountContext (P1-005), and RLS (P1-006): it decides
  "may THIS role perform THIS action?" only AFTER the account is resolved. It mints no scope, selects no DB
  connection, bypasses no RLS, and consults no Clerk org/role claim. Role is loaded fresh from the ACTIVE
  membership row at each decision (no caching) so revocation/role-change take effect on the next request.
- **Action matrix** (mirrors existing semantics): member:invite→owner; member:revoke→owner;
  member:list→owner|viewer; member:read_invited_email→owner (viewer email-redaction, modeled explicitly);
  profile:read→owner; profile:update→owner. Excluded (pre-context/public, not role-gated): acceptInvite,
  provisionPersonalAccount, Clerk webhook (signature-only). Deferred: company authz (P1-010), policy/approval
  (ADR-009/010), configurable roles, durable audit (P1-008). Source: BACKLOG ACBP-P1-007 + ADR-022/006/007 +
  SECURITY-ARCHITECTURE §1 + existing roles.ts/membership-service.ts/profile.ts semantics.

## ACBP-P1-008 — Audit event foundation (opened 2026-07-22)
- **Audit-store scope & shape → CDR-014 (owner-accepted, Option A).** ADR-015 mandates ONE append-only audit
  store spanning company/account/global (C/A/G) rows, but the P1-006 RLS model keys only on
  `app.current_account` (company GUC never set until P1-010; global rows have no tenant predicate under FORCE
  RLS), so global/company rows can't be inserted under the restricted `acbp_app` role without a permissive
  leaky policy or a **prohibited 4th SECURITY DEFINER function**; canon is also silent on global-row account_id
  nullability and denial-persistence-vs-rollback. The owner scoped the P1-008 **first cut** to **account-scoped
  only**: one `audit_events` table with `account_id` NOT NULL (no company_id yet; no FK so a redacted trace
  survives deletion), FORCE RLS keyed to `app.current_account`, append-only (acbp_app gets INSERT+SELECT only,
  NO UPDATE/DELETE/TRUNCATE — invariant 11 by persistence constraint), an in-tx account-scoped writer (account/
  actor/event_id/occurred_at bound server-side, unforgeable) whose write failure rolls back the business tx and
  blocks the action, and durable persistence of exactly the two account-scoped high-risk lifecycle successes
  `membership.invited`/`membership.revoked`. **Deferred (stay interim logs):** denials, global (webhook/
  reconcile), pre-context bootstrap (account.created, membership.accepted), lower-risk (profile_updated → outbox).
  **Out of scope:** company audit (P1-010), outbox + activity feed (P1-009+), read/export/admin API, retention
  job. **Rejected:** Option B (single C/A/G table with nullable tenant + global rows — needs a leaky global
  policy or a prohibited privileged path); Option C (audit the 2 bootstrap events via the existing 3 SECURITY
  DEFINER fns — expands elevated surface). Source: owner decision 2026-07-22 + ADR-015 + EVENT-CATALOG envelope +
  DATA-ARCHITECTURE §2/`:41` + TECHNICAL-ARCHITECTURE-v1 invariant 11 + FAILURE-AND-RECOVERY row 14 +
  ENGINEERING-STANDARDS `:20-21,35,47` + TENANCY/CDR-013 (RLS + 3-fn allowlist) + CDR-009 (retention).

## ACBP-P1-010 — Company lifecycle (opened 2026-07-22)
- **Company data model / tenancy / creation bootstrap → CDR-015 (owner-accepted, 2026-07-22).** MANY companies per
  account (company belongs to exactly one account; company_id/account_id immutable; no default company). Company
  membership in a **SEPARATE `company_memberships` table** — account `memberships` + its unique index + account-
  context resolver + account RLS stay UNCHANGED; company membership is independent (requires an active account
  membership; account ownership does NOT auto-grant company access; creator gets an explicit active company owner
  row; roles owner|viewer; no company invitation flow). Company creation runs **under the existing restricted
  AccountScope with an account-keyed `companies` INSERT policy — NO 4th SECURITY DEFINER function** (allowlist stays
  three); one atomic tx inserts company → mints CompanyScope from the authoritative row → sets app.current_company →
  inserts owner membership → inserts profile v1 → writes company.created audit → commit-all-or-rollback-all.
  `CompanyContext {accountId, companyId, actorId}`; branded CompanyScope type-distinct from AccountScope (reserved
  P1-005 TenantContext/TenantScope); requested companyId is a selector never authority; no Clerk/request claim is
  authority. Company RLS keyed to app.current_account + app.current_company (both must match; fail-closed).
  **audit_events gains nullable `company_id`** (additive expand; account events NULL, company events set;
  append-only preserved; dual-scope policy — account: company_id NULL; company: both match). **Exactly four durable
  company events** (company.created/updated/paused/resumed). **Deactivate/delete deferred** (COMP-007 Post-MVP);
  portfolio/switching P1-011; provisioning P1-012; activity feed + outbox P1-009+. Profile = immutable revision
  model (COMP-004 version history + last-write-wins visible history). **REJECTED:** extending the shared memberships
  table with company-scoped rows (would rework the P1-004 unique index/queries/RLS); a 4th acbp_provision_company
  SECURITY DEFINER function; including deactivate. **P1-009 resequencing correction:** ACBP-P1-009 Dependencies →
  `ACBP-P1-008;ACBP-P1-010` (company-scoped feed needs P1-010's company boundary + durable company.* events);
  P1-009 stays Planned, acceptance unchanged. Source: owner decision 2026-07-22 + COMP-001/004/005/006/008 +
  ADR-006/007 + WORKFLOW-STATE-MACHINES §1 + DATA-ARCHITECTURE + TENANCY + CDR-011/012/013/014 + EVENT-CATALOG.

## ACBP-P1-010 review pass (2026-07-22) — independent security/scope/correctness reviews
- Reviews clean: scope FULLY COMPLIANT (0 deviations); security no CRITICAL/HIGH; correctness no High defect — 3 reviewers + own catalog/diff checks cover all 16 required areas.
- Concurrent profile rename now bounded-retries the (company_id,version) append race (true last-write-wins), coarse conflict->409 after N attempts — correctness review F1/security LOW-2 — no 500 on the common concurrent-rename path.
- Pause/resume assert the SPECIFIC prior status (active->pause, paused->resume) — review F2 — onboarding->active provisioning (P1-012) cannot be forced via owner resume; audit never mislabeled.
- No caller-supplied free-text pause/resume reason accepted or persisted — security review LOW-1 — data minimization on the immutable audit store; pause/resume take no request body.
- Accepted residuals: getCompany status/displayStatus divergence (unreachable behind DB CHECK; fail-closed) and thrown transient DB error -> bare 500 (pre-existing non-leaking pattern shared with membership ops).

## ACBP-P1-009 activity event foundation (CDR-016) — owner-accepted 2026-07-22
- Separate append-only company-scoped activity_events table, PK = source audit event_id (redacted, rebuildable) — DATA-ARCHITECTURE/diagram-11 projection fidelity — a materialized projection, not a read-view of audit_events.
- Synchronous in-transaction projection of the 4 company.* events, written atomically with the lifecycle mutation + audit under the same restricted acbp_app CompanyScope — no outbox/async/worker/checkpoint/lease/owner-connection/4th SECURITY DEFINER — projection failure rolls back the whole op.
- audit_events authoritative; activity_events redacted + rebuildable by source event_id; feed renders company events ONLY (account/Logger events excluded); proposed_vs_executed = executed for all four.
- activity:read = owner|viewer company member; keyset pagination (occurred_at DESC, event_id DESC; opaque versioned cursor; default 25/max 100); honest as_of; API-only GET /api/companies/[companyId]/activity; no rendered page, no SSE (P6-008).

## ACBP-P1-011 company switching and portfolio (CDR-017) — owner-accepted 2026-07-23
- Membership-filtered portfolio ONLY (active company_memberships; NO account-owner registry visibility) — API-CONTRACTS Member-read + CDR-015 no-auto-grant — companies account RLS is isolation, not authorization; SQL starts from the memberships self-branch.
- Name enrichment via bounded SEQUENTIAL fresh CompanyScope reads; NO account-scoped company_profiles policy; no parallel reads that could mix SET LOCAL company context.
- Selection URL-only/stateless/non-authoritative; nothing persisted (no DB/Clerk/cookie/session); switching = navigate + fresh runInCompanyScope; no company:switch action, no switch endpoint, not a durable audit event.
- API-only GET /api/companies; portfolio:read (account owner|viewer); keyset created_at DESC/id DESC; default 25/max 100 with invalid limits REJECTED (not clamped); cursor versioned base64url bound to account+ACTOR; DTO {companyId,name,status,role,createdAt}; no filters/metrics.
- No RLS/persistence migration; index-only migration ONLY on EXPLAIN-proven need; no 4th SECURITY DEFINER.
