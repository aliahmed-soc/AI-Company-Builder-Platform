# CDR-011 — Membership, Roles, and Invitation Model

1. **ID:** CDR-011
2. **Title:** Account-level owner/viewer membership, email-bound single-use invites, and a structural company-scope hook
3. **Status:** Accepted
4. **Date:** 2026-07-21
5. **Owner:** Product owner (owner-selected Option A at the membership↔company seam)
6. **Source ticket:** ACBP-P1-004
7. **Context:** ADR-022 makes Clerk identity-only and the platform authoritative for membership; ADR-007
   makes internal membership the tenant authority; ADMIN-003 requires a server-side role matrix (MVP
   owner+viewer) with company-scoped invites. DATA-ARCHITECTURE models **Membership** (A-tenant) as
   `(user_id, account_id, company scope) + role`, lifecycle `invited→active→revoked`; API-CONTRACTS
   Memberships = invite (company-scoped)/accept/revoke/list, owner-gated, single-use invite tokens.
   **The `companies` table does not exist yet — Company lifecycle is ACBP-P1-010** (which depends on
   P1-005 tenant-context + P1-008 audit), so the dependency graph forces membership BEFORE companies.
   No email/notification delivery infrastructure exists (notifications are Post-MVP). This CDR records
   the owner's resolution of the resulting membership + invitation semantics.
8. **Decisions:**
   1. **Account-level membership foundation.** `memberships` is A-tenant (account-owned). A row links a
      user to an account with a role and lifecycle status. A user may own their own personal account
      (CDR-010 `accounts.created_by_user_id`) AND be a member of another account via a membership row.
   2. **Roles = `owner | viewer` (MVP).** Owner manages members (invite/revoke/list/manage); viewer is
      read-only (list/view members). Roles are **internal-only and server-authoritative** — a Clerk org
      id, role string, active-organization value, or any browser-supplied claim NEVER authorizes
      (ADR-022 / SECURITY-ARCHITECTURE §1). Deny by default. Role changes are audited.
   3. **Owner backfill.** A migration inserts, for each existing account, a `role='owner'`,
      `status='active'` membership for `accounts.created_by_user_id` (company scope null = account-wide).
      Idempotent; `accounts.created_by_user_id` remains immutable provenance (CDR-010 #3) and is NOT itself
      the authorization source — the membership row is.
   4. **Email-bound, single-use invites.** An owner invites an **email** + role. The platform generates a
      single-use invite token, stores only its **hash** (never the raw token), and — because no email
      delivery infrastructure exists in P1-004 — returns the raw token to the owner ONCE to convey
      out-of-band. Acceptance requires the accepting user to be a **server-verified Clerk identity whose
      VERIFIED primary email matches the invited email**; a leaked/forwarded token therefore cannot let an
      unintended person join. On accept: `status='active'`, `member_user_id` bound, token consumed.
   5. **Revocation is immediate.** An owner revoke sets `status='revoked'` and invalidates any outstanding
      token at once; a revoked membership grants nothing thereafter.
   6. **Company-scope is a structural hook only in P1-004.** `memberships.company_id` exists as a
      **nullable** column with **no foreign key yet** (there is no `companies` table). In P1-004 it is
      always `NULL` (account-wide). The **companies FK, populated company-scoped invites, and the
      "invite grants only selected company" enforcement land in ACBP-P1-010** (companies) — P1-004 builds
      and tests the role-matrix enforcement + the forward-compatible column, but never stores an
      unvalidated company reference. Rationale: the dependency graph forces membership before companies,
      and building unvalidated company-scoping against a non-existent table is unsafe/meaningless.
   7. **Role enforcement is scoped to the membership operations.** P1-004 enforces owner/viewer on the
      membership use-cases (owner-only invite/revoke; viewer read-only) — a self-contained matrix with
      negative tests. It does **not** introduce the general `authz.check` middleware (that is ACBP-P1-007)
      and does **not** retrofit role checks onto the P1-003 profile route (which operates on the caller's
      OWN personal account and is unaffected by memberships to OTHER accounts).
   8. **Interim audit via structured events.** `membership.invited` / `membership.accepted` /
      `membership.revoked` / `membership.role_changed` are emitted as structured, correlated, redacted
      observability events carrying only non-PII fields (account id, membership id, role) — **never the
      invited email or token**. The durable append-only audit store is ACBP-P1-008.
   9. **Idempotency + race-safety.** Invite/accept/revoke use scoped conflict handling on the exact
      constraints (never a blanket 23505 catch). At most one active membership per (account, user) at the
      account level; one pending invite per (account, invited_email) at a time.
9. **Scope:** `memberships` persistence (+ owner backfill), the role model, invite/accept/revoke/list
   use-cases with server-side role-matrix enforcement, the members web API, and interim audit events for
   ACBP-P1-004. **Excludes** companies + company-scoped behavior (P1-010), tenant-context primitives
   (P1-005), row-level security (P1-006), the general `authz.check` middleware (P1-007), the durable audit
   store (P1-008), email/notification delivery (Post-MVP), billing, and account/membership deletion.
10. **Alternatives:** (B) token-only invites (no invited-email binding) — rejected by owner: a
    leaked/forwarded token would let an unintended person join. (C) omit the `company_id` column now and
    ALTER `memberships` in P1-010 — rejected by owner: adding a nullable column now and only attaching the
    FK later is cheaper than a later table-altering migration. (D) build full company-scoped invites now
    with unvalidated company ids — rejected: stores meaningless tenant references against a non-existent
    table.
11. **Security impact:** authorization derives solely from the internal membership row (never Clerk
    claims); invite acceptance is email-bound to a verified identity; tokens are stored hashed and are
    single-use; audit events carry no PII/token; deny-by-default on role-gated operations.
12. **Reliability impact:** immediate revocation; idempotent, race-safe invite/accept; owner backfill is
    idempotent and reversible.
13. **Reversal cost:** Low–Medium — reversible migration; the nullable `company_id` hook is designed for
    P1-010 to attach a FK + populate, not to be replaced.
14. **Requirement IDs:** ADMIN-003 (roles + membership; server-side role matrix; company-scoped invites,
    MVP owner+viewer).
15. **Governing ADRs / CDRs:** ADR-022, ADR-007, ADR-006, CDR-010 (bootstrap owner it builds on).
16. **Implementation slices:** (1) this CDR + agent state; (2) `memberships` migration + schema + repository
    + owner backfill + real-PG integration; (3) core role model + invite/accept/revoke/list use-cases +
    role-matrix enforcement + interim audit + unit tests; (4) web members API routes + role-negative tests;
    (5) backlog sync (owner-gated).
17. **Review trigger:** ACBP-P1-010 (companies) attaches the `company_id` FK + company-scoped invites;
    ACBP-P1-007 generalizes role enforcement into `authz.check`; Post-MVP notification delivery for invites.
