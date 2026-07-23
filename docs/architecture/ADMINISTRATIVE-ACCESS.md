# Administrative Access (ACBP-P1-013; CDR-019)

The platform-operator admin surface: who is an admin, how the ONE admin operation executes, and the
structural guarantees that keep it from becoming a tenant-isolation bypass. Delivered by ACBP-P1-013;
decisions recorded in CDR-019.

## 1. Admin identity — a separate authority

- Admin standing lives ONLY in the `platform_admins` table (keyed to `users.id`; status
  `active | revoked` with shape CHECKs; migration 0011).
- Rows are managed EXCLUSIVELY through owner-connection operational setup per
  `docs/operations/admin-access-runbook.md`. No runtime API can create, update, revoke, enumerate, or
  delete admins — none exists, by design.
- Tenant roles (account owner/viewer, company owner/viewer), account ownership, and Clerk claims NEVER
  grant admin. The `admin:tenant_read` authz action is registered with an EMPTY membership allow-list:
  the ordinary role matrix can never satisfy it.
- Runtime visibility is self-check-only: under FORCE RLS, `acbp_app` can SELECT exactly the current
  actor's own row (`user_id = app.current_actor`), with SELECT the only granted privilege. No
  enumeration, no mutation, fail-closed without an actor GUC.
- Standing is verified FRESHLY inside every admin transaction — never cached, never session-carried.
  Revocation is effective on the next request.

## 2. The one operation

`POST /api/admin/accounts/[accountId]/companies/[companyId]/read` → `{companyId, status, creationMode,
createdAt}` — a reason-captured, audited read of one company's registry overview. Nothing else: no admin
list/search, no mutation, no impersonation, no audit export, no UI/SSE (CDR-019 decision 19).

Request protocol (order is load-bearing):

1. Every query parameter rejected; body must be EXACTLY `{ reason }` (unknown properties rejected).
2. The reason validated BEFORE any identity/database work: verbatim retention, ≥1 non-whitespace
   character, ≤512 Unicode code points, NUL forbidden, no trimming/normalization before storage.
3. Server-verified session identity → internal user mapping (browser input never trusted).
4. Selector shape gate: non-UUID-shaped ids → the same coarse denial, without touching the database.
5. The purpose-specific database primitive (`executeAdminCompanyRead`, @acbp/database) runs the whole
   protocol in ONE restricted-role transaction:
   a. `app.current_actor` ← the admin's internal user id (transaction-local);
   b. fresh `platform_admins` self-check (active row required — the admin gate);
   c. only then: target `app.current_account` + `app.current_company` (transaction-local; JIT =
      per-transaction scope, CDR-019 decision 20);
   d. the ONE approved read, relationship-verified in-database
      (`companies.id = companyId AND companies.account_id = accountId`);
   e. `admin.tenant_read` audit written into the TARGET tenant's trail (actor_type `admin`, the REAL
      admin actor id, metadata exactly `{reason, scope='company_overview'}`);
   f. commit — data is returned ONLY after the audit committed. An audit failure rolls everything back
      and the caller gets a bounded 500 with no company data.
6. EVERY denial cause — non-admin, revoked admin, unmapped/deleted caller, unknown account, unknown
   company, mismatched pair, malformed selector — is ONE opaque 403 (no existence/standing oracle).

## 3. Structural guarantees

- **Restricted role throughout.** The admin path runs on `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner)
  with FORCE RLS fully active; cross-tenant visibility comes only from the transaction-local target GUCs
  set AFTER the admin gate. No BYPASSRLS, no owner runtime connection, no third runtime role, no fourth
  SECURITY DEFINER function (the allowlist stays exactly three).
- **No generic cross-tenant primitive.** `executeAdminCompanyRead` performs exactly one operation and
  escapes no query/callback/repository handle. No `runAsTenant`/`setArbitraryTenant`/cross-tenant
  repository/owner-connection helper exists or may be added (pinned by boundary tests). Admin standing
  is never reified as a passable value — the capability is the verified position inside the one
  transaction, which dies at commit/rollback (nothing exists to cache, serialize, or forge).
- **No impersonation.** The audit actor is the ADMIN's own id with `actor_type='admin'`; no tenant
  session/token is minted; no membership row is created; no customer approval is synthesized; ordinary
  company use cases are never invoked from the admin path. Enforced by always-run source/boundary tests
  (`packages/core/src/admin/admin-boundary.test.ts`) forbidding impersonation-shaped identifiers and
  membership writes in the admin path.
- **Audit-only.** `admin.tenant_read` is never projected into `activity_events`; the company activity
  taxonomy remains the four lifecycle events (CDR-016/CDR-019).
- **Reason privacy.** The verbatim reason exists ONLY in the audit row's bounded metadata. It never
  appears in responses, error envelopes, or logs (leak-canary tests at the web and core layers).

## 4. Deferred (documented, not built)

Break-glass access and the full JIT approval workflow — see
`docs/architecture/BREAK-GLASS-DESIGN.md`. Implementing either is an owner gate.
