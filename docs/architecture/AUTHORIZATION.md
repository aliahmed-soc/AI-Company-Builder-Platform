# Authorization (`authz.check`) — ACBP-P1-007

Status: implemented for the MVP **owner/viewer** role model. This is the "authz" documentation for the ticket
(ADR-022 §8; ADR-006; SECURITY-ARCHITECTURE §1; NFR-002).

## Where authorization sits — four independent controls

ADR-022 §8 mandates one flow on **every protected operation**:

```
Clerk session → internal user mapping → internal account/company membership → internal ROLE CHECK
  → tenant-scoped database authorization (RLS) → operation-specific policy/approval
```

P1-007 implements the **internal role check** — `authz.check` — as a control that is **independent of** the
three layers around it. Each answers a different question and none substitutes for another:

| Control | Question | Ticket |
|---|---|---|
| Authentication | Who is the caller? (Clerk session → verified identity) | P1-001/P1-002 |
| Account context | Which account is in play, and is the caller an ACTIVE member of it? | P1-005 |
| Row-level security | Which rows may this connection touch? (FORCE RLS as `acbp_app`) | P1-006 |
| **Authorization (`authz.check`)** | **May THIS role perform THIS action?** | **P1-007** |

`authz.check` runs **after** the account is resolved. It mints no scope, opens no transaction, selects no
database connection, bypasses no RLS, and **consults no Clerk org/role claim** — it is a pure decision over an
already-resolved internal role. Removing RLS would not make authz unsafe, and removing authz would not make RLS
unsafe; the isolation (which account) and the role gate (which action) are deliberately separate.

## The decision — deny by default

`authorize(role, action)` (`@acbp/contracts` `authz/authz.ts`) is a pure, zero-dependency matrix:

- `role` is `'owner' | 'viewer'` (MVP; PRD §13) or `null` (no active membership).
- `action` is a member of a **closed set** (`AUTHZ_ACTIONS`). Anything outside it is denied (`unknown_action`).
- Deny-by-default at every branch: `null` role → `not_a_member`; unknown action → `unknown_action`; a role
  not in the action's allow-list → `insufficient_role`. Owner ⊇ viewer is **not** assumed — every allowance
  is listed explicitly, so a newly-added action defaults to denied until it is granted.

### Role → action matrix

| Action | owner | viewer | Notes |
|---|:---:|:---:|---|
| `member:invite` | ✅ | ❌ | invite a new member |
| `member:revoke` | ✅ | ❌ | revoke a membership (last active owner is protected by domain logic) |
| `member:list` | ✅ | ✅ | list members of the account |
| `member:read_invited_email` | ✅ | ❌ | see pending-invite email addresses (viewers get them redacted) |
| `profile:read` | ✅ | ❌ | read the account profile |
| `profile:update` | ✅ | ❌ | edit the account profile |

**Excluded** (not role-gated actions): invite **acceptance** and personal-account **provisioning** are
pre-context bootstrap operations (no active-membership role exists yet — they run through the P1-006 SECURITY
DEFINER functions), and the **Clerk webhook** is signature-authenticated only. None pass through `authz.check`.

## Enforcement — at the trusted core boundary

The **authoritative** enforcement is inside the `@acbp/core` use cases, not the HTTP route. `@acbp/core`
`authz/authz-service.ts` `checkAuthorization(role, action, { accountId, actorId }, { logger })` wraps the pure
matrix and **audits every denial**. Each protected use case resolves the caller's role from the **ACTIVE
membership row under its own AccountScope** (RLS-confined) and calls `checkAuthorization`:

- `membership-service.ts` — invite/revoke/list. The email-redaction consults the matrix via the non-auditing
  `authorize('member:read_invited_email')` (a projection capability, not a request gate).
- `profile.ts` — get/update. The role is loaded under the caller's scope; for a single-owner personal account
  this passes by construction, and it is the uniform enforcement point once accounts admit non-owner members
  (P1-010). Note this is a **net-new** (though behavior-preserving) enforcement point: profile previously had
  no inline role gate — it relied on owner-of-own-account resolution + RLS — so P1-007 adds `authz.check` here
  for uniformity, with an extra RLS-confined role read that will only ever deny once non-owner members exist.

