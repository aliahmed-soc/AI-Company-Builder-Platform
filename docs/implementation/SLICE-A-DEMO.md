# Slice A demo — secure company creation (ACBP-P1-015)

The executable proof of the **M1 exit criterion**: *"User signs in → internal account created → creates
company → switches companies → cross-company access denied (live adversarial demo)"*
(`MILESTONE-PLAN.md` M1). Governed by **CDR-021**; requirements **ACC-001, ACC-002, COMP-001, PORT-003,
NFR-001**; ADR-007 and ADR-022.

## Run it

```bash
pnpm demo:slice-a
```

Requires `ACBP_TEST_DATABASE_URL` pointing at a **disposable** PostgreSQL (the same database the integration
suites use — the script drops and recreates the schema). It uses **no production credentials** and never
contacts a live Clerk instance. Exit code `0` = every step passed, including the closing denial; `1` = a step
failed (each is printed with its evidence); `2` = the database URL was not configured.

## What runs

Everything below the provider-SDK edge is production code: the **real Next route handlers**, the composed
`ClerkIdentityRuntime`, `@acbp/core`, `@acbp/database`, and the **restricted `acbp_app` connection** under
FORCE RLS. The script asserts that connection's role before starting, and removes `DATABASE_URL` from the
environment so the runtime cannot reach the owner connection even if a fallback were introduced.

The only seam is `@clerk/nextjs/server`, replaced through a Node module-resolution hook. The production
authentication boundary `resolveVerifiedIdentity` still executes in full — including the **verified primary
email** rule — so ACC-001 is exercised, not bypassed.

## The journey

| # | Step | Requirement |
|---|---|---|
| 1 | Sign in — a verified provider identity is accepted by the real boundary | ACC-001 / ACC-002 |
| 2 | Internal mapping — the provider identity resolves to an active internal user | ACC-002 |
| 3 | Account — a personal account exists with an active owner membership | ACC-002 |
| 4 | Company — created through `POST /api/companies` | COMP-001 |
| 5 | Portfolio lists the new company and nothing foreign | PORT-003 |
| 6 | Switch — the company detail resolves its own context under a fresh scope | PORT-003 |
| 7 | **LIVE DENIAL** — another tenant's company is refused on the same routes, with no foreign content in the body | NFR-001 |
| 8 | Audit trail — `company.created` recorded under the caller's own tenant | NFR-001 |
| 9 | Activity feed — only the four lifecycle events, scoped to the company | NFR-001 |
| 10 | No trail attributed to the other tenant | NFR-001 |

## The same journey is a CI guarantee

The steps are implemented once, in `runSliceAJourney` (`@acbp/test-support`), and consumed by **both** this
script and [`slice-a.e2e.integration.test.ts`](../../apps/web/src/server/adversarial/slice-a.e2e.integration.test.ts),
which runs on every pull request with zero skips. The demo therefore cannot drift from the guarantee: if the
journey breaks, CI fails whether or not anyone runs the script.

The CI suite adds the **negative set**: every company-scoped route refused for three foreign company ids with
bounded envelopes and no leaked names or account ids, the other tenants' data proven untouched, and all three
creation modes (COMP-001) completing with the portfolio showing exactly the caller's own companies.

## Deferred

**Browser-level E2E is deferred to staging** (CDR-021 §1). It is not skipped silently — it is currently
impossible: the company flows are API-only by owner decision (P1-010 … P1-013 each shipped with no UI and no
SSE), so there are no screens to drive, and driving Clerk's hosted sign-in would require live provider
credentials, which the operating constraints forbid. `TEST-AND-VERIFICATION-STRATEGY.md` places the real
browser run in staging with a real Clerk instance; that remains the plan once screens exist.

No live authenticated acceptance against a production or staging Clerk instance has been performed.
