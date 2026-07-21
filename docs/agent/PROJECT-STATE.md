# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-005** — Tenant-context primitives (status: **Planned**; owner-gated to Done).
- Branch: `p1-005-tenant-context-primitives` (from `main` @ `3c3dded`).
- PR: **draft, open, unmerged**, base `main`.
- Base main: `3c3dded0728ee32ea1db3a4c0015dba81a41b48c` (P1-004 squash-merge; main CI green run 29831979133).
- **STATUS: in progress under explicit owner authorization to implement to the finalization gate.**
  Do NOT mark Done / mark PR ready / merge / delete branch / begin P1-006 without separate owner auth.

## Prior tickets (closed)
- **ACBP-P1-001..P1-004 — DONE & MERGED.** P1-001 (`a2603b6`), P1-002 (`d1069f8`), P1-003 (`ee2dc6a`),
  P1-004 (`3c3dded`, PR #5). Main CI green on each squash.
- Residual non-blocking owner cleanup (no P1-005 impact): delete the inert temporary Clerk **Development**
  webhook endpoint (tunnel dead → inert). Not confirmed deleted. Do NOT touch it.

## P1-005 scope (canonical) — CDR-012 (owner-accepted 2026-07-21, Option B)
- Separate, **type-distinct** account-level tenancy primitive; the company-level primitive stays UNCHANGED.
- New `AccountContext {accountId, actorId?}` (NO companyId), branded `AccountScope` (unforgeable outside
  `@acbp/database`), `withAccountTransaction` (only scope-minting path; applies `app.current_account` +
  `app.current_actor` via `SET LOCAL`; NEVER sets `app.current_company`), `AccountRepository` base requiring
  `AccountScope`. `TenantContext`/`TenantScope`/`withTenantTransaction`/`TenantRepository` remain company-
  level; `companyId` stays required. No alias may collapse the two scopes.
- Membership-backed resolver: (server-verified `userId`, requested `accountId`) → active membership →
  resolved `AccountContext` or deny. requested account id is a REQUEST, never authority. invited/revoked/
  missing/inactive/cross-account → deny; no Clerk claim consulted; revocation effective next resolution;
  deterministic under multiple memberships (keyed to the explicit requested account).
- Interim `tenant.context_denied` audit event (non-PII: account id, actor id, coarse reason); durable store
  is P1-008.
- **Excludes:** company lifecycle / real company ids (P1-010), RLS policies (P1-006), general `authz.check`
  middleware (P1-007), durable audit store (P1-008), billing. Do NOT make companyId optional on TenantContext.

## Slices (planned)
1. CDR-012 + agent state + provider-neutral account-context contract (`@acbp/contracts`) + draft PR — **done (this branch)**.
2. Database account-scope primitive: `AccountContext`/branded `AccountScope`/`withAccountTransaction`/account
   session GUCs/`AccountRepository` + compile-time isolation proofs (account-repo needs scope; Tenant↔Account
   scopes mutually unassignable; neither forgeable).
3. Membership-backed resolver (`@acbp/core`) + real-PG integration (active resolves; invited/revoked/missing/
   cross-account deny; immediate revocation).
4. Trusted composition wiring (resolve → mint scope only after validation) + interim denial audit.
5. Security hardening + trust-critical negative suite + DB GUC integration (SET LOCAL account/actor; no
   fabricated company GUC; no cross-tx leak; rollback/concurrency) + tenancy README + independent review.

## Guards (must stay green every slice)
- `check:static` (typecheck, lint, `check:secrets` 0, `check:encoding` 0 BOM, `check:boundaries` 0, boundary
  tests) + full `vitest` incl. real-PostgreSQL integration on hosted CI (zero-skip preflight) + `pnpm audit
  --audit-level high`. `next build` only if web runtime changes. Compile-time isolation proofs + trust-
  critical negatives (forged account, revoked-between-resolutions, cross-account, scope-mismatch).

## Blockers / owner decisions
- **RESOLVED:** account-vs-company tenancy-primitive seam → CDR-012 Option B (owner-accepted 2026-07-21).
- Future owner gates (do NOT self-authorize): P1-005 backlog→Done, PR ready, merge, branch delete. Begin
  P1-006 only on separate authorization.

## Authority limits (this ticket)
- No production systems/credentials; no real customer data; no public tunnel; no Clerk dashboard; do not
  touch the inert P1-002 Clerk endpoint; no unrelated refactors; do not implement companies (P1-010), RLS
  (P1-006), general authz middleware (P1-007), or the durable audit store (P1-008) early; do not make
  companyId optional on TenantContext.

## Test baselines
- Inherited from merged `main` (`3c3dded`): hosted CI green (448 pass / 0 fail / 103 skipped locally without
  a DB; hosted runs integration zero-skip). New P1-005 suites TBD. Integration files run serially
  (`vitest fileParallelism:false`) on one shared DB — keep new suites' cleanup drop-lists inclusive.

## Next executable action
Continue Slice 2 (database account-scope primitive) under TDD. Commit + push each green slice; verify hosted
CI on the exact pushed commit. Stop only at the owner gate (all slices hosted-green + independently reviewed)
or a new genuine owner decision.