Because enforcement lives in the use case, **a direct use-case call cannot bypass authz** — there is no route
that reaches the mutation without the check. The HTTP routes are thin mappers: on the members surface every
authorization denial maps to a **uniform, opaque `403 { error: 'forbidden' }`** — identical for a viewer, a
non-member, and a deleted identity, so the response is never a role/existence oracle. The transport-neutral
`authorizationDeniedEnvelope()` (`authz` / `AUTHORIZATION_DENIED`, 403) is the equivalent structured envelope
in `@acbp/contracts` for surfaces that emit the full error envelope.

### No request-supplied authority

The acting user id and account are **always** server-resolved (verified session → internal user → the caller's
own account). No role, account id, actor id, header, cookie, or Clerk claim from the request grants or elevates
access. An invite body's `role` is the **invitee's grant**, never the caller's authority. Identity resolution
exposes only the provider user id and verified email — there is no role field in the flow to forge.

### Freshness — revocation and role changes

The role is loaded **fresh on every request** (no caching). A revocation or role change committed between two
requests is reflected on the **next** authorization decision. Within a single request the check and the
mutation run in the same transaction, so the decision is atomic with respect to the work it guards.

## Audit

Every denial emits an interim structured `authz.denied` event (warn) with **non-PII** fields only —
`{ action, reason, accountId, actorId }` — mirroring `tenant.context_denied`; never an email, invite token, or
Clerk identifier. Allows are silent (the criterion is "denials audited"). The public envelope is always the
same opaque 403 regardless of the private reason, so a denial is never a role/membership/existence oracle. The
durable append-only audit store is **ACBP-P1-008**.

## Negative-test coverage per privileged endpoint (acceptance)

Each privileged endpoint has an actual negative REQUEST test, and each role-gated decision is proven at the
trusted core/use-case seam:

- **Members** (`member:invite`/`member:revoke`/`member:list`) — endpoint×principal negative matrix
  (unauthenticated / unverified-email / non-role → denied) plus forged-claim safety in
  `apps/web/src/server/members/members-request.test.ts`; the real role matrix (owner/viewer, cross-account,
  redaction, revocation-immediate, role-change-no-cache) is proven on real PostgreSQL in
  `packages/core/src/members/members.integration.test.ts`.
- **Profile** (`profile:read`/`profile:update`) — endpoint negative REQUEST tests (unauthenticated,
  deleted→forbidden, missing internal-user→not_found, unavailable, validation) in
  `apps/web/src/server/accounts/profile-request.test.ts`; forged body `role`/`accountId` keys dropped and the
  denial→HTTP mapping in `profile-http.test.ts`. An HTTP owner-vs-viewer scenario is **unreachable by product
  construction** — the profile routes always resolve the caller's OWN single-owner personal account — so the
  role-specific negative is proven at the CORE seam: `packages/core/src/accounts/accounts.integration.test.ts`
  seeds a non-owner active membership and asserts `getProfileForOwner`/`updateProfileForOwner` deny opaquely
  (undefined), write nothing, and emit non-PII `authz.denied`. A direct core call (not via the route) still
  enforces. This is NOT asserted from the pure matrix test alone.

## Later additions to the matrix

- **Company-level authorization** and real company roles — **P1-010** (implemented): `company:create` (account
  owner), `company:read`/`company:status` (owner|viewer), `company:rename`/`company:pause`/`company:resume` (owner),
  checked against the caller's fresh company-membership role. **P1-009** adds `activity:read` (owner|viewer company
  member) for the company activity feed. **P1-011** adds `portfolio:read` (owner|viewer ACTIVE ACCOUNT member) —
  an account-level action gating only the `GET /api/companies` portfolio CALL; result rows remain filtered by the
  caller's active COMPANY memberships (an account role never grants a row by itself; CDR-017 §7). There is
  deliberately NO `company:switch` action — switching is stateless URL-only re-resolution, not a role-gated
  operation. **P1-012** adds `provisioning:read` (owner|viewer company member) and `provisioning:resume`
  (company OWNER only — a lifecycle-mutation-class action: it can ultimately activate the company); there is
  deliberately NO start/retry/acknowledge/cancel action (CDR-018 §11). All are pure additions to the
  deny-by-default matrix. **P1-013** registers `admin:tenant_read` with an EMPTY membership allow-list —
  NO account/company role may ever satisfy it. It documents (in the matrix) that platform-admin authority is
  a SEPARATE database-backed gate: a fresh in-transaction `platform_admins` self-check (CDR-019), never a
  branch of the ordinary owner/viewer matrix. Tenant roles, account ownership, and Clerk claims never grant
  it; see `ADMINISTRATIVE-ACCESS.md`.
