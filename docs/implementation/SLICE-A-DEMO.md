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
FORCE RLS. `DATABASE_URL` is removed from the environment before the runtime is built, so it cannot reach the
owner connection even if a fallback were introduced — and after the journey the script inspects the route
runtime's *own* backends in `pg_stat_activity` and fails unless every one of them is `acbp_app`. (The
fixture's connection is checked separately, at startup; the two are not the same client.)

The only seam is `@clerk/nextjs/server`, replaced through a Node module-resolution hook (which also resolves
the `@/…` alias the route modules import through, since a root-level `tsx` process reads neither
`apps/web/tsconfig.json` nor `vitest.config.ts`). The production authentication boundary
`resolveVerifiedIdentity` still executes in full — including the **verified primary email** rule — so ACC-001
is exercised, not bypassed.

## The journey

| # | Step | Requirement |
|---|---|---|
| 1 | Sign in — a verified provider identity is accepted by the real boundary | ACC-001 / ACC-002 |
| 2 | Internal mapping is active — a *precondition*, not evidence (step 8 is the proof) | ACC-002 |
| 3 | Account — a personal account exists with an active owner membership | ACC-002 |
| 4 | Company — created through `POST /api/companies` | COMP-001 |
| 5 | Portfolio lists the new company and nothing foreign | PORT-003 |
| 6 | Switch — the company detail resolves its own context under a fresh scope | PORT-003 |
| 7 | A→B→A switching never carries the previous company's context | PORT-003 |
| 8 | **LIVE DENIAL** — another tenant's company is refused on the same routes, with a bounded `{error}` envelope and no foreign content | NFR-001 |
| 9 | Audit trail — `company.created` under the caller's own tenant, every `actor_id` the internal user the *route* resolved | ACC-002 / NFR-001 |
| 10 | Activity feed — only the four lifecycle events, scoped to the company | NFR-001 |
| 11 | The caller left no audit row inside the other tenant, not even from the denials | NFR-001 |
| 12 | The route runtime's own backends are all `acbp_app` | NFR-001 |

Steps 2, 9 and 11 are worth reading together: the fixture inserts the `users` row itself, so asserting it proves
nothing. What proves the provider identity resolved to *this* internal user is the `actor_id` the route stamps
on the audit trail (step 9). Likewise step 11 asks the falsifiable question — did anything this caller did leave
a mark **inside the other tenant**, the denials included — rather than a filter that cannot be satisfied.

## It runs in CI too

`ci.yml` runs `pnpm run demo:slice-a` as its own step, after the aggregate gate. That is deliberate: the
backlog row's acceptance criterion is *"demo script passes E2E incl. live denial"*, and a script that only ever
ran on one machine is not evidence. Sharing the journey with the CI suite protects the *guarantee*; running the
script in CI protects the *artifact*. The first version of this script, in fact, could not run at all on
Windows — the reviews caught it precisely because nothing was executing it.

## The same journey is a CI guarantee

The steps are implemented once, in `runSliceAJourney` (`@acbp/test-support`), and consumed by **both** this
script and [`slice-a.e2e.integration.test.ts`](../../apps/web/src/server/adversarial/slice-a.e2e.integration.test.ts),
which runs on every pull request with zero skips. The demo therefore cannot drift from the guarantee: if the
journey breaks, CI fails whether or not anyone runs the script.

The CI suite adds what a single happy path cannot prove:

- **ACC-001 negatively** — an *unverified* primary email is refused on both routes with a bounded envelope and
  writes nothing. Without this the suite's ACC-001 claim would survive deletion of the rule it names.
- **The negative set** — every company-scoped route refused for three foreign company ids with bounded
  envelopes and no leaked names or account ids, and the other tenants' data proven untouched.
- **All three creation modes** (COMP-001), with the portfolio then showing exactly the caller's own companies.
- **The runtime's connection role**, observed after it has actually served a request.

## Deferred

**Browser-level E2E is deferred to staging** (CDR-021 §1). It is not skipped silently — it is currently
impossible: the company flows are API-only by owner decision (P1-010 … P1-013 each shipped with no UI and no
SSE), so there are no screens to drive, and driving Clerk's hosted sign-in would require live provider
credentials, which the operating constraints forbid. `TEST-AND-VERIFICATION-STRATEGY.md` places the real
browser run in staging with a real Clerk instance; that remains the plan once screens exist.

No live authenticated acceptance against a production or staging Clerk instance has been performed.
