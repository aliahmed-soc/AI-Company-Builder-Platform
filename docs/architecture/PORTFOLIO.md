# Company switching and portfolio (ACBP-P1-011)

Status: implemented (API-only; CDR-017). This is the "portfolio README" for the membership-filtered company
listing and stateless company switching. Sources: CDR-017 (owner decisions); backlog PORT-001/002/003; ADR-007
(tenancy); CDR-015 (company tenancy, `CompanyScope`, the closed 3-function SECURITY DEFINER allowlist); CDR-016
(cursor/API conventions); TENANCY.md ("a company is resolved into, not listed — portfolio/list is P1-011").

## What the portfolio is — and is not

The portfolio is the **membership-filtered** list of companies the caller can actually enter: exactly the
companies where the caller holds an **active `company_membership`** in the current account. It is **NOT** an
account-owner registry view — account ownership grants **no** portfolio row by itself (CDR-017 §1; CDR-015 §2
reaffirmed). The `companies` SELECT policy being account-scoped is a **tenant-isolation boundary, not a product
feature**: the product query starts from the actor's memberships and never "lists all account companies".

## Two-phase read (both under freshly validated scopes)

1. **Enumeration** runs under the caller's **`AccountScope`** (`app.current_account` + `app.current_actor` set;
   `app.current_company` **intentionally unset**). `PortfolioRepository.listActiveMembershipCompanies` starts
   from the `company_memberships` **self-branch** (`member_user_id = app.current_actor`, the RLS authority for
   candidate rows) and joins `companies` on matching `account_id` + `company_id`. Keyset order is
   `companies.created_at DESC, companies.id DESC`; it fetches `limit + 1` to detect a further page. Candidates
   carry no name (the versioned `company_profiles` is dual-keyed and **not** readable under account scope) — only
   `company_id`, truthful `status`, the caller's `role`, and the exact microsecond epoch of `created_at`.
2. **Name enrichment** reads each paged candidate's current profile name through a **fresh, per-candidate
   `runInCompanyScope`** — **sequential, never parallel** (no mixing of transaction-local company context), and
   never a reused/cached/global scope. Each enrichment re-validates the active company membership and mints a
   fresh `CompanyScope` before the `company_profiles` read (CDR-017 §3). No account-scoped `company_profiles`
   SELECT policy is added — the dual-keyed profile RLS stays exactly as P1-010 shipped it.

**Stale handling:** a membership revoked **between** enumeration and enrichment makes `runInCompanyScope` deny;
that candidate is **dropped** — never emitted as a stale/partially-authorized/substituted row, and never a
fallback to another company. The keyset cursor still advances past the dropped candidate (it is derived from the
last *enumerated* candidate, not the last emitted item), so pagination stays correct and the next read simply
excludes the revoked company.

## Switching is stateless, URL-only, and non-authoritative

There is **no** switch endpoint, **no** `company:switch` authz action, and **no** durable switch event.
"Switching" is the client requesting a different `companyId` (e.g. one returned by the portfolio) on a normal,
independently authorized request; the domain re-resolves context from scratch every time
(`identity → active account membership → account/company relationship → active company membership → fresh role`).
**Nothing** is persisted: no `selected_company_id` column/table, no Clerk metadata, no cookie authority, no
server-side session, no process-global "current company". A `companyId` from a route/cookie/header/Clerk claim is
a **selector, never authority** — transaction-local GUCs inside a single validated request are the only company
context, and they clear after both commit and rollback (`SET LOCAL`), so a pooled connection never carries a
prior request's company context.

## Authorization

A new **account-level** action **`portfolio:read`** (owner|viewer active account member) gates the **API call
only**; result rows remain intersected with the caller's active **company** memberships (an account role never
grants a row by itself). Deny-by-default: inactive/revoked account membership, or an unknown action/role, denies.

## API — `GET /api/companies`

Authenticated; the account and actor are **server-resolved** (never request-supplied). The **only** supported
query parameters are `cursor` and `limit` (anything else → 400 — no arbitrary filters/search/export). Page size:
default **25**, maximum **100**; zero/negative/non-integer/excessive values are **REJECTED (400), never clamped**
(CDR-017 §8). The response is the redacted page `{ items: [{ companyId, name, status, role, createdAt }],
nextCursor }` — no `accountId`, actor ids, membership internals, totals, metrics, or aggregates (CDR-017 §9). A
denial is a coarse `403` (no membership/existence oracle); an invalid cursor or limit is a `400`.

## Cursor

Opaque, versioned, **unpadded base64url** (the shared pure-ECMAScript codec in `@acbp/contracts/codec`), carrying
the `createdAt` + `companyId` keyset position and **bound to the current account AND actor**. A malformed / foreign
(other account or other actor) / non-ASCII / wrong-version / over-long cursor is rejected (fail-closed — never a
fallback scan). There is no signing secret: a tampered-but-well-formed cursor can only re-window the caller's own
membership-filtered portfolio — it can never widen visibility or cross tenants (the query is membership-filtered
and RLS-confined regardless).

## What was deliberately NOT added

No fourth SECURITY DEFINER function (the allowlist stays exactly three); no RLS-policy, grant, FORCE-RLS, or
selection-persistence migration; **no index-only migration** — realistic query-plan analysis shows the
membership-driven access path is served by the existing `company_memberships_member_idx` partial index + the
`companies` primary key (see `docs/implementation/P1-011-PORTFOLIO-QUERY-PLAN.md`). No rendered portfolio/selector
UI, no switch mutation, no portfolio metrics/aggregates (PORT-004, Post-MVP).