- **P2-001** adds `interview:read` and `interview:participate`, both `owner|viewer` company members (any active
  member may read the session and start/suspend/resume it — API-CONTRACTS "Company member"). There is
  deliberately NO `interview:confirm` action yet: the owner-only `ready_for_review → confirmed` transition's
  operation belongs to P2-009, which registers that action when it implements the confirmation effect (the
  per-ticket action convention). Pure additions to the deny-by-default matrix; see `INTERVIEW.md`.
- **P2-006** adds `memory:read` and `memory:write`, both `owner|viewer` company members (any active member may
  create a typed memory item and list the company's items — API-CONTRACTS "member (read)"; create is a member
  write). See `MEMORY.md`.
- **P2-010** (memory browser) adds `memory:edit` and `memory:delete`, both **OWNER-only** (API-CONTRACTS "Owner
  (edit/delete)") — DISTINCT closed actions (no overloading): `memory:edit` is the versioned correction
  (supersede), `memory:delete` is the soft delete. Neither is granted to `viewer`, nor to an account owner
  without company membership, nor via forged provider claims. Pure additions to the deny-by-default matrix; see
  `MEMORY.md`.
- **P2-008** (understanding generation) adds `understanding:generate` and `understanding:read`, both
  `owner|viewer` company members (any active member drives the discovery→understanding flow — the generation is a
  member action, like `interview:participate`/`memory:write`). The **owner-only** confirm / per-item review actions
  belong to P2-009 (below). Pure additions to the deny-by-default matrix; see `CDR-029`.
- **P2-009** (understanding review + confirmation) adds `understanding:review` and `understanding:confirm`, both
  **owner-only** (API-CONTRACTS "Owner (confirm)"; UNDER-003 "Owner-only confirm"). `understanding:review` gates the
  five per-item controls (approve/edit/reject/request-evidence/request-research) AND the DISC-008 correction that
  supersedes a confirmation; `understanding:confirm` gates the overall confirm that unlocks strategy. Neither is
  granted to `viewer` (a viewer keeps only `understanding:read`), nor to an account owner without company membership,
  nor via forged provider claims — DISTINCT closed actions (no overloading of the read/generate grant). Pure
  additions to the deny-by-default matrix; see `CDR-030`.
- **P2-007** (context assembly) adds **NO** new authz action: `assembleContext` reads the company's typed memory under
  the existing `memory:read` grant (owner+viewer). The MEM-004 conflict flag + `context.conflict_flagged` audit are
  side effects of that read; there is no separate context permission. See `CDR-032`.
- **P4-002** (task model + state machine) adds `task:create` and `task:read`, both `owner|viewer` company members. A
  task is *proposed* work on the board, not yet executing, so both roles may create/plan/read it; `task:create` also
  covers `planTask` (the `draft → planned` board-appearance transition) and `addTaskDependency` (`task:depend` folds
  into create — CDR-033 §4). The RUN trigger (`planned → queued`, which reserves credit and starts execution) is the
  owner/operator gate and belongs to a later ticket (TASK-004/P6), NOT to either action here. DISTINCT closed actions,
  deny-by-default; not granted to an account owner without company membership nor via forged provider claims. See
  `CDR-033`.
- **P4-005** (task detail + controls) adds ONE action, `task:delete`, `owner|viewer`. Canon scopes TASK-008 to
  "Company-scoped" and says nothing about role, so restricting deletion to the owner would invent a requirement — and
  a member who may create work should be able to withdraw it. The deletion is append-only and audited, so nothing is
  destroyed by the grant. It is a DISTINCT action rather than folded into `task:create` precisely because it is the
  only task control that removes work from view: naming it makes a future owner-only tightening a one-line policy
  change instead of a refactor. REPEAT deliberately adds no action — it mints a task, which is exactly what
  `task:create` already authorizes (the `task:depend` folding precedent). The DETAIL read reuses `task:read`.
  Beyond the role check, `deleteTask` requires an explicit `confirmed: true` parameter (TASK-008 "with confirmation"),
  checked BEFORE the task is read so an unconfirmed call cannot be used as an existence oracle. See `CDR-043`.
- **P3-001** (strategy option generation) adds `strategy:generate` and `strategy:read`, both `owner|viewer` company
  members. Strategy generation is a member action driving the discovery→understanding→strategy flow (like
  `understanding:generate`); `strategy:generate` also covers request-another. Generation is additionally GATED at the
  use-case layer on the owner-confirmed understanding version (UNDER-003 — strategy is blocked pre-confirm); the
  owner-only SELECTION gate (STRAT-003) is P3-004's separate action. DISTINCT closed actions, deny-by-default; not
  granted to an account owner without company membership nor via forged provider claims. See `CDR-034`.
- **P3-003** (comparison + AI recommendation) adds `strategy:recommend`, `owner|viewer`. It triggers the OPTIONAL,
  ADVISORY recommendation over a generation's options (a metered model call). It is advisory only — it NEVER
  auto-selects (STRAT-004) and unlocks nothing; the owner-only SELECTION gate is STRAT-003/P3-004's separate action.
  Consistent with the generate-class grants (`understanding:generate`, `strategy:generate`); the "comparison" read
  reuses `strategy:read`. DISTINCT closed action, deny-by-default; not granted to an account owner without company
  membership nor via forged provider claims. See `CDR-036`.
- **P3-004** (selection / edit / combine / phase-limited approval) adds `strategy:select`, **`owner`-only** — the
  STRAT-003 owner selection gate (the `understanding:confirm` precedent — a viewer may generate and recommend but only
  the owner decides). It authorizes recording the owner's decision (select/edit/combine/reject) over a generation; the
  edit/combine fields are owner-supplied (no model call). request-another reuses `strategy:generate` (`owner|viewer`).
  The decision records a SELECTION only — it neither writes the immutable Decision record (P3-005) nor unlocks planning
  (the P4 boundary). DISTINCT closed action, deny-by-default; not granted to a viewer, an account owner without company
  membership, nor via forged provider claims. See `CDR-037`.
- **P3-005** (immutable decision records) adds `decision:record`, **`owner`-only** — the STRAT-006 / J-08 "Actor: owner"
  gate on writing the durable, audit-grade decision record (the `strategy:select` precedent). It authorizes writing the
  record that links the understanding version + the options considered + the selection + an optional rationale; the
  record and its `decision.recorded` audit are one transaction, so a failed write blocks the transition rather than
  leaving a decision silently unrecorded. Reads reuse `strategy:read` (the decision is surfaced on the strategy read);
  a dedicated Decisions list/get surface is deferred with the strategy HTTP surface (CDR-026 §0). Recording a decision
  does NOT unlock planning — P4-001 gates separately, and on a **non-reject** decision (`decisions.mode <> 'reject'`),
  since a rejection is also recorded (CDR-038 §6-G1). DISTINCT closed action, deny-by-default; not granted to a
  viewer, an account owner without company membership, nor via forged provider claims. See `CDR-038`.
- **P4-001** (goals, roadmap, milestones) adds `roadmap:generate` and `roadmap:read`, both `owner|viewer` (the
  generation-class precedent), and **`roadmap:edit`, `owner`-only** — API-CONTRACTS specifies "Owner (edit)" for the
  versioned roadmap edit, and ROAD-002 records the editing author. Generation is additionally GATED at the use-case
  layer on the company's **latest decision being NON-reject** (`decisions.mode <> 'reject'`; CDR-039 §7-G1) — a
  rejection is also recorded (STRAT-006), so the mere existence of a decision must never unlock planning, and a later
  rejection re-blocks new planning. The edit is version-guarded (editing a superseded version is refused) and runs
  its authorization check BEFORE input validation, so an unauthorized caller learns only `forbidden`. DISTINCT closed
  actions, deny-by-default; not granted to an account owner without company membership nor via forged provider claims.
  See `CDR-039`.
- **P4-003** (task generation + chat steering) adds `task:generate`, `owner|viewer` — the generation-class precedent,
  covering both autonomous planning and steering since both spend metered model budget. The tasks it mints are
  **drafts**, which are not on the board and write no audit; CONFIRMING a draft reuses the existing `task:create` via
  `planTask`, so no new confirm authority is introduced. Generation is additionally GATED on the company's latest
  decision being NON-reject (reusing `classifyPlanningGate`) **and** on a current roadmap existing, and is further
  restricted by the **STRAT-005 phase boundary**: only the approved phase's milestones are plannable, re-checked
  server-side at persist time so an out-of-scope task is refused rather than silently re-pointed. Steering validates
  its request only AFTER the authorization check, so an unauthorized caller learns only `forbidden`. DISTINCT closed
  action, deny-by-default; not granted to an account owner without company membership nor via forged provider claims.
  See `CDR-040`.
- **P5-001a** (durable job enqueue) adds `job:enqueue`, **`owner` only**. Canon does not settle the role here the way
  STRAT-003 settles selection, so this takes the SAFER REVERSIBLE reading the charter requires: widening later is
  additive and breaks nothing, whereas discovering after the fact that viewers have been scheduling background
  execution is not recoverable. It is also different in KIND from the generate-class member actions — those spend
  budget inside the request that authorized them, while a job runs later, on its own, after the authorizing session is
  gone, which is why it gets its own action rather than folding into an existing grant.
  ORDERING NOTE: `enqueueJob` checks TENANT CONTEXT before authorization, and everything else after. That is not an
  exception to the no-oracle rule but a consequence of it — the tenancy check reports only on the shape of ids the
  caller themselves supplied and discloses no platform state, whereas `invalid_kind` or `payload_too_large` would, so
  those stay behind the authz check. Putting tenancy after it was a real defect found in review: `runInCompanyScope`
  denies a blank company id itself, which made the trust-critical "context-stripped job refused" outcome
  indistinguishable from an ordinary `forbidden`. See `CDR-049`.
- **P5-001b** (durable job step execution) adds `job:execute`, **`owner` only**. Its own action rather than folded into
  `job:enqueue`, on the `task:delete` precedent: scheduling work and executing it are different capabilities, and a
  named action makes it a one-line policy change to grant execution to a worker identity that may never enqueue —
  which is exactly what P5-002 will need. See `CDR-050`.
- **P5-002** (workflow coordinator) adds `run:execute` and `run:cancel`, both **`owner` only** today. Two actions, not
  one, and for a sharper reason than the P5-001b precedent: `run:execute` is the WORKER's capability (start, heartbeat,
  finish, and later the worker identity itself), while `run:cancel` is the OWNER's stop decision. A worker able to
  cancel its own run could quietly hide work it had been told to stop, so a single action could not express what is
  needed. API-CONTRACTS puts run control at "Owner/operator". See `CDR-053`.
- **P5-003a** (tool registry) adds NO authz action. The registry is global platform configuration with a SELECT-only
  grant and no runtime write path at all, so there is nothing for a membership role to be authorized to do. See
  `CDR-051`.
- **P5-003b** (tool dispatcher) adds NO authz action either, and that is a decision rather than an omission. A tool
  call happens INSIDE a run's execution, so it reuses `run:execute` — the capability executing a run already needs.
  Per-tool least privilege is the **allowlist's** job (WORK-005, trust-critical #4), and a second, coarser role gate
  would duplicate it while being easier to get wrong: a role check cannot express "this worker may read the web but
  not send mail", which is the whole point of the allowlist. See `CDR-054`.

## What P1-007 does NOT do (later tickets)

- **General policy / approval** enforcement (ADR-009/010) — later.
- **Configurable / custom roles** and a policy-administration surface — later.
- **Durable audit storage** — **P1-008** (implemented for the account-scoped first cut: `membership.invited`/
  `membership.revoked`, in-transaction; see `docs/architecture/AUDIT.md`). The `authz.denied` denial event
  remains an interim structured log — denial persistence is deliberately deferred past P1-008.
