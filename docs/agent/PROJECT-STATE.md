# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-006** — Database row-level security layer (status: **Planned**; owner-gated to Done).
- Branch: `p1-006-database-rls` (from `main` @ `858407a`).
- PR: **draft, open, unmerged**, base `main`.
- Base main: `858407ad80f3be93dee365ae975e6d471c8f826a` (P1-005 squash-merge; main CI green run 29839939135).
- **STATUS: in progress under explicit owner authorization (Option A + A1) to implement to the finalization gate.**
  Do NOT mark Done / mark PR ready / merge / delete branch / begin P1-007 without separate owner auth.

## Prior tickets (closed)
- **ACBP-P1-001..P1-005 — DONE & MERGED.** P1-005 squash `858407a` (PR #6). Main CI green.
- Residual non-blocking owner cleanup: delete the inert P1-002 Clerk **Development** webhook endpoint. Do NOT touch it.

## P1-006 scope (canonical) — CDR-013 (owner-accepted 2026-07-21, Option A + A1)
- FORCE RLS on **accounts, account_profiles, memberships** (account-owned). `users` +
  `identity_webhook_receipts` are global (excluded). Policies keyed to `app.current_account` (+ `app.current_actor`
  self-branch for memberships), fail-closed via TEXT comparison (no uuid-cast exceptions).
- **Restricted app role `acbp_app`**: NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOINHERIT,
  non-owner, not a member of the owner role. Created NOLOGIN by the migration (no password in code); tests/deploy
  grant LOGIN+password out-of-band. Grants: USAGE on public; CRUD on the 5 app tables; EXECUTE on the 3 bootstrap
  fns. **The migration grants BYPASSRLS to NO ONE.**
- **Migration/owner role** owns tables+functions, runs migrations, carries BYPASSRLS in production (superuser in CI);
  never used for normal app traffic.
- **Exactly 3 SECURITY DEFINER bootstrap fns** (closed allowlist; no 4th without owner decision):
  `acbp_provision_account`, `acbp_resolve_own_membership`, `acbp_accept_invite`. Each: owned by owner role, fixed
  safe search_path, schema-qualified, no dynamic SQL, EXECUTE revoked PUBLIC + granted only `acbp_app`, minimal
  return, bypasses RLS only for its exact atomic transition. `acbp_accept_invite(invite_token_hash, auth_user_id)`
  binds email from platform-authoritative `users.primary_email` (active + verified), NEVER a caller param.
- **No token authority in any GUC or RLS policy.** Rewire provisioning/resolver/accept to the bootstrap fns;
  all other account-owned work runs under `AccountScope` (`runInAccountScope`/`withAccountTransaction`) as `acbp_app`.
- **Excludes:** company lifecycle + company RLS (P1-010), general authz middleware (P1-007), durable audit (P1-008), billing.

## Slices (planned)
1. CDR-013 + agent state + draft PR **#7** — **done** (`9c42d03`; CI 29844551561 GREEN).
2. Restricted role `acbp_app` + grants + RLS enable/force + policies (accounts/account_profiles/memberships) +
   restricted-role real-PG isolation suite — **done** (`d07d3de`; CI 29845284782 GREEN, zero-skip PG). Migration
   `0005_row_level_security.ts` + `rls.integration.test.ts`. Existing superuser suites unaffected.
3. The 3 SECURITY DEFINER bootstrap fns (migration `0006`) + provisioning/resolution/accept rewiring +
   bootstrap-abuse tests — **NEXT**. Fns: `acbp_provision_account`, `acbp_resolve_own_membership`,
   `acbp_accept_invite` (owned by owner role, EXECUTE only to acbp_app, fixed search_path, no dynamic SQL,
   minimal return, bypass only their atomic transition). accept binds email from `users.primary_email`.
4. Route remaining account-owned ops through restricted scoped transactions + profile/membership regressions
   + pooling/commit/rollback/concurrency.
5. Catalog inspection + adversarial bypass + migration up/down + docs + independent security & architecture reviews.

## Implementation notes (for continuation)
- Restricted-role test pattern (proven in `rls.integration.test.ts`): seed via superuser client (bypasses RLS),
  assert via a second `acbp_app` client; give the role LOGIN+throwaway password in `beforeAll`
  (`alter role acbp_app login password ...`). `asApp(gucs, fn)` sets GUCs via `set_config(...,true)` in a tx.
- Policy set (restricted role): accounts SELECT/UPDATE; account_profiles SELECT/UPDATE; memberships
  SELECT(+self-branch)/INSERT/UPDATE. Creation of account+profile+owner-membership, pre-context resolution,
  and accept are RLS-bypassed via the 3 SECURITY DEFINER fns (Slice 3), NOT via restricted-role policies.
- Bootstrap fns bypass RLS via owner-role ownership (owner has BYPASSRLS in prod / superuser in CI); the
  migration grants BYPASSRLS to no one.

## Guards (must stay green every slice)
- `check:static` (typecheck, lint, secrets 0, encoding 0 BOM, boundaries 0, boundary tests) + full `vitest` incl.
  real-PostgreSQL integration on hosted CI (zero-skip preflight) + `pnpm audit --audit-level high`. `next build`
  only if web runtime changes. Restricted-role RLS trust-critical suite + catalog inspection.

## Blockers / owner decisions
- **RESOLVED:** RLS enforcement model → CDR-013 (Option A + A1, owner-accepted 2026-07-21).
- Future owner gates (do NOT self-authorize): P1-006 backlog→Done, PR ready, merge, branch delete. Begin P1-007 only on separate authorization.

## Authority limits (this ticket)
- No production systems/credentials; no real customer data; no external DB; no public tunnel; no Clerk dashboard; do
  not touch the inert P1-002 Clerk endpoint; no unrelated refactors. Do NOT: add a 4th bootstrap fn; make a generic
  privileged membership API; place token authority in a GUC/policy; run accept via the owner connection from app code;
  weaken memberships RLS; trust caller email/identity; grant the app role BYPASSRLS/ownership; implement company RLS.

## Test baselines
- Inherited from merged `main` (`858407a`): hosted CI green. P1-006 RLS suites run under the restricted role.
  Integration files run serially (`vitest fileParallelism:false`) on one shared DB — keep new suites' cleanup drop-lists inclusive.
- Local Windows→WSL PG forwarding unstable; hosted CI is the authoritative zero-skip integration gate.

## Next executable action
Continue Slice 2 (restricted role + RLS migration + policies) under TDD. Commit + push each green slice; verify hosted
CI on the exact pushed commit. Stop only at the owner gate (all slices hosted-green + independently reviewed) or a new
genuine owner decision.
