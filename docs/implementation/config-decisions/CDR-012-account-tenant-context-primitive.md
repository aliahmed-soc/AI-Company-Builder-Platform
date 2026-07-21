# CDR-012 — Account-Level Tenant-Context Primitive (separate from company-level)

1. **ID:** CDR-012
2. **Title:** A distinct account-level tenancy primitive (`AccountContext` / `AccountScope` /
   `withAccountTransaction` / `AccountRepository`), kept type-distinct from the company-level
   `TenantContext` / `TenantScope` / `withTenantTransaction` / `TenantRepository`
3. **Status:** Accepted
4. **Date:** 2026-07-21
5. **Owner:** Product owner (owner-selected **Option B** at the account-vs-company tenancy-primitive seam)
6. **Source ticket:** ACBP-P1-005
7. **Context:** ACBP-P0-018 built the company-level tenant primitive — `TenantContext {accountId,
   companyId, actorId?}`, a module-private **branded** `TenantScope`, `withTenantTransaction` (the only
   scope-minting path, which applies the `app.current_account/company/actor` GUCs with `SET LOCAL`), and a
   `TenantRepository` base whose constructor structurally requires a `TenantScope`
   (`packages/database/src/{tenant,session,transaction,repository}.ts`, proven in
   `repository.type-test.ts`). ADR-007 makes internal membership the tenant authority and mandates two
   independent isolation layers. ACBP-P1-004 / CDR-011 added **account-level** `memberships`
   (`owner|viewer`, lifecycle `invited→active→revoked`) as the authorization source, with
   `memberships.company_id` a **nullable structural hook and NO FK** — the `companies` table does not exist
   until **ACBP-P1-010**. ACBP-P1-005 must resolve tenant context **from active account membership**, but
   no company exists yet, so the existing company-level `TenantContext` (which requires a `companyId`)
   cannot be the vehicle. This CDR records the owner's resolution of the resulting primitive-shape seam.
8. **Decision (owner-accepted Option B):** Introduce a **separate, account-level** tenancy primitive that
   is **type-distinct** from the company-level one; do not overload or weaken the company primitive.
   1. **`AccountContext` contains `accountId` and an optional `actorId`, and NO `companyId`.** It is the
      provider-neutral currency for account-scoped work. It never carries, defaults, or fabricates a
      company identifier.
   2. **`AccountScope` is module-private / branded** (a `unique symbol` brand declared inside
      `@acbp/database`), so no code outside the database package can construct or forge one. Its brand is
      **distinct** from the `TenantScope` brand.
   3. **`withAccountTransaction` is the ONLY database-layer path that mints an `AccountScope`.** It requires
      an `AccountContext`, opens one real transaction, applies the account session settings first, and hands
      the callback the branded scope. There is no other constructor for a scope.
   4. **`withAccountTransaction` sets `app.current_account` and `app.current_actor` using `SET LOCAL`**
      (transaction-scoped GUCs, reverting on commit/rollback so a pooled connection never leaks scope).
   5. **`withAccountTransaction` MUST NOT set or fabricate `app.current_company`.** Account-scoped
      transactions leave the company GUC entirely unset; future company-owned RLS (P1-006) denies when
      `app.current_company` is absent, so account context can never read company-owned rows.
   6. **`TenantContext` / `TenantScope` / `withTenantTransaction` / `TenantRepository` remain company-level
      and UNCHANGED**, reserved for company-level tenancy. In particular, `companyId` on `TenantContext`
      stays **required** — it is NOT made optional, nullable, or empty.
   7. **`AccountRepository` requires an `AccountScope`** as a construction parameter (structural
      enforcement); **`TenantRepository` continues to require a `TenantScope`**.
   8. **`AccountScope` cannot be passed where a `TenantScope` is required, and vice-versa** — the distinct
      brands make the two mutually unassignable. **No compatibility alias, shared base brand, structural
      widening, or cast may collapse the two scopes into one type.** A company repository must never be
      constructible from an account-only scope.
   9. **Membership-backed resolution is the authority.** The resolver takes a **server-verified internal
      `userId`** and a **requested `accountId`** (treated only as a request, never as authority), loads the
      caller's **active** membership for that account, and either returns a resolved `AccountContext` or a
      **deny** (deny-by-default). `invited`, `revoked`, missing, inactive, and cross-account all deny; no
      Clerk organization/role claim is ever consulted; revocation takes effect on the next resolution. When
      a user has several memberships, resolution is deterministic because it is keyed to the explicit
      requested account.
   10. **Interim denial audit.** Denials emit a structured, correlated `tenant.context_denied` event
       carrying only non-PII fields (account id, actor id, coarse reason) — never emails, tokens, session
       values, or raw Clerk identifiers. The durable append-only audit store remains **ACBP-P1-008**.
