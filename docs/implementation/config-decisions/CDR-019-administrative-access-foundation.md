# CDR-019 — Administrative-access foundation (ACBP-P1-013)

Status: **Accepted** (owner decision 2026-07-23). Governs ACBP-P1-013.
Sources: backlog ACBP-P1-013 (NFR-002; ADR-007/ADR-015; deps P1-007/P1-008; "Admin surface skeleton: reason
capture + audit + no silent impersonation"; "Admin action without reason impossible; audit trail complete";
"Deny by default"; "JIT scope; break-glass design documented"; "Admin cross-tenant reads audited"; "runbook
stub"); SECURITY-ARCHITECTURE §3 (JIT/time-boxed access; verbatim reason; 100% audit-graded; tenant
visibility; no silent impersonation; break-glass properties); DATA-ARCHITECTURE §2.5 ("no RLS bypass except
break-glass role with alarmed usage"); COMPONENT-CATALOG "Administrative controls [M] … MVP (minimal) …
Highest scrutiny"; AUDIT.md/CDR-014 (the reserved `admin` actor type; the deferred audit read/export API);
TENANCY.md (owner role = "migrations + explicit admin setup ONLY").

## Owner decisions (2026-07-23)

1. **Separate platform-operator authority.** Admin identity is an internal **`platform_admins` allowlist keyed
   to `users.id`**. Tenant roles NEVER grant admin authority; account ownership, company membership, and any
   Clerk claim/metadata are non-authoritative for admin standing.
2. **Owner-managed only.** Admin rows are created/revoked exclusively through explicit owner-connection
   operational setup (the canonical "explicit admin setup" use of the migration/owner role, per runbook). **No
   runtime API may create, update, revoke, enumerate, or delete admins.** No default admin; no
   environment-derived admin.
3. **Self-check-only runtime visibility.** `acbp_app` may SELECT only the CURRENT ACTOR'S OWN `platform_admins`
   row (RLS self-check policy); no enumeration is possible at the restricted role. Admin standing is checked
   **freshly on every request**.
4. **Mandatory bounded verbatim reason.** Every admin action requires a reason: retained EXACTLY as supplied
   (no trimming/normalization before storage), ≥1 non-whitespace character, ≤512 Unicode code points, NUL
   forbidden. Validated BEFORE any database read. "Admin action without reason impossible."
5. **Cross-tenant reads stay on `acbp_app`.** The admin path establishes **transaction-local target GUCs**
   (`app.current_account` + `app.current_company` via SET LOCAL) ONLY after (a) identity resolution, (b) strict
   reason validation, (c) fresh active-admin verification. Target `accountId` AND `companyId` are both
   client-supplied SELECTORS only; their relationship is verified in-database
   (`companies.account_id = accountId AND companies.id = companyId`). **No BYPASSRLS, no owner runtime
   connection, no third runtime role, no fourth SECURITY DEFINER.** JIT = per-request/per-transaction scope
   only — nothing survives commit/rollback; no capability is cached.
6. **No generic arbitrary-tenant primitive.** The target-scope mechanism is PRIVATE to the admin module — no
   exported `runAsTenant`/`setArbitraryTenant`/cross-tenant repository/owner-connection helper of any kind.
7. **Admin action records = `audit_events`.** No separate records table. Register EXACTLY ONE event:
   **`admin.tenant_read`** — target-tenant-scoped (account + company of the TARGET), `actor_type='admin'`,
   `actor_id` = the real administrator's internal user id, subject = the target company, metadata allowlist
   exactly `{reason, scope}` with `scope='company_overview'`. The event is written in the SAME transaction as
   the read; **audit-write failure blocks response delivery** (rollback; no company data returned). Admin
   events are **audit-only**; the P1-009 four-event activity taxonomy is unchanged. The target-tenant stamping
   is the structural §3 "tenant visibility" mechanism (a future tenant audit export includes the access).
8. **One minimal operation; API-only.** `POST /api/admin/accounts/[accountId]/companies/[companyId]/read`,
   body exactly `{ reason }` (unknown properties rejected; every query parameter rejected). Response exposes
   ONLY `{companyId, status, creationMode, createdAt}` — never accountId, actor ids, admin-standing details,
   profile/member data, audit/activity data, or internal errors. One coarse 403 for every denial cause
   (non-admin, revoked, invalid/mismatched target — no existence oracle); 400 for malformed input; bounded 500
   for internal/audit failure.
9. **No impersonation, structurally.** The admin actor id is never replaced by a tenant user id; no session/
   token is minted; no request executes as a tenant member; no membership row is created; no customer approval
   can be synthesized; ordinary company APIs are never invoked with an impersonated identity; boundary tests
   forbid impersonation-shaped identifiers in the admin path.
10. **Documentation-only items.** Break-glass (dual control; explicit incident/change reference; time-limited
    credential; alarms on use; mandatory post-use review; automatic expiry/revocation; separate from routine
    admin access; no silent impersonation; no customer-approval simulation) and the full JIT approval workflow
    are DESIGN-DOCUMENTED, not built. Operational runbook stub required for admin row setup/revocation.

## Explicitly rejected

Tenant owner/viewer as platform admin; Clerk role claims as admin authority; environment-only admin authority;
silent impersonation; user-session cloning; persistent tenant elevation; generic cross-tenant repositories;
account/company enumeration; owner `DATABASE_URL` at runtime; BYPASSRLS; broad admin DB policies; audit
export; admin mutations of tenant data; admin list/search endpoints; UI/SSE; break-glass implementation.

## Out of scope (deferred)

Audit read/export API contract (AUDIT.md §deferred); JIT grant/approval workflow; break-glass build; admin
mutations; impersonation tooling of any kind; retention/purge worker; customer-side Administrator/Billing
roles (PRD §13 Post-MVP/Future); M7 security review; P1-014+.
