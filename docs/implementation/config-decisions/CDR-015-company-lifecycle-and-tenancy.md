# CDR-015 — Company lifecycle, company tenancy, and the P1-009 sequencing correction (ACBP-P1-010)

Status: **Accepted** (owner decision 2026-07-22). Governs ACBP-P1-010.
Sources: backlog ACBP-P1-010 (COMP-001/004/005/006/008; ADR-006/007; WORKFLOW-STATE-MACHINES §1); DATA-ARCHITECTURE
(Company C-root, Company profile versioned, Membership); TENANCY.md (reserved company primitive; company RLS fails
closed until P1-010); AUTHORIZATION.md (owner/viewer); EVENT-CATALOG (company.* events); CDR-011 (membership +
`memberships.company_id` hook); CDR-012 (account-context primitive; TenantContext/TenantScope reserved, `companyId`
required); CDR-013 (RLS + the closed 3-function SECURITY DEFINER allowlist); CDR-014 (audit account-scoped first cut;
`company_id` expand deferred to P1-010).

## Owner decisions (2026-07-22)

1. **Account↔company cardinality — MANY per account.** An account may contain **zero or many** companies; every
   company belongs to **exactly one** account (`account_id`, immutable). No default/personal company is invented.
   The "3 creation modes" (own idea / platform-suggested / existing business, COMP-001) describe onboarding INPUT,
   not company cardinality. Portfolio/switching/list is ACBP-P1-011 (out of P1-010).
2. **Company membership — a SEPARATE `company_memberships` table.** Account memberships stay in `memberships`
   (UNCHANGED). Company memberships live ONLY in `company_memberships`. No account-membership uniqueness/index/RLS
   semantics are reused. A company membership REQUIRES an active account membership. **Account ownership does NOT
   automatically grant access to any company** — the creator receives an EXPLICIT active company `owner` membership
   row. Company roles are `owner|viewer` (reused from CDR-011). No company invitation flow is added (not required by
   P1-010 canon; company-scoped invites are a later concern). Rationale: keeps the P1-004/005/006 account foundation
   — the `memberships_active_user_unique (account_id, member_user_id) WHERE active` index, the account-context
   resolver, account listing/invite/revoke, and account memberships RLS — completely untouched and un-risked.
3. **Company creation — under the existing restricted AccountScope; NO 4th SECURITY DEFINER function.** The closed
   allowlist stays exactly three (`acbp_provision_account`, `acbp_resolve_own_membership`, `acbp_accept_invite`,
   CDR-013). Company creation runs inside the caller's already-validated AccountScope (the caller is an active
   account owner; `app.current_account` is set), and the `companies` INSERT is authorized by an ACCOUNT-keyed RLS
   policy (`account_id = current_account` WITH CHECK) — exactly like `memberships` INSERT today. See §Bootstrap.
4. **Deactivation deferred.** P1-010 implements create / rename+profile-update / status / pause / resume only.
   `deactivating → deactivated` (and `company.deactivated`) and delete (COMP-007, Post-MVP) are OUT of P1-010.
5. **Durable company events — EXACTLY four**, registered in `@acbp/contracts` and written in-transaction via
   `writeAuditEvent`: `company.created` `{company_id, creation_mode}`, `company.updated` `{changed_fields}`
   (names-only), `company.paused` `{reason?}`, `company.resumed` `{reason?, held_work_count?}`. NOT registered:
   `company.deactivated`, `company.deleted`, activity-feed events, outbox events, provisioning-completion.
6. **audit_events `company_id` expand.** An additive migration adds a **nullable** `company_id`. Account-scoped
   events (`membership.invited`/`revoked`) keep it NULL; company events set it server-side from CompanyScope. The
   append-only immutability (grant-based INSERT+SELECT only, no UPDATE/DELETE; CDR-014) is preserved by the additive
   column. See §Audit dual-scope.
7. **P1-009 sequencing correction.** ACBP-P1-009 (company-scoped activity feed) is a functional dependent of
   ACBP-P1-010 (which supplies companies, `company_id`, `app.current_company`, company authz, and the durable
   `company.*` events). ACBP-P1-009's `Dependencies` is corrected to **ACBP-P1-008;ACBP-P1-010** and it stays
   **Planned** with its company-scoped acceptance UNCHANGED (owner-approved Option A: P1-010 precedes P1-009).