9. **Scope:** the provider-neutral account-context contract + safe denial codes (`@acbp/contracts`); the
   branded `AccountScope` + `withAccountTransaction` + account session GUCs + `AccountRepository` base +
   compile-time isolation proofs (`@acbp/database`); the membership-backed resolver + trusted composition
   (`@acbp/core`); real-PostgreSQL integration + the trust-critical negative suite; a tenancy README.
   **Excludes** (do NOT implement early): company lifecycle / real company ids (P1-010), **P1-006** RLS
   policies, the general `authz.check` middleware (P1-007), the durable audit store (P1-008), billing, and
   any change to the company-level `TenantContext`.
10. **Alternatives:** (A) evolve the unified primitive — make `companyId` optional on `TenantContext` and
    emit an empty `app.current_company`. Rejected by owner: it introduces an empty/optional company state
    into the company primitive, making company fail-closure a runtime/policy concern rather than a
    type-level guarantee, and mutates the isolation core before companies exist. (C) minimal resolver
    returning only an "authorized account" token with no scope primitive — rejected: it would not advance
    the structural account-scoping foundation P1-006 RLS builds on.
11. **Security impact:** account authority derives solely from an active internal membership row (never a
    browser/Clerk claim); a requested account id is validated, never trusted; the two tenancy granularities
    are type-distinct so an account-only scope can never reach a company-owned repository; denials are
    coarse (no existence/state oracle) and audit events carry no PII/tokens; deny-by-default; the company
    GUC is never fabricated, keeping company-owned data fail-closed until P1-010.
12. **Reliability impact:** `SET LOCAL` GUCs are transaction-local (no pooled-connection leakage); scope
    minting only after membership validation; deterministic multi-membership resolution.
13. **Reversal cost:** Low–Medium — additive new module; the company primitive is untouched, so P1-010 can
    add company resolution and P1-006 can add account-level RLS without unwinding this.
14. **Requirement IDs:** NFR-001 (tenant isolation), NFR-002 (authorization from membership).
15. **Governing ADRs / CDRs:** ADR-007 (two-layer isolation; membership is the tenant authority), ADR-006
    (module boundaries), CDR-010 (account model), CDR-011 (account-level memberships this resolves from).
16. **Implementation slices:** (1) this CDR + agent state + provider-neutral account-context contract;
    (2) database account-scope primitive (`AccountContext`/`AccountScope`/`withAccountTransaction`/account
    GUCs/`AccountRepository`) + compile-time isolation proofs; (3) membership-backed resolver + real-PG
    integration; (4) trusted composition wiring + interim denial audit; (5) security hardening + trust-
    critical negative suite + tenancy README + independent review.
17. **Review trigger:** ACBP-P1-006 adds account-level RLS policies keyed to `app.current_account`;
    ACBP-P1-010 provides real company resolution and company-level context (and may then attach the
    `memberships.company_id` FK); ACBP-P1-007 generalizes authorization into `authz.check`.
18. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted Option B. Keep account-level and company-level tenancy type-distinct. Do not make
companyId optional on TenantContext. No alias may collapse the two scopes. P1-006 adds account RLS;
P1-010 adds real company context.
Date: 2026-07-21
```
