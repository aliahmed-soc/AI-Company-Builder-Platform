# CDR-013 — Row-Level Security, Restricted Application Role, and the Bootstrap Allowlist

1. **ID:** CDR-013
2. **Title:** Full FORCE row-level security on account-owned tables, enforced against a restricted
   application role, with exactly three narrow SECURITY DEFINER bootstrap operations
3. **Status:** Accepted
4. **Date:** 2026-07-21
5. **Owner:** Product owner (owner-selected Option A + Option A1 for the invite-accept bootstrap)
6. **Source ticket:** ACBP-P1-006
7. **Context:** ADR-007 mandates two-layer tenant isolation (application scoping + database row-level
   enforcement); P0-018 built the RLS-ready per-connection GUCs (`app.current_account`,
   `app.current_actor`) applied with `SET LOCAL`; P1-005 (CDR-012) added the account-level `AccountScope`
   primitive + membership-backed resolver + `runInAccountScope`. The account-owned tables today are
   `accounts` (A-root; `id` is the account id), `account_profiles` (`account_id`), and `memberships`
   (`account_id`). `users` and `identity_webhook_receipts` are global identity-root/infrastructure
   (CDR-008 #1) and are NOT account-scoped. The merged P1-003/P1-004/P1-005 code queries account-owned
   tables on a single connection **with no account context** via bootstrap paths that run *before* context
   exists. This CDR records the owner's resolution of the RLS enforcement model.
8. **Decision (owner-accepted Option A + A1):**
   1. **FORCE RLS on all three account-owned tables.** `accounts`, `account_profiles`, `memberships` get
      `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, so policies apply even to the table owner (only a role
      with BYPASSRLS/superuser bypasses). Policies are keyed to the transaction-local `app.current_account`
      GUC (and `app.current_actor` for the membership self-branch), fail-closed.
   2. **Two distinct database roles.** A **migration/owner role** owns the schema, tables, and functions and
      runs migrations; it is never used for normal application traffic. A **restricted application role**
      (`acbp_app`) runs all normal application queries. The restricted role is `NOSUPERUSER`,
      `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOINHERIT`; it does **not** own the
      protected tables, is **not** a member of the owner role, and cannot `SET ROLE` into it. The migration
      creates `acbp_app` as `NOLOGIN` (no password in code); environments grant `LOGIN` + a secret password
      out-of-band (deployment) and tests do so via the superuser setup connection. Grants to `acbp_app`:
      `USAGE` on schema `public`; `SELECT, INSERT, UPDATE, DELETE` on the three account-owned tables and on
      the global `users`/`identity_webhook_receipts` tables (global tables carry no RLS); `EXECUTE` on the
      three bootstrap functions only. No `GRANT BYPASSRLS` to any role is issued by the migration.
   3. **Pre-context bootstrap is unavoidable** because three legitimate operations run before an
      `AccountScope` can exist: (a) first-sign-in **personal-account provisioning** (the account does not
      exist yet); (b) **own-active-membership resolution** (the read that *establishes* context); (c)
      **pending-invite acceptance** (the invitee is not yet an active member, so they cannot obtain
      `AccountScope` before activation). These are the **exact, closed allowlist** of bootstrap operations.
   4. **Exactly three SECURITY DEFINER bootstrap functions** (no more may be added without another explicit
      owner decision): `acbp_provision_account`, `acbp_resolve_own_membership`, `acbp_accept_invite`. Each
      is `SECURITY DEFINER`, **owned by the migration/owner role** (never the app role), has a **fixed safe
      `search_path`** (no caller-writable application schema), **schema-qualifies** every table/type/function
      reference, uses **no dynamic SQL**, `REVOKE`s `EXECUTE` from `PUBLIC`, and `GRANT`s `EXECUTE` **only**
      to the restricted app role. Each bypasses RLS **only for its one exact atomic transition** (via its
      owner's privilege — production's owner/migration role carries BYPASSRLS; CI's is the superuser
      setup role — the migration itself grants BYPASSRLS to no one) and returns the **minimum** fields.
   5. **`acbp_accept_invite(invite_token_hash, authenticated_internal_user_id)`** establishes the email
      binding from **platform-authoritative** data, never a caller-supplied email: it loads the internal
      user by the server-verified id, requires the user is `active` (not deleted/tombstoned) with a
      verified primary email, and compares that canonical email (project normalization) to
      `memberships.invited_email`. It performs one atomic conditional transition (locate exactly one
      `status='invited'`, `member_user_id IS NULL` row by token hash; require the email match; set
      `member_user_id`, transition to `active`, clear the token hash, stamp `accepted_at`). It never lists
      invites, enumerates members, exposes emails/token hashes, activates a revoked/consumed invite, moves
      an account, or elevates the invited role. Concurrent/repeat attempts yield at most one activation;
      later attempts fail closed. **A token-bearing RLS policy / session-GUC was rejected** (see #10).
   6. **Fail-closed policy expressions.** Policies compare on **text** (`id::text = nullif(current_setting(
      'app.current_account', true), '')`, `member_user_id::text = nullif(current_setting('app.current_actor',
      true), '')`) so missing/null/empty/malformed GUC values yield NULL → no row visible / WITH CHECK fails,
      with no uncontrolled uuid-cast exception. No permissive fallback policy. No company-level policy and no
      fabricated company context (companies are P1-010).
   7. **Application rewiring.** After context resolution, all account-owned work runs under a validated
      `AccountScope` via `withAccountTransaction`/`runInAccountScope` as the **restricted role**. Provisioning
      → `acbp_provision_account`; the P1-005 resolver's membership read → `acbp_resolve_own_membership`;
      P1-004 accept → `acbp_accept_invite`; invite/revoke/list and profile get/update run under `AccountScope`.
      The branded `AccountScope` remains the structural requirement; no global mutable context; no
      AsyncLocalStorage; no browser/header/cookie/Clerk claim is ever tenant authority; the resolver binds
      the server-verified internal `userId` to an active membership; revocation invalidates the next resolution.
9. **Scope:** RLS migration (enable+force+policies), the restricted role + grants, the three bootstrap
   functions, application rewiring to run account-owned work under the restricted role/`AccountScope`,
   config for a migration vs application connection, restricted-role real-PostgreSQL trust-critical tests,
   catalog inspection, and migration notes. **Excludes** company lifecycle + company-level RLS (P1-010),
   the general `authz.check` middleware (P1-007), the durable audit store (P1-008), and billing.
10. **Alternatives rejected:**
    - **Token-bearing RLS policy / session GUC for accept (A2)** — rejected by owner: it would place a
      secret capability into a GUC that RLS trusts and widen the policy surface. Accept uses a narrow
      SECURITY DEFINER function instead.
    - **Owner-role execution from normal application code** — rejected: normal app traffic must never use
      the owner/superuser/BYPASSRLS connection; only the three hard-scoped functions cross that boundary,
      via `EXECUTE` granted to the restricted role.
    - **ENABLE-only (no FORCE) / latent policies** — rejected: would leave RLS inert for a table-owner
      connection, not delivering "an app-layer bug alone cannot cross tenants" in production.
    - **A generic privileged membership lookup** — rejected: the resolution function returns only whether
      the supplied server-verified user has an active membership in the explicitly requested account.
11. **Security impact:** the restricted application role is subject to RLS on every account-owned query;
    an app-layer filter bug alone cannot cross tenants (RLS blocks it, proven with the restricted role and
    app filters removed); the only RLS crossings are three hard-scoped, server-verified, atomic bootstrap
    functions with `EXECUTE` limited to the restricted role and `search_path`/schema-qualification locked;
    accept binds email from platform-authoritative `users`, never a caller parameter; no token/email/PII in
    logs or public errors; deny-by-default with fail-closed GUC handling.
12. **Reliability impact:** `SET LOCAL` GUCs are transaction-local (no pooled-connection leakage); a pooled
    connection reused after an account-scoped transaction starts with no inherited context; concurrent
    account transactions stay isolated; provisioning/accept remain idempotent + single-activation.
13. **Reversal cost:** Medium — the migration `down()` drops policies, functions, grants, and the role;
    application rewiring routes through the existing `AccountScope`/bootstrap seam.
14. **Requirement IDs:** NFR-001 (tenant isolation — the second, DB-enforced layer).
15. **Governing ADRs / CDRs:** ADR-007 (two-layer isolation), ADR-020 (standard-Postgres RLS), CDR-008
    (global identity tables excluded), CDR-010 (accounts), CDR-011 (memberships/accept), CDR-012 (AccountScope).
16. **Implementation slices:** (1) this CDR + config contracts + agent state + draft PR; (2) role + grants +
    RLS migration + policies + restricted-role integration; (3) the three SECURITY DEFINER bootstrap
    functions + provisioning/resolution/accept rewiring + bootstrap-abuse tests; (4) route remaining
    account-owned ops through restricted scoped transactions + profile/membership regressions +
    pooling/commit/rollback/concurrency; (5) catalog inspection + adversarial bypass + migration up/down +
    docs + independent security & architecture reviews.
17. **Company tenancy remains deferred** to ACBP-P1-010 (no company policies, no fabricated company context).
    **No additional privileged bootstrap function may be added without another explicit owner decision.**
18. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted Option A (full FORCE RLS on accounts/account_profiles/memberships; restricted app role
subject to RLS; migration/owner role distinct) + Option A1 (a third narrow SECURITY DEFINER accept_invite
bootstrap). Bootstrap allowlist is exactly {provision_account, resolve_own_membership, accept_invite}. No
token authority in a GUC or RLS policy. Accept binds email from platform-authoritative users data. No
fourth bootstrap function without another owner decision.
Date: 2026-07-21
```