## Required security model (invariants)

### Cardinality
- An account may contain 0..N companies; a company belongs to exactly one account; `company_id`/`account_id`
  immutable (set at insert, no update path — ADR-007 invariant 1). No default company.

### Membership
- Account memberships in `memberships`; company memberships ONLY in `company_memberships`. No reuse of the account
  uniqueness/index/RLS. A company membership requires an ACTIVE account membership. Account ownership never
  auto-grants company access. The creator gets an explicit active company `owner` row. Roles `owner|viewer`.

### Context
- `CompanyContext` carries authoritative `{ accountId, companyId, actorId }` (all internal, server-resolved).
- `AccountScope` and `CompanyScope` remain BRANDED and TYPE-DISTINCT (CDR-012 #8). A requested `companyId` is a
  SELECTOR, never authority. Clerk org/role claims, request headers/cookies/body roles are NEVER authority.
  Company membership + role are loaded FRESH from the database on every request (no caching).

### RLS
- `app.current_account` remains required; `app.current_company` is added (set transaction-locally via the trusted
  context layer) for company-scoped operations. Company-owned access requires BOTH account AND company consistency.
  No company policy relies only on a caller-set `companyId`. `acbp_app` stays NOSUPERUSER/NOBYPASSRLS/non-owner; the
  owner/migration connection is never exposed to normal requests; exactly three SECURITY DEFINER functions remain.

## Bootstrap — company creation without a 4th SECURITY DEFINER function (trust-critical)
One restricted `acbp_app` transaction under the caller's AccountScope: (1) resolve verified internal user; (2)
resolve active AccountContext; (3) authorize `company:create` from the fresh account membership role (owner-only);
(4) begin the AccountScope transaction; (5) INSERT `companies` with `account_id = current_account`, server-generated
`company_id`, server-selected creation_mode/status, no caller authority fields (RLS WITH CHECK binds account_id); (6)
mint a trusted `CompanyScope` INSIDE the SAME transaction from the AUTHORITATIVE inserted company row; (7) set
`app.current_company` transaction-locally via the trusted context layer; (8) INSERT the creator's active company
`owner` membership; (9) INSERT the initial profile/version; (10) write `company.created` audit in the same
transaction; (11) commit-all-or-rollback-all. The AccountScope→CompanyScope elevation accepts ONLY a company id
returned by an authoritative insert (or a company row verified to belong to the current AccountScope) — it is NOT a
general public scope-minting function. No second transaction, no second pooled connection, no request-supplied
account/actor/ownership, no permissive `company_memberships` INSERT policy, no RLS disable, no owner connection.

## Audit dual-scope
- Account event: `company_id IS NULL` and `account_id = current_account`.
- Company event: `company_id IS NOT NULL` and BOTH account and company contexts match.
- No policy lets any account member read/insert all company events merely by matching `account_id`.

## Profile versioning
- COMP-004 requires "version history; edits create audit events" and "concurrent edits resolve last-write-wins with
  visible history"; DATA-ARCHITECTURE marks Company profile mutability **V** ("new version per change"). P1-010 uses
  an **immutable revision** model: profile updates INSERT a new version row atomically; a deterministic
  current-version lookup returns the latest; revisions cannot cross companies/accounts. `company.updated` audits the
  change (changed-field names only).

## Out of scope (deferred)
Deactivate/delete (COMP-007 Post-MVP); portfolio/list/switching (P1-011); provisioning execution (P1-012); activity
feed + outbox/projector (P1-009+); company-scoped invitation flow; any scheduler/queue/lease/worker beyond the
minimal invariant-16 pause-pickup test rig.

## Rejected alternatives
- **Extend the shared `memberships` table with company-scoped rows** — would force reworking the P1-004
  `memberships_active_user_unique` index and the account-context queries/RLS (a user active in N companies = N active
  rows per `(account,user)`, violating the existing unique index), modifying the account-authorization core.
  Rejected for blast radius; the separate table isolates company membership cleanly.
- **A 4th `acbp_provision_company` SECURITY DEFINER function** — rejected; company creation has an existing
  AccountScope, so an account-keyed policy suffices (CDR-013 forbids expanding the allowlist without this decision).
- **Including deactivate now** — rejected; outside the objective string and unbacked by a COMP requirement.
