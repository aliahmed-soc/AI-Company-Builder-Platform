# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-003** — Account creation and profile (status: **Planned**; owner-gated to move to Done).
- Branch: `p1-003-account-creation-and-profile` (from `main` @ `d1069f8`).
- PR: **(to be opened as draft once slice 1 is pushed)**, base `main`.
- Base main: `d1069f81e6c1f5c457d1883cd83835a1fa0e031f`.

## Prior ticket (closed)
- **ACBP-P1-002 — DONE & MERGED.** Squash-merged as `d1069f8` (PR #3, merged 2026-07-20). Main CI green.
  Feature branch deleted (local + remote). Live Clerk dev acceptance completed (18/18) before merge.
- Residual non-blocking owner cleanup (does NOT affect P1-003): delete the inert temporary Clerk webhook
  endpoint in the Clerk **Development** dashboard (its tunnel is dead → it can receive nothing). Owner
  action status: **not yet confirmed deleted** (tracked; no P1-003 impact).

## P1-003 scope (canonical) — CDR-010 (owner-accepted 2026-07-21)
- Personal account auto-provisioned **idempotently on first sign-in**; founder recorded as immutable,
  unique `accounts.created_by_user_id` (Option A). `created_by_user_id` is provenance only — P1-004
  memberships backfill a `role='owner'` membership from it; authorization is never derived from it.
- Account is **A-root** (no `company_id`, no company RLS — that's P1-006). Lifecycle `active|suspended|
  closed`; `plan_state` default `'free'`.
- Profile = 1:1 `account_profiles` (`display_name`, `locale`); identity-root `users` stays minimal.
- Email is **Clerk-authoritative + read-only** in the profile; change is delegated to Clerk (P1-002
  `user.updated` sync). No Clerk secret on the P1-003 path.
- Interim audit = structured `account.created`/`account.profile_updated` events (durable store is P1-008).
- **Excludes:** memberships/roles/invites (P1-004), tenant-context (P1-005), RLS (P1-006), authz
  middleware (P1-007), durable audit store (P1-008), deactivation/deletion (ACC-004/005), billing (P7),
  any in-app email mutation.

## Slices (planned)
1. Docs: CDR-010 + agent state — **in progress**.
2. `accounts` + `account_profiles` migration `0003` + `schema.ts` types + repository + PG integration.
3. Provider-neutral account/profile contracts + core idempotent provisioning use-case + unit tests.
4. Core profile read/update use-case (email read-only) + unit tests.
5. Web profile API/route + first-sign-in provisioning wiring + tests.
6. Interim structured-audit events (`account.created`, `account.profile_updated`).
7. Backlog sync (owner-gated).

## Test baselines
- Inherited from merged P1-002 main: hosted CI green at merge (`d1069f8`). New P1-003 suites TBD.

## Guards (must stay green every slice)
- `check:static` (typecheck, lint, `check:secrets` 0, `check:boundaries` 0, boundary tests),
  `check:encoding` (no BOM), full `vitest` incl. real PostgreSQL integration on hosted CI.
- Local Docker/PG not guaranteed → PG integration verified authoritatively on hosted CI.

## Blockers / owner decisions
- **RESOLVED:** account-model seam → CDR-010 Option A (owner-accepted 2026-07-21).
- Future owner gates (do NOT self-authorize): P1-003 backlog→Done, PR ready-for-review, merge. Begin P1-004
  only on separate authorization.

## Authority limits (this ticket)
- No production systems; no real customer data; no external credentials without explicit authorization;
  no public tunnel without explicit authorization; no unrelated architectural changes.

## Current HEAD
`d1069f8` (branch just created; first commit pending). Working tree: docs being written.

## Next executable action
Commit slice-1 docs (CDR-010 + agent state), push, open the draft PR with the canonical ticket ID/title,
then implement slice 2 (migration `0003` + schema + repository + PG integration) and run full CI.
