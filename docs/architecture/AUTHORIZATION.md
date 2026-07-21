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
  (P1-010).

Because enforcement lives in the use case, **a direct use-case call cannot bypass authz** — there is no route
that reaches the mutation without the check. The HTTP routes are thin mappers: any `forbidden` becomes the
opaque `authorizationDeniedEnvelope` (`authz` / `AUTHORIZATION_DENIED`, 403).

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

## What P1-007 does NOT do (later tickets)

- **Company-level authorization** and real company roles — **P1-010** (this ticket is account-level only).
- **General policy / approval** enforcement (ADR-009/010) — later.
- **Configurable / custom roles** and a policy-administration surface — later.
- **Durable audit storage** — **P1-008** (P1-007 emits interim structured events only).
