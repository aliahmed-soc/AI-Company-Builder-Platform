# CDR-020 — Tenant-isolation adversarial test suite (ACBP-P1-014)

Status: **Accepted** (owner decisions, 2026-07-24). Governs ACBP-P1-014.
Canon: BACKLOG row ACBP-P1-014 (Type = Testing; NFR-001; ADR-007; deps P1-006/P1-007);
`TEST-AND-VERIFICATION-STRATEGY.md` (trust-critical **#1/#2/#20**; Tenant-isolation layer = "every gate,
100% pass", "none — real stack"); `SECURITY-VERIFICATION-PLAN.md` (tenant isolation = launch gates 1+2);
`MILESTONE-PLAN.md` M1 exit ("cross-company access denied (live adversarial demo)"; "isolation suite 100%
in CI").

## 1. Ticket character

P1-014 is a **test, test-fixture and documentation** ticket. Its deliverable is the suite itself plus the
suite README. It introduces **no product feature, authorization action, event, route, schema change or
migration**.

## 2. Production-fix authority (bounded)

- **Class T** — test/fixture defects: fixed autonomously.
- **Class R** — a narrow implementation bug that violates an **already accepted** invariant: may be fixed
  autonomously ONLY when it requires no schema change, no RLS/grant change, no authorization-matrix change,
  no event change, no public-contract change and no accepted-CDR amendment.
- **Class O** (ambiguous policy / missing canonical rule), **Class M** (needs migration/schema/RLS/grant) and
  **Class A** (broad cross-ticket architectural flaw): **STOP for owner authorization.**

Every T/R fix is recorded with threat id, exploit/reproduction, affected invariant, severity, root cause,
changed files, regression test and exact hosted-CI evidence. A failing isolation test is never made to pass
by weakening its expected result.

## 3. Denial-audit interpretation

The backlog field "Denials audited without existence leaks" is satisfied by proving that the **existing
structured denial logs and the public response envelopes reveal no protected existence details**. P1-014
creates **no durable denial-audit rows**: `authz.denied` / `tenant.context_denied` remain interim structured
logs, deferred by **CDR-014 §5** ("a denial has no business mutation to bundle with; whether denial audits
persist despite rollback is canonically unresolved"). That deferral is unchanged by this ticket.

## 4. Suite architecture

- **One shared two-tenant harness** (test-only) providing accounts A/B, companies A1/A2/B1/B2, owners,
  viewers, outsiders, revoked account and company members, and platform-admin rows seeded through the owner
  fixture path only.
- **Per-domain adversarial suites** over that harness (matching repository convention), all referencing
  **one shared declarative threat inventory** of stable identifiers.
- **Two separately branded clients**: an owner/fixture client (migrations, deterministic seeding, catalog
  inspection ONLY) and a restricted product client (`acbp_app`) for every product assertion. A harness-level
  fail-fast guard makes an adversarial product assertion on a superuser / table-owner / BYPASSRLS / migration
  role impossible to pass silently.
- **Deterministic enumerated selectors only.** No property-based or fuzz dependency; every identifier and
  seed is reproducible.
- **Platform administration is a NEGATIVE-ONLY dimension**: the suite proves the two authority systems cannot
  be confused. Positive admin-read behavior stays in P1-013's existing trust suite (CDR-019).

## 5. RLS predicate-removal proof (seam-free)

RLS must be proven to deny **independently of application filtering** (ADR-007: "app-layer bug alone cannot
cross tenants"). This is proven with **test-only parameterized Kysely/SQL executed as `acbp_app`** that
deliberately omits the tenant predicates. **No production filter-removal seam, switch or export may be
added**; a boundary/source test asserts production contains no filter-disabled path. Test SQL is
parameterized — never string-concatenated.

## 6. CI

All adversarial tests run in the **existing `verify` job on every PR**. The workflow is not split or
otherwise substantively modified. **No retries, no automatic reruns.** Zero-skip is enforced by the existing
preflight. **Total hosted verify duration ceiling: 5 minutes.** If exceeded, the response is to profile and
consolidate fixtures/catalog queries — never to drop threat rows, mark tests optional, move them to a
non-required job, or introduce parallel shared-schema mutation.

## 7. Explicitly out of scope

Migration 0012; any schema/RLS/grant change; authorization semantics; durable denial events; product events,
routes or features; a production filter-removal seam; a property-testing dependency; a fourth SECURITY
DEFINER; weakening FORCE RLS; granting BYPASSRLS; exposing the owner runtime connection; storage-path and
export enumeration (canon assigns those to P5-011/P7-001 — no storage or export subsystem exists in P1);
ACBP-P1-015 slice-A work.
