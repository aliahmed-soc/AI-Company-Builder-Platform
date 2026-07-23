# Tenant-isolation adversarial suite (ACBP-P1-014)

The executable proof of **NFR-001** (tenant isolation) and of trust-critical negative tests **#1**, **#2**
and **#20**. Governed by **CDR-020**; architecture by **ADR-007** (two-layer isolation: application scoping
plus database row-level security, with immutable ownership).

> Status: **in progress** — this README is finalized in Slice 6 with the measured runtime, the full domain
> table and the defect ledger.

## What it proves

| Trust-critical | Statement | Where |
|---|---|---|
| **#1** | Tenant A cannot retrieve Tenant B's company | scope, RLS, product-path and HTTP suites |
| **#2** | Tenant A cannot guess or enumerate Tenant B's artifacts | oracle/enumeration suites (IDs only — storage paths and exports do not exist in P1 and belong to P5-011/P7-001) |
| **#20** | A user cannot obtain elevated authority by altering a provider organization or role value in the client | forged-claim suites, end-to-end through the real request path |

## Threat identifiers

Every test references a stable id from [`threat-inventory.ts`](./threat-inventory.ts) and every failure
title names **threat id + domain + the isolation invariant** — never a bare matrix index. Use
`threatTitle(id, domain)` to build titles; `threat(id)` throws on an unknown id, so a typo can never produce
an unmapped test.

Classes: `scope` · `authz` · `rls` · `transaction` · `oracle` · `audit` · `admin`.

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
outsider                     — real user, no account, no company membership
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
`acbp_app`, `rolsuper = false`, `rolbypassrls = false`, and the role owns no product table. An adversarial
result obtained on the owner connection is never credited. Seeding always happens on the owner client
*before* restricted assertions — production grants are never weakened to make a fixture work.

## Running

```bash
pnpm test
```

Adversarial files are ordinary integration suites: they skip locally when `ACBP_TEST_DATABASE_URL` is unset
and run with **zero skips** in CI (enforced by `tools/ci/preflight.mjs`). To run only this suite:

```bash
npx vitest run packages/core/src/tenancy/adversarial
```

## CI policy

All adversarial tests run in the **existing `verify` job on every PR** — never a separate or optional job.
**No retries and no automatic reruns**: a flaky isolation test is a defect, not a rerun candidate. Total
hosted `verify` duration must stay under **5 minutes**; if it grows, consolidate fixtures and catalog
queries — never drop a threat row or make a test optional.

## Interpreting a failure

The title tells you the threat id, the domain and the invariant that broke. Classify before fixing
(CDR-020 §2): **T** test/fixture defect → fix here; **R** narrow implementation bug restoring an accepted
invariant → fix here within the limits; **O** ambiguous policy, **M** needs migration/schema/RLS/grant
change, **A** broad architectural flaw → **stop for owner authorization**. Never make a failing isolation
test pass by weakening its expected result.

## Denial-audit interpretation

"Denials audited without existence leaks" is proven against the **existing structured denial logs and public
response envelopes**. This suite creates **no durable denial-audit rows**: `authz.denied` and
`tenant.context_denied` remain interim structured logs, deferred by **CDR-014 §5**.

## Exclusions

No product feature, authorization action, event, route, schema change, migration, production
filter-removal seam, or property/fuzz dependency. Storage-path and export enumeration belong to P5-011 /
P7-001. P1-015 (slice-A end-to-end demo) is a separate ticket.

## Adding a domain

Reuse the harness and an existing threat id; add a new id only for a genuinely new attack class. Assert only
your domain's specifics — the platform-wide catalog, role, grant and SECURITY DEFINER pins live once in
[`catalog.adversarial.integration.test.ts`](./catalog.adversarial.integration.test.ts) and must not be
duplicated.
