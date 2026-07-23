# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-011** — Company switching and portfolio (status: **Planned/Ready**; owner-gated to Done).
- Branch: `p1-011-company-switching-portfolio` (from `main` @ `e99b0b3`).
- Base main: `e99b0b396474d7316c25ba05a31382808d8c991c` (P1-009 squash PR #12; exact-main CI 29971233314 green,
  852/0-skip).
- PR: draft (opened at planning), base `main`.
- **STATUS: owner decisions made (CDR-017). Implementing autonomously.** Do NOT self-authorize: backlog→Done,
  PR ready, merge, branch delete, begin P1-012.
- **P1-011 design (CDR-017, owner-accepted 2026-07-23):** membership-filtered portfolio (active company_memberships
  only; NO account-owner registry visibility); enumeration under AccountScope (company GUC unset) starting from the
  memberships self-branch, joined to companies (account RLS = isolation, not authorization); name enrichment via
  bounded SEQUENTIAL fresh CompanyScope reads (NO account-scoped profile policy); selection URL-only/stateless/
  non-authoritative (nothing persisted anywhere); switching = navigate + fresh runInCompanyScope (no switch action/
  endpoint/durable event); API-only `GET /api/companies` (cursor+limit only; invalid limits REJECTED not clamped;
  keyset created_at DESC, id DESC; default 25/max 100; cursor base64url bound to account+ACTOR); DTO
  {companyId,name,status,role,createdAt}; no filters/metrics; no RLS/persistence migration (index-only allowed ONLY
  on EXPLAIN-proven need); no 4th SECURITY DEFINER.
- **P1-009 design (CDR-016, owner-accepted 2026-07-22):** separate append-only company-scoped `activity_events`
  table (PK = source audit `event_id`; redacted; rebuildable); **synchronous in-transaction projection** of the 4
  company events (`company.created/updated/paused/resumed`) written atomically with the lifecycle mutation + audit
  under the same restricted `acbp_app` CompanyScope; `audit_events` authoritative; **no outbox/async/worker/
  checkpoint/lease/owner-connection/4th SECURITY DEFINER**; `activity:read` = owner|viewer company member; keyset
  pagination (occurred_at DESC, event_id DESC; opaque versioned cursor; default 25/max 100); honest `as_of`;
  **API-only** `GET /api/companies/[companyId]/activity`; no rendered page, no SSE (SSE deferred to P6-008).

## Concurrent work — DO NOT TOUCH
- **PR #10** `p1-004-last-owner-race-fix` (separate session, now deleted) is **OPEN/unmerged**, base main. Its
  worktree `.claude/worktrees/p1-004-last-owner-race-fix` is still registered/locked. Leave it and the branch
  untouched. It touches the memberships REVOKE path; the separate `company_memberships` decision means **no
  overlap** with P1-010. If PR #10 merges during P1-010: fetch, fast-forward, rebase, re-run membership/authz/
  audit/RLS tests, record the new base.

