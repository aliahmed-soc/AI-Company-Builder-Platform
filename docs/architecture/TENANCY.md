# Tenancy primitives (ACBP-P1-005; ADR-007; CDR-012)

Status: implemented for the **account** granularity (ACBP-P1-005). Company granularity and RLS are later
tickets. This is the "tenancy README" for the ticket.

## Two type-distinct granularities

ADR-007 mandates two independent isolation layers and makes **internal membership the tenant authority**.
DATA-ARCHITECTURE §1 distinguishes **account-owned (A)** rows (keyed by `account_id`) from **company-owned
(C)** rows (keyed by `company_id`). CDR-012 (owner-accepted, Option B) keeps the two granularities
**type-distinct** so an account-only scope can never reach company-owned data.

| | Account-level (ACBP-P1-005) | Company-level (ACBP-P0-018; implemented in ACBP-P1-010) |
|---|---|---|
| Context | `AccountContext { accountId, actorId? }` — **no companyId** | `TenantContext { accountId, companyId, actorId? }` |
| Branded scope | `AccountScope` (brand distinct from `TenantScope`) | `TenantScope` |
| Mint path | `withAccountTransaction` (only path) | `withTenantTransaction` (only path) |
| Repository base | `AccountScopedRepository` | `TenantRepository` |
| Session GUCs (`SET LOCAL`) | `app.current_account`, `app.current_actor` — **never `app.current_company`** | `app.current_account`, `app.current_company`, `app.current_actor` |

The two scopes are mutually unassignable (distinct `unique symbol` brands); **no alias collapses them**
(proven in `packages/database/src/account-repository.type-test.ts`). A company repository can never be
constructed from an account-only scope, and neither scope can be forged outside `@acbp/database` (the mint
functions are the only source; `createAccountScope`/`createTenantScope` are not exported).

## Resolution (from active membership)

`@acbp/core` `resolveAccountContext(client, { userId, requestedAccountId })`:

- `userId` is the **server-verified** internal user id (P1-001/P1-002 boundary) — never a browser/Clerk claim.
- `requestedAccountId` is a **request only**. Authority is the caller's **ACTIVE** membership row (CDR-011),
  looked up server-side. A blank account or user denies **without** a lookup (no existence signal).
- Deny-by-default. `invited`, `revoked`, missing, inactive, and cross-account all collapse to one coarse
  reason (`membership_not_active`) — no existence/state oracle. Blank input → `account_not_specified`.
- No Clerk org/role claim is consulted. Revocation takes effect on the **next** resolution (`status='active'`
  filter). Multiple memberships are deterministic — resolution is keyed to the explicit requested account.

`runInAccountScope(client, params, fn)` is the trusted composition: it resolves, and **only if** that
succeeds mints the `AccountScope` via `withAccountTransaction` and runs `fn` under it. On denial `fn` never
runs and no scope is minted (fail-closed).

## Audit

Denials emit an interim structured `tenant.context_denied` event with **non-PII** fields only (account id,
actor id, coarse reason) — never an email, token, or raw Clerk identifier. The durable append-only audit
store is ACBP-P1-008.

# Row-level security — the second isolation layer (ACBP-P1-006; CDR-013)

P1-006 adds the **database-enforced** half of ADR-007's two-layer model: even if the application layer forgot
to filter by account, RLS blocks a cross-tenant query. Proven with the restricted role and app filters removed
(`packages/database/src/integration/rls*.integration.test.ts`, `rls-adversarial.integration.test.ts`).

## Database role model (two connections)

| | Migration/owner role | Restricted application role `acbp_app` |
|---|---|---|
| Connection var | `DATABASE_URL` (owner) | `DATABASE_APP_URL` (app) |
| Loader | `loadDatabaseConfig()` / `parseDatabaseConfig(env,{role:'owner'})` | `loadAppDatabaseConfig()` / `{role:'app'}` |
| Used by | migrations + explicit admin setup ONLY | ALL normal runtime traffic (web composition) |
| Attributes | owns tables + functions; **BYPASSRLS in production** (superuser in CI) so its SECURITY DEFINER functions can perform their atomic bootstrap | `NOLOGIN`(created by migration)→login granted out-of-band; `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`; non-owner; not a member of the owner role |

The app-role selection is **fail-closed**: an `app` config missing `DATABASE_APP_URL` throws (no fallback to the
owner URL), so a misconfigured production runtime cannot silently connect as the owner. Both URLs are
`Secret`-wrapped and redacted from logs/errors. The migration grants `BYPASSRLS` to **no** role.

## FORCE RLS + policy matrix

