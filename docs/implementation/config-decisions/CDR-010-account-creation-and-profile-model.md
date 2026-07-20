# CDR-010 — Account Creation and Profile: Model Decisions

1. **ID:** CDR-010
2. **Title:** First-sign-in personal-account provisioning, bootstrap founding-owner link, and account-owned profile
3. **Status:** Accepted
4. **Date:** 2026-07-21
5. **Owner:** Product owner (owner-selected Option A at the P1-003/P1-004 seam)
6. **Source ticket:** ACBP-P1-003
7. **Context:** ADR-022 makes Clerk identity-only and the platform authoritative for account/membership;
   ADR-007 makes internal membership the tenant authority. DATA-ARCHITECTURE models **Account** (A-root:
   `account_id`, lifecycle `active→suspended→closed`, plan/billing refs) as "has Users via Membership;
   owns Companies", and the `account.created` event payload is `{account_id, plan_state}`. The full
   **Membership** model (owner+viewer roles, company-scoped invites, `invited→active→revoked`) is
   explicitly deferred to **ACBP-P1-004** (see CDR-008 #1/#7 and the P1-002 `schema.ts` note). P1-003's
   binding acceptance criterion is *"Account created on first sign-in; profile edits persist."* That
   criterion and the membership deferral are in tension: an account must be locatable per signed-in user
   in P1-003, yet the general user↔account join is P1-004. This CDR records the owner's resolution.
8. **Decisions:**
   1. **Personal account, auto-provisioned on first sign-in.** Exactly one **personal account** is
      provisioned per user, idempotently, the first time that user is present as an authenticated,
      server-verified internal user (i.e. once a `users` mapping exists per P1-002). Provisioning is
      **never** triggered from browser claims or unverified session data.
   2. **Bootstrap founding-owner link (Option A).** The founder is recorded on the account as an
      **immutable** `accounts.created_by_user_id` (FK → `users.id`), with a **unique** constraint
      enforcing the 1:1 personal-account invariant for MVP. "My account" resolves as
      `accounts.created_by_user_id = <current internal user id>`.
   3. **`created_by_user_id` is provenance, never authorization.** It is not a tenant-authority or
      role source. P1-004 introduces the `memberships` table and **backfills a `role='owner'` membership**
      from each account's `created_by_user_id`; thereafter authorization derives from memberships only
      (ADR-022 flow), and `created_by_user_id` remains solely as immutable founding provenance.
   4. **Account is A-root, not company-scoped.** `accounts` carries **no `company_id`** and is **not**
      under company row-level security (company RLS is ACBP-P1-006). Lifecycle status is
      `active | suspended | closed` (DATA-ARCHITECTURE). A `plan_state` column (default `'free'`) matches
      the `account.created` event payload; concrete billing/entitlement is Phase 7 and out of scope here.
   5. **Account-owned profile (1:1).** Platform-owned **mutable** profile fields live on a 1:1
      `account_profiles` table (`account_id` PK/FK → `accounts.id`): MVP fields `display_name` and
      `locale`. Identity-root `users` stays minimal per CDR-008 #4 (no platform-owned mutable profile
      columns added to `users`). "Profile edits persist" = updating `account_profiles`.
   6. **Email is Clerk-authoritative and read-only in the platform profile.** The profile view exposes
      the synced `users.primary_email` + `email_verified` (maintained by P1-002 webhooks/read-through) as
      **read-only**. "Email change re-verification" (ACC-003) is **delegated to Clerk**: an email change is
      performed in Clerk, Clerk performs re-verification, and the change syncs back via the existing
      P1-002 `user.updated` path. P1-003 does **not** mutate email platform-side and therefore needs **no
      Clerk secret at runtime**. An in-app email-change endpoint that calls the Clerk Backend API (which
      would require the Clerk secret + is an external-access concern) is an explicit deferred follow-up.
   7. **Actor from session, never request body.** Every profile mutation resolves the acting user from the
      authenticated session → internal `users` mapping → the caller's own personal account. A client may
      never target another account by supplying an id (invariant: actor/tenant never from the body).
   8. **Idempotent provisioning under races.** First-sign-in provisioning uses an
      `INSERT … ON CONFLICT (created_by_user_id) DO NOTHING` + re-read (mirroring P1-002's
      `insertIfAbsent` race-safety), scoped to the exact unique constraint; unrelated constraint
      violations propagate as sanitized failures, never as a duplicate no-op.
   9. **Interim audit via structured events.** The durable append-only audit store is **ACBP-P1-008**
      (not a P1-003 dependency). P1-003 emits `account.created` and `account.profile_updated` as
      **structured, correlated, redacted** observability events (per ADR-017 / P0-017); P1-008 subsumes
      these into the durable store. P1-003 tests assert the event is emitted with the correct
      (PII-safe) shape, not a durable-store write.
9. **Scope:** `accounts` + `account_profiles` persistence, idempotent first-sign-in provisioning,
   account/profile read + profile update use-cases, the web profile surface, and interim audit events for
   ACBP-P1-003. **Excludes** memberships/roles/invites/company-scoping (P1-004), tenant-context primitives
   (P1-005), row-level security (P1-006), authorization middleware (P1-007), the durable audit store
   (P1-008), account deactivation/deletion (ACC-004/005), billing/entitlement (Phase 7), and any in-app
   email mutation.
10. **Alternatives:** (B) Defer all user↔account linkage to P1-004 and hang the profile off the user —
    rejected by owner: the account created on first sign-in would be orphaned and un-resolvable per user
    in P1-003, failing the acceptance criterion. (C) Create a full `memberships` row (role=owner) in
    P1-003 — rejected: pre-empts the P1-004 membership/role/invite model before its contracts exist.
11. **Security impact:** account is A-root with no cross-tenant exposure; `created_by_user_id` is
    provenance only and never an authz grant; email stays provider-authoritative (no platform email
    mutation, no Clerk secret on the P1-003 path); actor/tenant resolved server-side.
12. **Reliability impact:** idempotent provisioning is safe under concurrent first requests and webhook
    races; the 1:1 unique constraint is the durable guard.
13. **Reversal cost:** Low–Medium — reversible migration; `created_by_user_id` is designed to be
    generalized (not replaced) by P1-004 memberships, so no destructive migration is implied.
14. **Requirement IDs:** ACC-001 (internal account on first sign-in; registration itself is Clerk/ADR-022),
    ACC-003 (profile settings; email re-verification delegated to Clerk).
15. **Governing ADRs / CDRs:** ADR-022, ADR-006, ADR-007, CDR-008 (identity-root boundary it builds on).
16. **Implementation slices:** (1) this CDR + agent state [docs]; (2) `accounts`+`account_profiles`
    migration + schema types + repository + PG integration; (3) provider-neutral account/profile contracts
    + core idempotent provisioning use-case + unit tests; (4) core profile read/update use-case (email
    read-only) + unit tests; (5) web profile API/route + first-sign-in provisioning wiring + tests;
    (6) interim `account.created`/`account.profile_updated` structured-audit events; (7) backlog sync
    (owner-gated).
17. **Review trigger:** ACBP-P1-004 membership backfill (revisit `created_by_user_id` generalization);
    ADR-022 email-change flow decision (if in-app email mutation is later wanted); Phase 7 billing
    (plan_state semantics).