## Prior tickets (closed)
- **ACBP-P1-001..P1-008 — DONE & MERGED.** P1-008 squash `8afb8f0` (PR #9). Main CI green on each squash.
- **ACBP-P1-010 — DONE & MERGED** (squash `093ec3f`, PR #11; exact-main CI `29935591570` green, 803/0-skip).
- Residual: delete the inert P1-002 Clerk Development webhook endpoint. Do NOT touch it.

## P1-010 scope (canonical) — CDR-015 (owner-accepted 2026-07-22)
- **Companies** (C-root: `company_id` PK immutable, `account_id`, name, status, creation_mode) + **company_profiles**
  (immutable versioned; new version per edit; COMP-004) + **company_memberships** (SEPARATE table: company_id,
  account_id, member_user_id, role owner|viewer, status; uniqueness `(company_id, member_user_id) WHERE active`).
- **Many companies per account**; company belongs to exactly one account. Company membership is INDEPENDENT of
  account membership (requires an active account membership; account ownership does NOT auto-grant company access;
  creator gets an explicit active company `owner` row).
- **Company context**: `CompanyContext {accountId, companyId, actorId}`; branded `CompanyScope` (type-distinct from
  AccountScope; the reserved P1-005 `TenantContext`/`TenantScope`/`withTenantTransaction` primitive); resolver =
  server-verified userId + requested companyId → active company_membership → mint CompanyScope; companyId is a
  selector never authority.
- **Create under existing AccountScope; NO 4th SECURITY DEFINER function** (account-keyed `companies` INSERT policy;
  one atomic tx: insert company → mint CompanyScope from the authoritative row → set app.current_company → insert
  owner membership → insert profile v1 → write company.created audit → commit-all-or-rollback-all).
- **Company RLS** keyed to app.current_account + app.current_company (both must match; fail-closed); `acbp_app` stays
  NOBYPASSRLS/non-owner. **audit_events gains nullable `company_id`** (additive expand; account events NULL, company
  events set; append-only preserved). Dual-scope audit policy (account: company_id NULL; company: both match).
- **Lifecycle (WORKFLOW §1 subset):** create (3 modes; idea-mode full) / rename+profile-update / status (truthful;
  unknown→"unknown") / pause / resume. Owner-only lifecycle mutations. Pause = "no new job pickup" (invariant-16
  groundwork via a minimal test rig; no real scheduler). Atomic transitions.
- **Durable company events (4, registered + in-tx):** company.created {company_id, creation_mode}, company.updated
  {changed_fields}, company.paused {reason?}, company.resumed {reason?, held_work_count?}.
- **Out of scope:** deactivate/delete (COMP-007 Post-MVP), portfolio/list/switching (P1-011), provisioning execution
  (P1-012), activity feed + outbox (P1-009+), company invitation flow, any scheduler/queue/worker beyond the test rig.

## Slices
1. Planning + contracts + CDR: **this commit** = CDR-015 + P1-009 dep correction + agent records. Then Slice 1 code:
   company contracts (@acbp/contracts): lifecycle/status/creation-mode types, company authz actions, typed audit
   event factories (company.created/updated/paused/resumed) + registry entries; exhaustive unit tests.
2. Schema + RLS: additive migrations (companies, company_profiles versioned, company_memberships, audit_events
   company_id) + grants/policies/indexes + real-PG migration/RLS/catalog tests (0001-0007 unchanged; no 4th fn).
3. Context + creation: company resolver + CompanyScope mint + same-tx company bootstrap (owner membership + profile
   v1 + company.created audit); 3 creation modes; failure/rollback tests.
4. Lifecycle: read/status, rename/profile-version, pause/resume, owner-only authz, audit atomicity, concurrency/
   idempotency, pause-pickup test rig.
5. API boundary (when canonical): authenticated routes, strict parsing, safe errors, forged-scope negatives; next build.
6. Adversarial hardening + docs + independent reviews.

## Guards (every slice)
- `check:static` (typecheck, lint, secrets 0, encoding 0 BOM, boundaries 0, boundary tests) + full `vitest` incl.
  real-PostgreSQL integration on hosted CI (zero-skip preflight) + `pnpm audit --audit-level high`. `next build`
  only if web runtime changes. Cross-tenant isolation + own-membership-only resolution are trust-critical.

## Blockers / owner decisions
- **RESOLVED:** company data-model/tenancy/bootstrap → CDR-015 (owner-accepted 2026-07-22).
- Future owner gates (do NOT self-authorize): P1-010 backlog→Done, PR ready, merge, branch delete. Begin/resume
  P1-009 only on separate authorization. Stop if profile-versioning storage semantics turn out canonically unsettled
  (owner-approved immutable-revision model per CDR-015).

## Authority limits (this ticket)
- No production systems/credentials; no external DB; no public tunnel; no Clerk dashboard; do not touch the inert
  P1-002 endpoint or PR #10 / its worktree. Do NOT: add a 4th SECURITY DEFINER function; weaken/alter FORCE RLS or
  the P1-006/account model; grant BYPASSRLS; expose the owner connection; reuse `memberships` for company membership;
  change account-membership semantics; implement activity feed/outbox/P1-011/P1-012/deactivate/delete; make
  unrelated refactors.

## Test baselines
- Inherited from merged `main` (`8afb8f0`): hosted CI green (zero-skip PG preflight + aggregate + audit). Integration
  files run serially (`vitest fileParallelism:false`) on one shared DB — new suites' cleanup drop-lists must include
  `company_memberships`, `company_profiles`, `companies` (and any new tables), ordered so FKs drop cleanly.
- Local Windows→WSL PG forwarding unstable; hosted CI is the authoritative zero-skip integration gate.
- The `_lc` shell hook intermittently emits false exit-127; verify state via git/gh/CI/filesystem re-reads (PowerShell).

## P1-011 slice plan (CDR-017)
- Slice 1 — **DONE** (`3e0834a`; exact-commit CI `29972673530` green). Shared base64url codec extracted; portfolio
  contracts (PortfolioItem/PortfolioPage; account+actor-bound base64url keyset cursor; strict limit REJECT-not-clamp);
  `portfolio:read` authz action + drift entry; codec/portfolio unit tests (54 contracts tests green).
- Slice 2 — **IN PROGRESS**. Account-scoped membership-filtered `PortfolioRepository`
  (`listActiveMembershipCompanies`: memberships-self-branch → companies PK join; keyset created_at DESC/id DESC;
  exact-microsecond `created_at_us`; NO name, NO list-all method) + real-PG visibility/isolation/keyset test.
  **Query-plan decision (CDR-017 §10): NO index migration** — the access path is membership-driven and bounded by
  the actor's active memberships, served by the existing `company_memberships_member_idx` partial index + companies
  PK; existing indexes adequate. Migrations remain 0001–0009. See `docs/implementation/P1-011-PORTFOLIO-QUERY-PLAN.md`.
  Local integration UNRUNNABLE (Windows→WSL 5432 forwarding refuses connections); hosted CI is the zero-skip gate.
- Slice 3 — **IN PROGRESS**. `getCompanyPortfolio` use case: Phase 1 enumeration under AccountScope
  (`portfolio:read` account-role check via own-membership bootstrap, then `PortfolioRepository`); Phase 2
  SEQUENTIAL per-candidate name enrichment via FRESH `runInCompanyScope` (Option B — no scope reuse, no parallel).
  A membership going stale between phases → runInCompanyScope denies → candidate DROPPED (never a stale/substituted
  row; keyset advances past it). `enrichCandidatesSequentially` exported for deterministic stale-drop testing.
  Real-PG core test proves membership-only visibility, account-member-only-no-rows, forbidden non-member, keyset
  pagination + account+actor cursor, strict limit/cursor rejection, cross-company enrichment isolation, stale-drop.
  Pure-guard unit test (limit/cursor reject before any DB) runs everywhere.
- Slice 4 — **IN PROGRESS**. `GET /api/companies` (portfolio) added to the existing collection route (POST create
  untouched): allowed params {cursor, limit} only (any other → 400); server-resolved account+actor; maps
  ok→200 {items,nextCursor} / forbidden→403 / invalid_cursor→400 / invalid_limit→400. Wired `getCompanyPortfolio`
  through the ClerkIdentityRuntime composition + CompanyRuntime; `getPortfolioForRequest` request use case.
  Web unit tests (request + http mapping) green; local production `next build` green (route ƒ dynamic).
- Slice 5 — A→B→A switch-sequence + concurrent context-isolation + pooled-GUC cleanup + adversarial tests.
- Slice 6 — docs + PR body + independent reviews + final verification.

## Next executable action
Commit the planning change (CDR-017 + agent records; NO production code), open the draft PR, then implement **Slice 1**
under TDD. Commit + push each green slice; verify hosted CI on the exact pushed commit (zero-skip PG). Stop only at a
genuinely new owner decision or the complete final owner gate. Do NOT: mark Done/PR-ready/merge/delete-branch, begin
P1-012, add selected-company persistence, a portfolio UI, a switch endpoint, a 4th SECURITY DEFINER, weaken RLS, or
touch PR #10 / the inert Clerk webhook endpoint.
