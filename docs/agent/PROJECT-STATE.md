# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-007** — Authorization middleware (status: **Planned/Ready**; owner-gated to Done).
- Branch: `p1-007-authorization-middleware` (from `main` @ `012411e`).
- PR: **draft, open, unmerged**, base `main` (opened in Slice 1).
- Base main: `012411eb1c24b9375756fda80f1b9d50d9bc0c60` (P1-006 squash-merge PR #7; main CI green run 29860477369).
- **STATUS: Slice 1 complete + local-green. Continuing autonomously through the slices to the final owner gate.**
  Do NOT self-authorize: backlog→Done, PR ready, merge, branch delete, or begin P1-008.

## Prior tickets (closed)
- **ACBP-P1-001..P1-006 — DONE & MERGED.** P1-006 squash `012411e` (PR #7). Main CI green on each squash.
- Residual non-blocking owner cleanup: delete the inert P1-002 Clerk **Development** webhook endpoint. Do NOT touch it.

## P1-007 scope (canonical) — derived from backlog + ADR-022 §8 + ADR-006 + SECURITY-ARCHITECTURE §1
- Central **`authz.check`** implementing the ADR-022 flow's **internal role-check** step on every protected op.
  Deny-by-default; forged Clerk org/role/UI values rejected; **denials audited**. Failure = deny.
- **Behavior-preserving centralization:** today's owner/viewer gates are INLINE (`isOwner`/`isMember`) in each
  core use case. P1-007 formalizes them into ONE deny-by-default role×action matrix, changing WHO-can-do-WHAT
  for NOBODY. Because behavior is preserved and it is fully derived from accepted ADRs, **no new owner decision
  and no CDR are required** (unlike P1-005/P1-006 which had genuine forks).
- **Decision model:** role × action → allow/deny, deny-by-default. `authz.check` is a 4th INDEPENDENT control —
  it is NOT tenant isolation (AccountContext P1-005 + RLS P1-006 decide WHICH account); it only answers "may
  THIS role perform THIS action?" once the account is resolved. It mints no scope, selects no DB connection,
  bypasses no RLS, consults no Clerk claim.
- **Action matrix (from existing semantics):** `member:invite`→owner; `member:revoke`→owner;
  `member:list`→owner|viewer; `member:read_invited_email`→owner (the viewer email-redaction rule, modeled
  explicitly); `profile:read`→owner; `profile:update`→owner.
- **Excluded from authz.check (pre-context bootstrap / public):** `acceptInvite`, `provisionPersonalAccount`
  (no active-membership role yet), and the Clerk webhook (signature-only — NEVER behind account authz).
- **Excludes (later tickets):** company-level authz (P1-010), general policy/approval ADR-009/010,
  configurable/custom roles, durable audit store (P1-008), policy-admin UI, billing.

## Slices
1. **DONE (local-green).** Authz contract in `@acbp/contracts` (`authz/authz.ts`): `AuthzRole`, closed
   `AUTHZ_ACTIONS`, `isAuthzAction`, `AuthzDecision`/`AuthzDenialReason`, pure deny-by-default `authorize()`
   matrix, `authorizationDeniedEnvelope()` (opaque authz/403). 20 exhaustive matrix + deny-by-default unit
   tests green; static gate (typecheck/lint/secrets/encoding/boundaries) all EXIT 0. + agent state + draft PR.
2. **DONE (local-green; Slice 1 CI 29863395097 success).** Core `authz` module (`@acbp/core` `authz/authz-service.ts`):
   `checkAuthorization(role, action, {accountId, actorId}, {logger})` wraps the pure `authorize` matrix and
   emits an interim `authz.denied` audit event (warn; non-PII `{action, reason, accountId, actorId}`, mirroring
   `tenant.context_denied`) on deny; allows are silent. `isAuthorized` boolean helper. 8 unit tests; static gate
   all EXIT 0. Role is caller-supplied (server-resolved) — the module loads no data / mints no scope.
3. **DONE (local-green).** Integrated authz.check into the core use cases: `membership-service.ts`
   invite/revoke/list now call `checkAuthorization` (acting role already loaded from the ACTIVE membership;
   no new query), the email-redaction uses the non-auditing `authorize('member:read_invited_email')`, and
   `listMembers` threads a logger (composition + web request layer updated) so a list denial audits.
   `profile.ts` get/update call `checkAuthorization` for `profile:read`/`profile:update` (role loaded under
   scope via `MembershipRepository`, RLS self-row). Behavior preserved (all prior tests green). Added: unit
   tests that denials emit `authz.denied` (non-PII); real-PG test that a role change is reflected on the very
   next decision (no caching). Full local suite 501 pass / 0 fail (150 integration skipped locally); `next
   build` EXIT 0; static gate all EXIT 0.
4. **DONE (local-green).** Web/request negative matrix + forged-claim tests. Established that core is the
   AUTHORITATIVE enforcement (Slice 3) and the request→HTTP layers already fail-closed and map any
   `forbidden`→403 (existing coverage), so NO separate route middleware is added (a route-only or duplicate
   guard would add no security — the routes are thin mappers over the DI-injectable request use cases). Added
   to `members-request.test.ts`: forged-claim safety (acting user + account are ALWAYS server-resolved; a body
   `role` is only the INVITEE grant, never the caller's authority; a non-owner cannot self-elevate) and a
   per-privileged-endpoint negative matrix (GET/POST/DELETE members × unauthenticated/unverified/non-role →
   correct status). No Clerk role claim is consulted (identity resolution exposes only providerUserId + verified
   email). Test-only slice (no runtime change → `next build` unaffected; last green in Slice 3). 507 local pass /
   0 fail; static gate all EXIT 0.
5. Adversarial/bypass suite (direct-use-case invocation, cross-account, TOCTOU) + audit/observability
   verification + docs (authorization section) + independent security & architecture reviews.

## Guards (must stay green every slice)
- `check:static` (typecheck, lint, secrets 0, encoding 0 BOM, boundaries 0, boundary tests) + full `vitest` incl.
  real-PostgreSQL integration on hosted CI (zero-skip preflight) + `pnpm audit --audit-level high`. `next build`
  only if web runtime changes. Endpoint×role negative matrix + forged-claim tests are trust-critical.

## Blockers / owner decisions
- **None.** P1-007 DoR = Ready; no blocking questions; dependency P1-005 (Done). Evidence (ADR-022/006/007 +
  SEC-ARCH) is clear and non-conflicting → proceeding autonomously.
- Future owner gates (do NOT self-authorize): P1-007 backlog→Done, PR ready, merge, branch delete. Begin P1-008
  only on separate authorization.

## Authority limits (this ticket)
- No production systems/credentials; no real customer data; no external DB; no public tunnel; no Clerk dashboard;
  do not touch the inert P1-002 Clerk endpoint; no unrelated refactors. Do NOT: change the P1-006 role/RLS model
  (except to repair a demonstrated in-scope defect); add a 4th SECURITY DEFINER function; grant BYPASSRLS; use the
  owner DB connection for normal traffic; implement company lifecycle/authz; implement configurable roles; build a
  policy-admin UI; implement P1-008 durable audit; add "temporary allow" behavior.

## Test baselines
- Inherited from merged `main` (`012411e`): hosted CI green (zero-skip PG preflight + aggregate + audit).
  Integration files run serially (`vitest fileParallelism:false`) on one shared DB — keep new suites' cleanup
  drop-lists inclusive.
- Local Windows→WSL PG forwarding unstable; hosted CI is the authoritative zero-skip integration gate.
- The `_lc` shell hook intermittently emits false exit-127; verify state via git/gh/CI/filesystem re-reads.

## Next executable action
Continue **Slice 5** (adversarial/bypass suite: direct core use-case invocation cannot bypass authz [already
true — enforcement is inside the use case]; cross-account + TOCTOU [role/membership changed before commit];
audit/observability verification that `authz.denied` carries only non-PII; authorization docs [TENANCY.md or a
new AUTHORIZATION.md]; then dispatch INDEPENDENT security + architecture/scope reviews). Commit + push each
green slice; verify hosted CI on the exact pushed commit. **STOP at the owner gate** once all slices are
hosted-green + independently reviewed. Do NOT self-authorize backlog→Done / PR ready / merge / branch delete /
start P1-008.
