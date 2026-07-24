# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- **ACBP-P2-006 "Typed memory items with provenance"** (M2), branch `p2-006-typed-memory-items` from `main` @
  `1c49c55`, governed by **CDR-024**. Deps P1-005 (Done); the only unblocked Ready P2 ticket. No owner gate —
  the memory data model is fully pinned by canon (DATA-ARCHITECTURE §3).
- **Design (CDR-024):** `memory_items` (migration 0014) with the **closed 8-type enum** (user_fact,
  user_preference, constraint, ai_assumption, research_finding, approved_decision, measured_outcome,
  correction; type set by source path, untyped rejected), 6-value `source_type` + resolvable `source_ref`
  (encodes the pinned interview-answer `(question_id, revision)`), nullable confidence/superseded_by (populated
  by P2-008/P2-010), confirmation_state default 'proposed'. Dual-keyed FORCE RLS, SELECT+INSERT only
  (append-only for P2-006; supersede is P2-010). Operations create + list; authz `memory:write`/`memory:read`
  (owner|viewer). **Audit REQUIRED** (contrast P2-002): `memory.item_created` written in-transaction (ADR-015),
  metadata `{item_type, source_type}` only — flagged in CDR-024 §4 for owner visibility (new event name;
  implements the canonical "All changes audited"; additive/reversible). Out of scope: context assembly (P2-007),
  understanding/confidence-scoring (P2-008), the browser + edit/delete/supersede (P2-010).
- **Migration-cycle blocker — ROOT-CAUSED + FIXED (window 2).** The 42P01 `relation "public.memory_items" does
  not exist` in the multi-step `migrateDown`/`migrateTo(earlier)` suites was **Class T**: a window-1 bulk
  drop-list edit (adding `memory_items` to test cleanup lists) also matched and edited **migration `0013`'s down
  loop**, so `0013.down` ran `drop policy/revoke … on public.memory_items`. During a down PAST 0013, `0014.down`
  had already dropped `memory_items` (step 0, success), so `0013.down` raised 42P01 at step 1. The single-step
  memory-items test passed because it never reached `0013.down`. Fix: `0013.down` reverted to its own tables
  (`['interview_answers','interview_questions']` — matches main). Also reverted the two window-1 speculative
  changes made for the wrong hypothesis: `0014` self-FK on `superseded_by` **restored** (integrity), and
  `0014.down` restored to the standard policy-drop+revoke+drop-table pattern (matches 0012/0013). Verified on a
  disposable PostgreSQL (Docker daemon unresponsive → used the Windows-native 5433 cluster, isolated
  `acbp_p2006_test` DB, command-local env — `.env.local` untouched): full suite **114 files / 1277 tests / 0
  failed / 0 skipped**, including reverse-fully-and-reapply + the 8 previously-failing suites.
- **Next:** push the fix (exact-head hosted CI green, zero skips), then P2-006 slices 3–5 (core create/list +
  audited-in-tx `memory.item_created`, API, adversarial+docs), reviews, finalize. Branch
  `p2-006-typed-memory-items`, draft PR #22, CDR-024; **main untouched/green** at `1c49c55`.
