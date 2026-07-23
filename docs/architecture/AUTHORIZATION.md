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
  deny-by-default matrix.

## What P1-007 does NOT do (later tickets)

- **General policy / approval** enforcement (ADR-009/010) — later.
- **Configurable / custom roles** and a policy-administration surface — later.
- **Durable audit storage** — **P1-008** (implemented for the account-scoped first cut: `membership.invited`/
  `membership.revoked`, in-transaction; see `docs/architecture/AUDIT.md`). The `authz.denied` denial event
  remains an interim structured log — denial persistence is deliberately deferred past P1-008.
