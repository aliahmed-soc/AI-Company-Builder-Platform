# Tenant-isolation adversarial suite (ACBP-P1-014)

The executable proof of **NFR-001** (tenant isolation) and of trust-critical negative tests **#1**, **#2**
and **#20**. Governed by **CDR-020**; architecture by **ADR-007** (two-layer isolation: application scoping
plus database row-level security, with immutable ownership).

**100 adversarial tests across 10 files**, all executing against real PostgreSQL as the restricted
`acbp_app` role, in the existing `verify` job on every pull request, with zero skips.

## What it proves

| Trust-critical | Statement | Where |
|---|---|---|
| **#1** | Tenant A cannot retrieve Tenant B's company | scope, RLS predicate-removal, product-path and HTTP suites |
| **#2** | Tenant A cannot guess or enumerate Tenant B's artifacts | oracle/enumeration assertions (IDs only — storage paths and exports do not exist in P1 and belong to P5-011/P7-001) |
| **#20** | A user cannot obtain elevated authority by altering a provider organization or role value in the client | `http-routes` — forged claims driven end to end through the real stack |

## Suites

| File | Tests | Layer | Covers |
|---|---|---|---|
| `catalog.adversarial` | 30 | database catalog | role attributes/ownership, exactly-3 SECURITY DEFINER by name, ENABLE+FORCE RLS on all 11 tenant tables, exact grants with no other grantee and no grant option, column-UPDATE confinement, append-only proven by execution, policy shape, tamper attempts, no owner `DATABASE_URL` in the web runtime |
| `harness-guard` | 3 | harness | the owner client is REJECTED by `assertRestrictedRole`; the product client is accepted; the two are different roles |
| `scope-establishment` | 11 | repository + resolver | missing/forged/malformed actor, account and company GUCs; mismatched pairs; harvested selectors; denial-log privacy |
| `authority-revocation` | 8 | core use case | revoked account/company membership incl. a revoked company **owner**, invited-not-accepted, stale-between-enumeration-and-enrichment, viewer mutation denial |
| `transaction-scope` | 9 | database + composition | commit/rollback/thrown-error/denial GUC cleanup pinned to the same pooled backend, nested-scope rejection, foreign-company elevation refusal, raw mid-transaction GUC mutation, audit-rollback atomicity |
| `tenancy-concurrency` | 4 | database + core | barrier-interleaved account A/B, company A1/A2 and three-way A1/B1/B2, mixed success/rollback isolation |
| `rls-predicate-removal` | 12 | database | reads and writes with the application tenant predicate **removed entirely**, forged dual-key inserts, tenant reassignment, ON CONFLICT against a foreign row, column-privilege limits, append-only, plus the production no-filter-switch guard |
| `product-paths` | 13 | core use case | cross-account selector substitution on every verb, foreign-vs-unknown byte equality, cursor replay across account and company, provisioning/activity/audit isolation, admin negative-only |
| `http-routes` (apps/web) | 10 | HTTP → core → database | forged Clerk org/role/admin claims end to end (#20), IDOR across every company route, oracle equality through HTTP, bounded denial envelopes, portfolio enumeration, admin negative-only |
| `admin-boundary` (P1-013) | 22 | source | no-impersonation guard, extended here with an LF/CRLF self-test |

## Threat identifiers

Every test references a stable id from [`threat-inventory.ts`](./threat-inventory.ts) and every failure
title names **threat id + domain + the isolation invariant** — never a bare matrix index. Use
`threatTitle(id, domain)` to build titles; `threat(id)` throws on an unknown id, so a typo can never produce
an unmapped test. Classes: `scope` · `authz` · `rls` · `transaction` · `oracle` · `audit` · `admin`.

## Fixture model

[`two-tenant-harness.ts`](./two-tenant-harness.ts) seeds one deterministic world (no randomness, no timing
dependence):

```
account A ── aOwner (owner), aViewer (viewer), aRevoked (revoked)
  ├── company A1  — aOwner (owner), aViewer (viewer), bothCompanies (viewer)
  └── company A2  — aOwner (owner), bothCompanies (viewer), aCompanyRevoked (revoked)
account B ── bOwner (owner), bViewer (viewer)
  ├── company B1
  └── company B2
outsider                     — real user, no account membership, no company membership
platformAdmin / revokedPlatformAdmin — platform_admins rows, seeded via the OWNER client only
```

`bothCompanies` legitimately belongs to **A1 and A2** so cross-company cursor replay is tested by a caller
who genuinely holds authority — just not for that cursor.

## Two clients — and the guard between them

| Client | Purpose | May prove isolation? |
|---|---|---|
| `createOwnerFixtureClient()` | migrations, deterministic seeding, catalog inspection | **No** (superuser in CI; bypasses RLS) |
| `createRestrictedProductClient()` | every product/adversarial assertion, as `acbp_app` | **Yes** |

`assertRestrictedRole(product)` runs in each suite's `beforeAll` and **throws** unless `current_user` is
`acbp_app`, `rolsuper = false`, `rolbypassrls = false`, and the role owns no product table. `harness-guard`
proves the guard works by passing the owner client in on purpose. Seeding always happens on the owner client
*before* restricted assertions — production grants are never weakened to make a fixture work.

## Which key governs which table

Getting this wrong produces tests that assert something the design never claimed. The suite encodes:

- **`accounts`, `account_profiles`, `audit_events`** — account-keyed.
- **`memberships`** — account-keyed **with a self-branch**: with an actor and no account context, the actor's
  OWN row is visible (this is how `acbp_resolve_own_membership` resolves you before context exists). No other
  member is ever revealed.
- **`companies`** — **account**-keyed: every company of the caller's account is visible inside an
  account-or-company scope (that is how the portfolio enumerates candidates). Authority over a *specific*
  company is decided in `@acbp/core` from company membership.
- **`company_memberships`** — account-bound with a self-branch (`company matches OR member_user_id = actor`).
- **`company_profiles`** — company-keyed (joins through the company; carries no `account_id`).
- **`activity_events`, `provisioning_steps`, `company_workspace_areas`** — strictly **dual-keyed**.
- **`platform_admins`** — self-check only; SELECT-only for `acbp_app`.

## Running

```bash
npx vitest run packages/core/src/tenancy/adversarial apps/web/src/server/adversarial
```

Adversarial files are ordinary integration suites: they skip locally when `ACBP_TEST_DATABASE_URL` is unset
and run with **zero skips** in CI (enforced by `tools/ci/preflight.mjs`).

## CI policy and measured runtime

All adversarial tests run in the **existing `verify` job on every PR** — never a separate or optional job.
**No retries and no automatic reruns**: a flaky isolation test is a defect, not a rerun candidate.

Measured hosted `verify` duration: **2m28s → 2m43s** across Slices 1–5 (ceiling **5 minutes**). If it grows,
consolidate fixtures and catalog queries — never drop a threat row or make a test optional.

## Interpreting a failure

The title tells you the threat id, the domain and the invariant that broke. Classify before fixing
(CDR-020 §2): **T** test/fixture defect → fix here; **R** narrow implementation bug restoring an accepted
invariant → fix here within the limits; **O** ambiguous policy, **M** needs migration/schema/RLS/grant
change, **A** broad architectural flaw → **stop for owner authorization**. Never make a failing isolation
test pass by weakening its expected result. The defect ledger is
[`docs/implementation/P1-014-DEFECT-LEDGER.md`](../../../../../docs/implementation/P1-014-DEFECT-LEDGER.md).

## Denial-audit interpretation

"Denials audited without existence leaks" is proven against the **existing structured denial logs and public
response envelopes**. This suite creates **no durable denial-audit rows**: `authz.denied` and
`tenant.context_denied` remain interim structured logs, deferred by **CDR-014 §5**.

## Malformed-identifier policy

Malformed (non-empty, non-UUID) selectors may answer with the existing **bounded** validation/internal
response rather than the coarse denial. Well-formed foreign, unknown and mismatched ids remain protected by
opaque, byte-identical authority behavior. What is asserted for malformed ids: the protected callback never
runs, no data is returned, and no SQL, table, constraint, connection, tenant or existence detail leaks.

## Exclusions

No product feature, authorization action, event, route, schema change, migration, production
filter-removal seam, or property/fuzz dependency. Storage-path and export enumeration belong to P5-011 /
P7-001. P1-015 (slice-A end-to-end demo) is a separate ticket.

## Adding a domain

Reuse the harness and an existing threat id; add a new id only for a genuinely new attack class. Assert only
your domain's specifics — the platform-wide catalog, role, grant and SECURITY DEFINER pins live once in
[`catalog.adversarial.integration.test.ts`](./catalog.adversarial.integration.test.ts) and must not be
duplicated. A suite that needs BOTH web routes and a database fixture belongs in `apps/web` (test files are
exempt from the outward-import rule; production files are not) so the route modules and the Clerk SDK resolve
exactly as they do in production.
