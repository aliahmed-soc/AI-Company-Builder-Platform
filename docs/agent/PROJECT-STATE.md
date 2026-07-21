# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-004** — Membership and roles (owner+viewer) (status: **Planned**; owner-gated to Done).
- Branch: `p1-004-membership-and-roles` (from `main` @ `ee2dc6a`).
- PR: **(to be opened as draft once slice 1 is pushed)**, base `main`.
- Base main: `ee2dc6adcc2ee057a8b9240caa2cd675d95d7a8f`.

## Prior tickets (closed)
- **ACBP-P1-002 — DONE & MERGED** (`d1069f8`). Internal user mapping + replay-safe webhooks.
- **ACBP-P1-003 — DONE & MERGED** (squash `ee2dc6a`, PR #4, 2026-07-21). Accounts (`accounts` +
  `account_profiles`) + first-sign-in provisioning + profile API; CDR-010. Branch deleted; main CI green.
- Residual non-blocking owner cleanup (no P1-004 impact): delete the inert temporary Clerk webhook
  endpoint in the Clerk **Development** dashboard (tunnel dead → inert). Not confirmed deleted.

## P1-004 scope (canonical) — CDR-011 (owner-accepted 2026-07-21, Option A)
- `memberships` (A-tenant): account_id (FK accounts), member_user_id (FK users, null while pending), role
  `owner|viewer`, status `invited|active|revoked`, invited_email, invite_token_hash (single-use), invited_by,
  **company_id nullable, NO FK yet** (structural hook; P1-010 attaches FK + populates), timestamps.
- Owner backfilled from `accounts.created_by_user_id` (role=owner, active, company_id null). Membership row
  is the authorization source — never the Clerk claim, never created_by_user_id itself.
- Email-bound single-use invites: owner invites email+role → hashed single-use token (no email delivery
  infra — token returned to owner once) → invitee signs in via Clerk → accepts only if their VERIFIED
  primary email matches invited_email → active. Revoke immediate.
- Roles server-authoritative (Clerk claims never authorize); role matrix enforced on membership ops
  (owner manages; viewer read-only); deny by default. Interim audit events (durable store P1-008).
- company_id stays NULL in P1-004; company-scoped invite BEHAVIOR + companies FK land in P1-010.
- **Excludes:** companies + company-scope behavior (P1-010), tenant-context (P1-005), RLS (P1-006),
  general authz.check middleware (P1-007), durable audit store (P1-008), email delivery (Post-MVP),
  billing, deletion. Does NOT retrofit the P1-003 profile route (personal account, unaffected).

## Slices (planned)
1. Docs: CDR-011 + agent state — **done** (`2f85a84`); draft PR #5 open.
2. `memberships` migration `0004` + schema types + `MembershipRepository` + owner backfill + real-PG
   integration — **done, local gate green** (491/0/0; typecheck/lint/secrets/encoding/boundaries pass).
   Added `memberships` (child-first) to every suite's cleanup; flipped database.integration later-ticket
   assertion. Pending: push + hosted CI.
3. Core role model + invite/accept/revoke/list use-cases + role-matrix enforcement + interim audit + unit.
4. Web members API routes (invite/accept/revoke/list) + fail-closed auth + role-negative tests.
5. Backlog sync (owner-gated).

## Test baselines
- Inherited from merged `main` (`ee2dc6a`): hosted CI green. New P1-004 suites TBD. Integration test files
  run serially (`vitest fileParallelism:false`) — every real-PG suite shares one DB; keep new suites'
  cleanup drop-lists inclusive (add `memberships` + child-first order).

## Guards (must stay green every slice)
- `check:static` (typecheck, lint, `check:secrets` 0, `check:encoding` 0 BOM, `check:boundaries` 0,
  boundary tests) + full `vitest` incl. real-PostgreSQL integration on hosted CI + `pnpm audit --audit-level
  high`. `next build` when web runtime changes. Role-matrix + cross-account-isolation negatives.

## Blockers / owner decisions
- **RESOLVED:** membership/invitation model → CDR-011 Option A (owner-accepted 2026-07-21).
- Future owner gates (do NOT self-authorize): P1-004 backlog→Done, PR ready, merge. Begin P1-005 only on
  separate authorization.

## Authority limits (this ticket)
- No production systems/credentials; no real customer data; no public tunnel; no Clerk dashboard; do not
  touch the inert P1-002 Clerk endpoint; no unrelated refactors; do not implement RLS (P1-006), general
  authz middleware (P1-007), durable audit store (P1-008), or companies (P1-010) early.

## Current HEAD
`ee2dc6a` (branch just created; first commit pending). Working tree: docs being written.

## Next executable action
Commit slice-1 docs (CDR-011 + agent state), push, open the draft PR with the canonical ticket ID/title,
then implement slice 2 (`memberships` migration + schema + repository + owner backfill + PG integration).
