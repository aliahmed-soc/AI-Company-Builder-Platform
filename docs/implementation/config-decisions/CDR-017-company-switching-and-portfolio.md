# CDR-017 — Company switching and portfolio (ACBP-P1-011)

Status: **Accepted** (owner decision 2026-07-23). Governs ACBP-P1-011.
Sources: backlog ACBP-P1-011 (PORT-001/002/003; ADR-007; dep ACBP-P1-010; "Portfolio list + switching without
context bleed"; "Switch discards prior tenant context"; "Stale context forces reload"; "Two companies operate
independently; no cross-render"); REQUIREMENT-TRACEABILITY (PORT-001 tenant-scoped listing; PORT-003 context switch
discards prior tenant state; PORT-004 metrics = Post-MVP excluded); API-CONTRACTS Companies ("list (portfolio)",
"Member (read)"); TENANCY.md ("companies SELECT is account-scoped — a company is resolved into, not listed;
portfolio/list is P1-011"); CDR-012 (AccountScope never sets the company GUC); CDR-015 (account ownership never
auto-grants company access; companyId is a selector; closed 3-function SECURITY DEFINER allowlist); CDR-016
(cursor/API conventions).

## Owner decisions (2026-07-23)

1. **Membership-filtered portfolio.** The portfolio contains ONLY companies where the current actor holds an
   ACTIVE `company_memberships` row in the current account. Account ownership does **not** reveal or grant access
   to companies without an explicit active company membership (no account-owner administrative registry view).
2. **Enumeration path.** The portfolio executes from a verified **AccountScope**; `app.current_company` is
   INTENTIONALLY UNSET during the initial enumeration. The `company_memberships` SELECT **self-branch**
   (`member_user_id = current_actor`) is the AUTHORITY for candidate rows; the account-scoped `companies` SELECT
   policy is TENANT ISOLATION, not product authorization — the SQL must start from the actor's active memberships
   and join companies on matching `account_id` + `company_id`, never "list all companies and filter in memory".
3. **Name enrichment.** Current profile names are read ONLY through freshly validated **CompanyScope** reads —
   bounded, SEQUENTIAL, per paged candidate (fresh active-membership verification + account/company relationship +
   the existing trusted elevation primitive + deterministic current-revision read). **No account-scoped
   `company_profiles` SELECT policy is added** (decision 4): the dual-keyed profile RLS stays exactly as P1-010
   shipped it.
4. **Selection is URL-only, stateless, non-authoritative.** No `selected_company_id` is persisted anywhere — no
   database column/table, no Clerk metadata, no cookie authority, no server-side session. "Switching" = the client
   navigating/requesting a different `companyId` from the portfolio, followed by NORMAL fresh `runInCompanyScope`
   resolution (identity → active account membership → account/company relationship → active company membership →
   fresh role). Every company request revalidates; a prior request's context is never retained or reused.
5. **No switch surface.** No `company:switch` authz action, no `POST /switch` mutation, and switching is **not a
   durable audit event** (the closed taxonomy is unchanged; the interim `company.context_denied` log plus fresh
   resolution cover the security need).
6. **API-only.** `GET /api/companies` (portfolio). NO rendered portfolio page or company-selector UI.
7. **Authorization.** New ACCOUNT-level action **`portfolio:read`** → active account member (owner|viewer). The
   account role gates only the API CALL; result rows remain filtered by active company membership (an account role
   never grants a row by itself). Inactive/revoked account membership, unknown action/role → denied.
8. **Pagination.** Forward keyset: `companies.created_at DESC, companies.id DESC`; default 25; maximum 100;
   zero/negative/non-integer/excessive limits are **REJECTED (not clamped)**; no OFFSET; no cross-request snapshot
   guarantee. Cursor: versioned, genuine unpadded base64url, **bound to the current account AND actor**, carrying
   the `createdAt` + `companyId` position; strict validation; malformed/foreign cursors rejected safely; no signing
   secret (tampering can only re-window the caller's own membership-filtered portfolio).
9. **DTO.** `PortfolioItem { companyId, name, status, role, createdAt }`; `PortfolioPage { items, nextCursor }`.
   NOT exposed: accountId, membershipId, profile version internals, actor ids, audit/activity data, provisioning
   aggregates, internal errors. No filters, search, export, totals, metrics or aggregates.
10. **No migrations by default.** No RLS-policy or selection-persistence migration. An ADDITIVE **index-only**
    migration is permitted ONLY if realistic PostgreSQL EXPLAIN evidence proves the existing indexes inadequate
    (candidates: `company_memberships(account_id, member_user_id, status, company_id)`;
    `companies(account_id, created_at DESC, id DESC)`); such a migration must not change RLS or table semantics.
11. **No fourth SECURITY DEFINER function** (allowlist stays exactly three).

## Required behavior (invariants)

- **Stale/revoked selection forces reload:** a protected request against a revoked/stale selection denies with the
  coarse safe result (403); the next portfolio read excludes the revoked company; NO automatic fallback to another
  company and NO implicit default-company selection; a partially authorized or substituted row is never returned —
  if membership goes stale between enumeration and enrichment, the operation fails coarsely rather than emitting a
  stale row.
- **Paused companies** remain visible in the portfolio and manually readable with truthful status (autonomous-work
  restrictions remain P1-010 behavior).
- **Switch isolation:** A→B→A sequential and concurrent request sequences share NO row/name/role/context;
  transaction-local GUCs clear after commit AND rollback (SET LOCAL semantics); forged route companyIds deny.
- Non-authoritative inputs (unchanged architecture): account ownership, stored client selection, route companyId,
  cookies, headers, Clerk claims. Authority = fresh internal memberships only.

## Explicitly rejected

- **Listing all account companies merely because `companies` SELECT is account-scoped** — the RLS visibility of the
  registry is an isolation boundary, not a product feature; the product query starts from the actor's memberships.
- **Account-owner automatic company access or registry visibility** (CDR-015 §2 reaffirmed).
- **Cookie / header / Clerk-metadata selected-company authority** — nothing client-held ever becomes authority.
- **Server-global or process-global active-company state** — company context exists only as transaction-local GUCs
  inside a single request's validated scope.
- **Reusing a prior request's CompanyScope** — scopes are minted per request/per elevation and never cached.
- **Parallel company-name reads that could mix transaction-local company context** — enrichment is SEQUENTIAL
  (never `Promise.all` on one transaction/connection); each elevation either occurs inside one trusted executor
  where re-`SET LOCAL` between statements is safe, or in a separate fresh CompanyScope transaction per candidate.

## Out of scope (deferred)

Portfolio metrics/aggregates (PORT-004, Post-MVP); rendered portfolio/selector UI; switch mutation endpoints or
events; selected-company persistence; filters/search/export; provisioning execution (P1-012+); SSE; retention.