`accounts`, `account_profiles`, `memberships` all have `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. Policies
compare on **text** (`id::text = nullif(current_setting('app.current_account', true), '')`) so missing / empty /
malformed context yields no rows / a failed `WITH CHECK`, with no uuid-cast exception (fail-closed).

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `accounts` | `id = current_account` | — (bootstrap only) | `id = current_account` (USING+CHECK; id/ownership immutable) | — (unsupported) |
| `account_profiles` | `account_id = current_account` | — (bootstrap only) | `account_id = current_account` (USING+CHECK; no account move) | — (unsupported) |
| `memberships` | `account_id = current_account` **OR** `member_user_id = current_actor` (self) | `account_id = current_account` | `account_id = current_account` (USING+CHECK; no account move) | — (unsupported) |

`acbp_app` is granted only `SELECT,UPDATE` on the account/profile tables and `SELECT,INSERT,UPDATE` on
memberships (plus CRUD on the global `users`/`identity_webhook_receipts`, which carry no RLS). No `DELETE`
grant on any protected table.

## The three-function bootstrap allowlist (the only pre-context exceptions)

Some operations must run **before** an `AccountScope` can exist. Exactly three narrow `SECURITY DEFINER`
functions (owner-owned, fixed `search_path=pg_catalog`, fully schema-qualified, no dynamic SQL, `EXECUTE`
revoked from PUBLIC + granted only to `acbp_app`, minimal return) cross the RLS boundary — **no fourth may be
added without another owner decision**:

1. `acbp_provision_account(user_id)` — first-sign-in personal account + profile + owner membership (idempotent;
   owner/role fixed; cannot claim another user's account).
2. `acbp_resolve_own_membership(user_id, account_id)` — returns only the caller's own active membership role in
   the explicitly requested account (never enumerates members; honours immediate revocation).
3. `acbp_accept_invite(invite_token_hash, user_id)` — one atomic `invited→active` transition, binding the email
   from **platform-authoritative** `users.primary_email` (active + verified) — never a caller parameter;
   at-most-one activation under concurrency; no token/email in the result.

## Normal request flow

Server-verified internal user → active-membership `AccountContext` resolution (via `acbp_resolve_own_membership`)
→ `runInAccountScope`/`withAccountTransaction` sets `app.current_account` + `app.current_actor` with `SET LOCAL`
(never `app.current_company`) → account-owned repositories run under the restricted role, RLS-confined. A
requested account id is never authority on its own; no header/cookie/body/Clerk claim is tenant authority.

## Local development / testing

Integration suites seed via a superuser/owner connection and run the actual application operations via an
`acbp_app` connection (see `packages/core/src/tenancy/rls-integration-support.ts`), so RLS is exercised
end-to-end. The test login is a synthetic throwaway; no real credentials appear anywhere. Local Windows→WSL
Postgres forwarding is unreliable, so hosted CI (with a zero-skip preflight) is the authoritative gate.

## Still deferred (later tickets)

- **P1-007** generalizes authorization into `authz.check`.
- **P1-008** adds the durable append-only audit store — **implemented** for the account-scoped first cut
  (`membership.invited`/`membership.revoked`, written in-transaction; see `docs/architecture/AUDIT.md`). The
  interim `tenant.context_denied` event remains a structured log (denial persistence is deliberately deferred).
- **P1-010** — **implemented** (CDR-015): real company resolution + the company-level `TenantContext`/`CompanyScope`
  and dual-keyed company RLS are now live. `app.current_company` IS set (transaction-locally, `SET LOCAL`) by the
  trusted `elevateToCompanyScope` elevation inside an already-validated `AccountScope` — company creation runs
  under the existing restricted AccountScope with an account-keyed `companies` INSERT policy and **no 4th SECURITY
  DEFINER function** (the closed allowlist stays exactly three). Company-owned reads/mutations require BOTH
  `app.current_account` and `app.current_company` to match (fail-closed); `companies` INSERT is account-keyed and
  `companies` SELECT is account-scoped (a company is resolved into, not listed — the account-scoped SELECT is a
  tenant-isolation boundary, not a list feature).
- **P1-011** — **implemented** (CDR-017): the **membership-filtered** company portfolio (`GET /api/companies`) and
  **stateless** switching. The portfolio enumerates ONLY companies where the actor has an active
  `company_membership` (account ownership grants no row), starting from the memberships self-branch under
  `AccountScope` (company GUC unset) and enriching names via fresh, sequential per-candidate `CompanyScope` reads.
  Selection is URL-only and non-authoritative — nothing persisted (no column/cookie/Clerk/session/global state);
  switching = a fresh `runInCompanyScope`. No 4th SECURITY DEFINER, no RLS/persistence/index migration. See
  `docs/architecture/PORTFOLIO.md`.
- **P1-012** — **implemented** (CDR-018): internal-Postgres-only **workspace provisioning**. Two new dual-keyed
  FORCE-RLS company-detail tables (`provisioning_steps` with column-level UPDATE limited to outcome columns;
  append-only `company_workspace_areas`). Request-driven SEQUENTIAL execution — every step a fresh
  `runInCompanyScope` transaction on `acbp_app`; no worker/queue/lease/outbox/owner connection; durable statuses
  pending|completed|failed only (no committed `running`); the system `draft→onboarding→active` transitions are
  now reachable (creation bootstrap + all-six-completed activation gate). No 4th SECURITY DEFINER (allowlist
  stays exactly three). See `docs/architecture/PROVISIONING.md`.
  `company_memberships` is a SEPARATE table (the account `memberships` foundation is untouched); a company
  membership requires an active account membership and account ownership never auto-grants company access.
  `companyId` on `TenantContext` remains required (not made optional).
- **P1-013** — **implemented** (CDR-019): the **platform-admin** company-overview read — the ONE sanctioned
  cross-tenant read. It does NOT weaken the tenancy model: it runs on the restricted `acbp_app` role with
  FORCE RLS fully active, gaining target-tenant visibility ONLY from transaction-local target GUCs
  (`app.current_account`/`app.current_company`) set inside one transaction strictly AFTER a fresh
  `platform_admins` self-check ("JIT" = per-transaction scope; nothing survives commit/rollback). The new
  `platform_admins` table is itself FORCE-RLS with a self-check-only SELECT policy (no enumeration; grants =
  SELECT only). No BYPASSRLS, no owner runtime connection, no third runtime role, no 4th SECURITY DEFINER
  (allowlist stays exactly three), and no generic cross-tenant scope primitive is exported. Tenant roles
  never grant admin; the admin actor is audited as itself (`actor_type='admin'`, no impersonation). See
  `docs/architecture/ADMINISTRATIVE-ACCESS.md`.