- **ACBP-P2-002 — Done** (squash `1c49c55`, PR #21). Phase 2: 2 Done / 10 Planned. P2-003/P2-005 gated by open
  question IOQ-13; P2-006 is the sole unblocked ticket.

## ACBP-P2-002 detail (Done) — branch `p2-002-question-answer-persistence`, PR #21, CDR-023
- Status **Done**; feature head `71657ae` (review fixes), exact-head CI
  **30075033944 green** — real-PG Q&A suites (append-only revisions, idempotent no-op, concurrent
  distinct-both-persist + identical-collapse, NOT-NULL author, cross-tenant isolation) + HTTP adversarial all
  passed. Both independent reviews CLEAN with an explicit verdict that the CDR-023 §4 audit-deferral is
  acceptable and NOT an owner gate; all observations fixed (P2-002-REVIEW-COVERAGE.md). Sequence: finalization
  records commit → exact-commit CI → PR #21 ready → recheck main/PR#10 → squash-merge **"ACBP-P2-002: Question
  and answer persistence"** (no Co-Authored-By) → exact-main CI → delete branch → next Phase 2 ticket.
- Migrations 0001–0013; exactly 3 SECURITY DEFINER (all 0006); `acbp_app` NOBYPASSRLS/non-owner; no owner
  runtime; `interview_questions` (immutable) + `interview_answers` (append-only, NOT-NULL author) dual-keyed
  FORCE RLS. **Persistence-only** — no audit/domain event (deferred; CDR-023 §4).
- **ACBP-P2-001 — Done** (squash `6cf537e`, PR #20). Phase 2: 2 Done / 10 Planned. Next candidates: P2-005
  (adaptive orchestration; deps P2-003+P2-002 — P2-003 gated by IOQ-13, so P2-005 is blocked); **P2-006** typed
  memory (deps P1-005 Done — UNBLOCKED); P2-003 gateway gated by IOQ-13.
- **PR #10** still OPEN/draft/external — inspect GitHub state only; never touch.

## ACBP-P2-001 detail (Done) — branch `p2-001-interview-session-state-machine`, PR #20, CDR-022
- **Design (CDR-022):** the durable, company-scoped interview **session envelope** + server-enforced state
  machine (§2 six states) + exact resume + `interview.started` (audit-only; activity projection DEFERRED so
  P1-009's closed taxonomy isn't expanded in a persistence slice) + illegal-transition rejection. P2-001
  implements start/suspend/resume + read; the ready_for_review/confirmed/superseded transitions are defined in
  the contract but their effects belong to later M2/M3 tickets. Migration 0012 `interview_sessions`
  (dual-keyed FORCE RLS, column-immutable identity, one-open-session-per-company partial unique index). Authz
  `interview:read`/`interview:participate` (owner|viewer). Four slices (contracts → migration → core → API).
- **Selected over** P2-006 (unblocked but downstream/parallelizable) and P2-003 (gated by open question
  IOQ-13). P2-001 is the root of the M2 dependency tree.
- **P0-005 remains Blocked** — a known blocked dependency; stop only if a Phase 2 ticket becomes blocked on it.
- **PR #10** (`p1-004-last-owner-race-fix`) still OPEN/draft/external — inspect GitHub state only; never touch.

## Phase 1 completion evidence (2026-07-24)
- **Tickets:** ACBP-P1-001…P1-015 all Done. Squash SHAs for the tickets closed in this session's arc:
  P1-010 `093ec3f` (PR #11), P1-011 (PR #13), P1-012 `c1990ad`… see below, P1-013 `c1990ad`… (PR #15),
  P1-014 **`b559d37`** (PR #16), P1-015 **`85fcb8f`** (PR #17). Final `origin/main` = `85fcb8f`.
- **Migrations:** 0001–0011, ordered and intact. No 0012.
- **SECURITY DEFINER:** exactly three, all in `0006_bootstrap_functions.ts`
  (`acbp_provision_account`, `acbp_resolve_own_membership`, `acbp_accept_invite`).
- **Runtime role:** `acbp_app` created NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOINHERIT;
  BYPASSRLS granted to no one; no `DATABASE_URL` in `apps/web` runtime source (owner connection is
  migration/test-only).
- **Evidence discipline:** hosted CI on the exact SHA is the trust-critical DB evidence; zero-skip PostgreSQL
  preflight enforced; production `next build` is recorded separately and never conflated with hosted CI.
- **Post-completion audit:** backlog P0 20 Done + P0-005 Blocked; P1 15 Done; no abandoned P1 branches (only
  `main` + external PR #10); secret/encoding/boundary checks 0; no temp/scratch/secret artifacts tracked
  (only `.env.example`). One records-only staleness (this file's Active section) fixed on branch
  `records-phase1-complete`.

## ACBP-P1-015 detail (Done, squash `85fcb8f`, PR #17)
- Branch `p1-015-slice-a-secure-company-creation` from `main` @ `b559d37`, **PR #17**. Governed by **CDR-021**.
  - **Design (CDR-021):** the M1 exit criterion made executable — sign in → internal mapping → account →
    company → switch → cross-company access DENIED, with the audit/activity trail verified. The journey is
    implemented ONCE in `@acbp/test-support` (`runSliceAJourney`) and consumed by BOTH the runnable demo
    (`pnpm demo:slice-a`, wired into the CI gate) and the CI suite, so the demo cannot drift from the
    guarantee. Everything below the provider-SDK edge is production code over the restricted `acbp_app`
    connection under FORCE RLS; `DATABASE_URL` is deleted from the runtime's environment and the restricted
    role is then PROVEN positively via `runtimeConnectionRoles`.
  - **Browser-level E2E deferred to staging** (CDR-021 §1): the slice-A flows are API-only by owner decision,
    so there are no screens to drive, and driving Clerk's hosted sign-in would need live provider credentials.
    `TEST-AND-VERIFICATION-STRATEGY.md` amended accordingly. No live authenticated acceptance performed.
  - **Progress:** Slice 1 `2f03a70` (journey + CI suite + demo + CDR-021 + demo doc; exact-head CI 30063164730
    green, 104 files / 1157 / 0-skip, 3m18s). Then the two independent reviews (security; architecture/scope)
    found the DEMO SCRIPT — the backlog row's own acceptance criterion — could not run at all: a Windows
    `pathToFileURL(url.pathname)` drive-letter doubling, and no `@/…` alias resolution outside
    `apps/web/tsconfig.json` + `vitest.config.ts`. Both repaired and the script then EXECUTED end to end
    against real PostgreSQL (10/10 steps, exit 0), and wired into `ci.yml` so the criterion has hosted
    evidence. Also repaired from the reviews: ACC-001 proven NEGATIVELY (mutable verification status +
    unverified-email refusal), PORT-003 given a real A→B→A switch, two unfalsifiable journey steps replaced
    with falsifiable ones (route-stamped `actor_id`; "did this caller leave a trail INSIDE the other
    tenant?"), the runtime-role claim upgraded from precondition to positive proof, the three hand-copied
    runtime-env blocks consolidated into `configureRouteRuntimeEnv`, and the fixture's company names exported
    so leak assertions cannot go vacuous on a rename.

## Closed in this session
- Ticket: **ACBP-P1-014** — Tenant-isolation adversarial suite (status: **Done**). Squash-merged **`b559d37`**
  (PR #16). Implemented under CDR-020. Class M owner gate on `activity_events.event_id` global uniqueness
  RESOLVED as **Option C** (accepted residual: server-generated opaque global identities may remain globally
  unique when no production or plausible application-bug path can supply a foreign value to the constraint;
  caller-influenceable idempotency keys stay tenant-scoped, as already implemented for `audit_events`).
- Ticket: **ACBP-P1-013** — Administrative-access foundation (status: **Done**, owner-authorized 2026-07-24).
  Implemented 2026-07-23 under 21 explicit owner decisions → **CDR-019**.
- Branch: `p1-013-administrative-access-foundation` (from `main` @ `795227b`).
- Base main: `795227bb5265eb71d09e0a220fb3f8917eaa3384` (P1-012 squash PR #14; exact-main CI 30014863811 green,
  87 files / 951 / 0-skip).
- **P1-013 design (CDR-019):** owner-managed `platform_admins` allowlist (users.id-keyed; runtime = self-check
  SELECT only, fresh per request; NO runtime management API; no default/env admin); mandatory bounded VERBATIM
  reason (≥1 non-ws char, ≤512 code points, no NUL, validated before any DB read); single operation
  `admin.tenant_read` (audit-only; target-tenant-scoped; actor_type admin; metadata {reason, scope='company_overview'};
  audit failure blocks response); cross-tenant read via transaction-local target GUCs on `acbp_app` ONLY after
  identity + reason + fresh-admin checks (accountId+companyId both selectors, relationship DB-verified; JIT =
  per-transaction; primitive PRIVATE — no generic runAsTenant export); API-only
  POST /api/admin/accounts/[accountId]/companies/[companyId]/read body {reason} → {companyId,status,creationMode,
  createdAt}; coarse single 403 (no existence oracle); NO impersonation structurally; break-glass + JIT workflow
  DOCUMENTED not built; activity taxonomy unchanged; no 4th SECURITY DEFINER/BYPASSRLS/owner-runtime/third role.
- PR: **#15 draft** "ACBP-P1-013: Administrative-access foundation", base `main`.
- **P1-013 progress:** planning `c48734d` (CDR-019); Slice 1 `15d5adb` (contracts/authz/audit registry; CI
  30017194994 green); Slice 2 `d49e33b` (migration 0011 platform_admins + real-PG suite + runbook; its CI
  30017530296 FAILED on a latent head-pinned migrateDown in the P1-012 backfill suite → repaired `b014e4e`:
  rollback targets pinned BY NAME, also restoring the 0009 reapply proof that had gone vacuous); Slice 3
  `1b28db6`+`a86cf92` (executeAdminCompanyRead one-tx primitive + adminReadCompanyOverview + real-PG trust
  suite + always-run no-impersonation boundary guard; CI 30018642111 green 91f/980/0-skip); Slice 4 `0db555c`
  (admin API route + strict parsing/privacy tests + prod build, route emitted dynamic; CI 30019840829 green
  1018/1018/0-skip). Slice 5 `ae53442`+`966e44d`: malformed-selector UUID-shape guard, full doc set
  (ADMINISTRATIVE-ACCESS.md + BREAK-GLASS-DESIGN.md new; SECURITY-ARCHITECTURE/AUTHORIZATION/TENANCY/
  API-CONTRACTS/EVENT-CATALOG/AUDIT/DATA-ARCHITECTURE updated), three independent reviews over the eight owner
  lenses (no Critical/High; 1 Medium + 6 Lows + 1 info — ALL fixed; ledger in
  `docs/implementation/P1-013-REVIEW-COVERAGE.md`), postcss ≥8.5.12 override (GHSA-6g55-p6wh-862q).
  **Final feature HEAD `966e44d`; exact-head CI 30021770562 green — 93 files / 1038 / 0 failed / 0 skipped.**
  NOTE (documented deviations): no reified AdminCapability value exists — the capability is the verified
  position inside the one transaction (strictly stronger: nothing to cache/serialize/forge); META_MAX_VALUE_LEN
  raised 512→1024 UTF-16 units for astral verbatim reasons (the PUBLIC reason limit stays exactly 512 code
  points); all admin parse failures collapse to one generic 400.
- **P1-012 design (CDR-018, owner-accepted 2026-07-23):** internal-Postgres-only workspace provisioning; six
  canonical ordered steps (profile, mission_draft, research, roadmap, documents, activity); auto-start after the
  creation tx COMMITS; request-driven SEQUENTIAL execution, fresh CompanyScope tx per step; NO worker/queue/
  detached-task/polling/lease/daemon/outbox/owner-connection; durable statuses pending|completed|failed (NO
  committed running); max 3 total attempts/step (exhausted → safe conflict); one MUTABLE row per (company, step)
  in `provisioning_steps` + `company_workspace_areas` registry (mission_draft/research/roadmap/documents INSERTs;
  profile + activity are VERIFICATION steps — no duplicates, no synthetic events); activation = all six completed
  (failed-acknowledged DEFERRED); six audit-only registered events (started/step_started/step_completed/
  step_failed/retry_requested/completed; system actor for execution, user actor for retry_requested); P1-009
  activity taxonomy UNCHANGED; migration 0010 additive (FORCE RLS dual-key; backfill seeds pending checkpoints
  for draft/onboarding companies, runs nothing, transitions nothing); authz `provisioning:read` (owner|viewer) +
  `provisioning:resume` (owner); API-only GET …/provisioning + POST …/provisioning/resume (single resume route,
  no start/retry/acknowledge/cancel, no body/params, no UI/SSE); NO 4th SECURITY DEFINER.
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

## Authority limits (this ticket — P1-015)
- Standing Phase 1 authorization covers implementation, slices, pushes, CI, reviews, defect fixes, marking
  P1-015 Done, marking PR #17 ready, squash-merging it, and deleting its branch. Still forbidden: production
  systems/credentials/deploys, live Clerk, any Clerk dashboard change, public tunnels, force-push or history
  rewrite, direct commits to main, non-squash merges, touching PR #10 / its worktree / the stale
  `claude/affectionate-northcutt-f33c98` branch or the inert P1-002 endpoint, weakening tests to make them
  pass, and implementing later-phase scope. Stop only for a NEWLY discovered true mandatory owner gate.

## Authority limits (historical — P1-013)
- No production systems/credentials; no public tunnel; no Clerk dashboard; do not touch the inert P1-002 endpoint
  or PR #10 / its worktree. Do NOT: mark P1-013 Done / PR ready / merge / delete branch / begin P1-014; build
  break-glass or a JIT approval workflow; implement impersonation of any kind; add tenant-data mutations, admin
  list/search, audit export, UI, or SSE; add a runtime admin-management endpoint; add a worker/queue/outbox; add
  a 4th SECURITY DEFINER; weaken FORCE RLS; grant BYPASSRLS; expose the owner runtime connection or a third
  runtime role; export a generic arbitrary-tenant scope primitive; expand the activity taxonomy.

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
  **Query-plan decision (CDR-017 §10): NO index migration** — PROVEN by hosted real-PG EXPLAIN evidence
  (`portfolio-plan.integration.test.ts`, realistic ANALYZEd population, postgres:16): natural plan = Limit → Sort →
  Nested Loop(Bitmap via `company_memberships_member_idx` → `companies_pkey` probe), no seq scans, identical for
  first + keyset pages. Migrations remain 0001–0009. See `docs/implementation/P1-011-PORTFOLIO-QUERY-PLAN.md`.
  Local integration UNRUNNABLE (Windows→WSL 5432 forwarding refuses connections); hosted CI is the zero-skip gate.
- Slice 3 — **DONE**. `getCompanyPortfolio` use case: Phase 1 enumeration under AccountScope
  (`portfolio:read` account-role check via own-membership bootstrap, then `PortfolioRepository`); Phase 2
  SEQUENTIAL per-candidate name enrichment via FRESH `runInCompanyScope` (Option B — no scope reuse, no parallel).
  A membership going stale between phases → runInCompanyScope denies → candidate DROPPED (never a stale/substituted
  row; keyset advances past it). `enrichCandidatesSequentially` exported for deterministic stale-drop testing.
  Real-PG core test proves membership-only visibility, account-member-only-no-rows, forbidden non-member, keyset
  pagination + account+actor cursor, strict limit/cursor rejection, cross-company enrichment isolation, stale-drop.
  Pure-guard unit test (limit/cursor reject before any DB) runs everywhere.
- Slice 4 — **DONE**. `GET /api/companies` (portfolio) added to the existing collection route (POST create
  untouched): allowed params {cursor, limit} only (any other → 400); server-resolved account+actor; maps
  ok→200 {items,nextCursor} / forbidden→403 / invalid_cursor→400 / invalid_limit→400. Wired `getCompanyPortfolio`
  through the ClerkIdentityRuntime composition + CompanyRuntime; `getPortfolioForRequest` request use case.
  Web unit tests (request + http mapping) green; local production `next build` green (route ƒ dynamic).
- Slice 5 — **DONE**. Real-PG switch-isolation test: A→B→A sequential re-entry (no name/status bleed);
  same company yields DIFFERENT roles to different callers (role isolation via portfolio); concurrent entries +
  concurrent portfolios never cross (pooled-connection GUC isolation); transaction-local GUCs clear after COMMIT
  AND ROLLBACK; forged route companyId (non-member + cross-account) denies coarsely.
- Slice 6 — **DONE (pending owner gate)**. Architecture docs (`docs/architecture/PORTFOLIO.md`; TENANCY.md P1-011
  entry); two independent reviews CLEAN; final verification green. PR body updated. Awaiting owner authorization
  to mark Done / ready / merge / delete branch.

## P1-012 slice plan (CDR-018)
- Slice 1 — **DONE** (`69d15fa` + completeness-registry fix `d0dbe2f`): contracts (closed step/status/failure-code
  enums, DTOs, flag derivations), `provisioning:read`/`provisioning:resume`, six audit registrations + factories +
  operation partition. Draft **PR #14**.
- Slice 2 — **DONE** (`bcd12a2`; CI 30010682316): migration 0010 (CHECK-pinned tables; FORCE RLS dual-key;
  column-limited UPDATE; idempotent draft/onboarding backfill with BYPASSRLS guard) + real-PG
  RLS/privilege/backfill/down-up suite; all 22 existing suites' drop-lists extended.
- Slice 3 — **DONE** (`7e0a5d4`; CI 30011303006): creation tx atomically adds 6 pending checkpoints +
  draft→onboarding + provisioning.started (selective-writer rollback proven); creation returns onboarding.
- Slice 4 — **DONE** (`ae4fd5c`; CI 30012231249): fresh-scope step executor (FOR UPDATE + status/attempt guards;
  no committed running; cap 3), material effects (verify profile/activity; idempotent area inserts), resume
  orchestration (Phase A company-row-locked gates; USER retry_requested + causation; backfilled-draft bring-up;
  paused/inconsistent fail closed), completion transition (locks + gate + idempotent activation),
  createCompany post-commit INLINE auto-run (provisioningRunner seam); 12-test real-PG suite (kill-and-resume at
  every checkpoint, exhaustion, concurrency single-effect/single-activation, authz matrix, DTO privacy, GUC
  cleanup, provisioning audit completeness).
- Slice 5 — **DONE** (`5933fe3`; CI 30012614309): GET …/provisioning + POST …/provisioning/resume (param-free,
  body never parsed) + runtime wiring + web tests + prod build (both routes ƒ dynamic).
- Slice 6 — **DONE (pending owner gate)**: three independent reviews (security/RLS/audit; correctness/
  concurrency/state-machine; scope/migration/taxonomy) — NO Critical/High; R2's 2 Medium (concurrent-retry
  authorization/audit gaps) FIXED STRUCTURALLY (retry_requested written in the executing step tx under an exact
  (step, attempt) Phase-A authorization; unauthorized failed rows halt); 6 further Lows fixed, 5 accepted with
  documented rationale (`docs/implementation/P1-012-REVIEW-COVERAGE.md` register). Architecture docs complete
  (PROVISIONING.md new; TENANCY/AUTHORIZATION/EVENT-CATALOG/AUDIT/DATA-ARCHITECTURE/API-CONTRACTS updated).
  Local gate green on the Slice 6 candidate (674 passed / 277 PG-dependent skips; build; audit; diff-check).

## P1-013 slice plan (CDR-019)
- Slice 1 — CDR-019 + planning + draft PR; contracts (AdminReason validation, AdminReadTarget,
  AdminCompanyOverview), `admin:tenant_read` authz (granted to NO membership role), `admin.tenant_read` audit
  registration + completeness partition; unit tests.
- Slice 2 — migration 0011 `platform_admins` (self-check SELECT only; zero mutation grants) + real-PG
  RLS/catalog/lifecycle tests + operational setup/revocation runbook stub.
- Slice 3 — private admin gate + transaction-local target-scope primitive + audited company-overview read
  (audit-before-response atomicity) + real-PG trust tests.
- Slice 4 — POST /api/admin/accounts/[accountId]/companies/[companyId]/read (strict body/query parsing) + web
  tests + production build.
- Slice 5 — concurrent/GUC/no-impersonation adversarial tests + docs (break-glass design; runbook; architecture
  updates) + independent reviews + final verification (owner gate).

## Next executable action
Phase 1 is complete and merged (`85fcb8f`). Begin Phase 2: `git fetch --prune`, confirm clean/equal
exact-main hosted-green state, inspect PR #10 via GitHub state only, read the Phase 2 backlog, and select the
first canonical Ready/unblocked ticket by dependency + milestone order (never by ticket number alone). Run
canonical discovery; when canon resolves every foundational decision and no mandatory owner gate applies, make
the least-authority reversible recommendation, record it, open one branch + draft PR, and implement in TDD
slices — each pushed, each exact-head hosted-green (zero-skip PG), independently reviewed before finalization,
squash-merged, exact-main-CI-verified, branch deleted — then continue to the next Ready/unblocked ticket.

## Local integration environment (learned 2026-07-24)
Local real-PostgreSQL runs ARE possible on this machine, contrary to the older "unrunnable" note below — two
things were in the way: (1) the dedicated WSL distro terminates when no process holds it open, so hold it with
a background `wsl -d acbp-local-dev … sleep N` for the duration of a run; (2) the local owner role lacked
CREATEROLE, so migration 0005 failed with "permission denied to create role" — CI's owner is a superuser, so
`alter role acbp_dev superuser createrole` on the disposable local distro matches CI. Hosted CI remains the
authoritative zero-skip gate; local runs are for fast feedback and for executing `pnpm demo:slice-a`.
