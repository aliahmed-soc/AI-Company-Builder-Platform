# Tenancy primitives (ACBP-P1-005; ADR-007; CDR-012)

Status: implemented for the **account** granularity (ACBP-P1-005). Company granularity and RLS are later
tickets. This is the "tenancy README" for the ticket.

## Two type-distinct granularities

ADR-007 mandates two independent isolation layers and makes **internal membership the tenant authority**.
DATA-ARCHITECTURE §1 distinguishes **account-owned (A)** rows (keyed by `account_id`) from **company-owned
(C)** rows (keyed by `company_id`). CDR-012 (owner-accepted, Option B) keeps the two granularities
**type-distinct** so an account-only scope can never reach company-owned data.

| | Account-level (ACBP-P1-005) | Company-level (ACBP-P0-018; reserved for ACBP-P1-010) |
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

## What P1-005 does NOT do (later tickets)

- **P1-006** adds row-level security policies keyed to `app.current_account` (and later `app.current_company`)
  — the second, independent isolation layer. Company-owned RLS fails closed when `app.current_company` is
  absent, which is exactly why account scope never sets it.
- **P1-007** generalizes authorization into `authz.check`.
- **P1-008** adds the durable audit store.
- **P1-010** provides real company resolution and the company-level `TenantContext`, and may attach the
  `memberships.company_id` FK. `companyId` on `TenantContext` is **not** made optional by P1-005.
