# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-004** — Membership and roles (owner+viewer) (status: **Planned**; owner-gated to Done).
- Branch: `p1-004-membership-and-roles` (from `main` @ `ee2dc6a`). HEAD `9bfd1ee`.
- PR: **#5 (DRAFT, open, unmerged)**, base `main` — all code slices committed + hosted-green.
- Base main: `ee2dc6adcc2ee057a8b9240caa2cd675d95d7a8f`.
- **STATUS: all code slices complete + hosted-green; independent review PASS. STOPPED AT OWNER GATE.**
  Awaiting owner authorization for: (1) backlog ACBP-P1-004 → Done, (2) PR #5 ready-for-review,
  (3) squash-merge to main. Do NOT self-authorize. Do NOT start P1-005.

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
3. Core `members` module: role model + invite-token (hashed, single-use) + invite/accept/revoke/list
   use-cases (owner-gated invite/revoke; email-bound accept; last-owner guard; immediate revoke) +
   interim `membership.*` audit + owner-membership wired into account provisioning — **done, local gate
   green** (520/0/0; unit fakes + real-PG trust-critical integration incl. role-matrix negatives +
   cross-account isolation). Pending: push + hosted CI.
4. Web members API: runtime member ops + `GET/POST /api/account/members`, `POST
   /api/account/members/accept`, `DELETE /api/account/members/[membershipId]` — fail-closed auth →
   internal user → caller's own account (accept scoped to the invite's account); bounded JSON bodies;
   safe HTTP mapping; invite token exposed once. Unit tests. **done, local gate green** (550/0/0;
   `next build` OK — 3 routes bundle as `ƒ`; lint/boundaries/encoding/secrets pass; audit 1 moderate
   below gate). Pending: push + hosted CI.
5. Backlog sync (owner-gated) — **STOP; do not self-authorize backlog→Done / PR ready / merge.**

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
`9bfd1ee` on `p1-004-membership-and-roles`. Draft PR #5. Working tree clean. Hosted CI green on every
pushed slice; local full suite 551/0/0 with real PostgreSQL. Independent security/scope review PASS.

## Next executable action
**NONE — STOPPED at the owner gate.** Do not self-authorize. Remaining steps are owner-gated: (1) backlog
ACBP-P1-004 → Done, (2) `gh pr ready 5`, (3) squash-merge PR #5, then verify main CI + delete branch. Only
begin ACBP-P1-005 on separate explicit authorization. Optional/non-blocking: live authenticated-route
acceptance needs a dev server + Clerk DEVELOPMENT env (owner/external-access gate).
