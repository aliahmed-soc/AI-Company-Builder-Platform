# ACBP-P7-013 — review and mutation coverage ledger

Ticket: HTTP rate limiting (CDR-082; NFR-010; CDR-008 §8). Branch `p7-013-http-rate-limiting`.

---

## §1 The mutation probe — PRESERVED, because the last one was not

ACBP-P7-002's probe branch measured "8 of the then-17 cases went red" and **was not preserved and cited no CI
run**, so nobody can re-derive the figure (PROJECT-STATE records this as a caveat that ticket owns). ACBP-P6-006
did better by at least recording its probe commit and run id.

**This probe is reproducible from the table below without a branch**, which is a stronger form of preservation
than a commit that later gets deleted: each row names the exact source edit, and re-applying it by hand
reproduces the count. Every mutation was applied to `apps/web/src/server/auth/verified-identity.ts`, run against
`verified-identity.test.ts` (16 cases), and then reverted; the file was confirmed to contain zero `MUTATED`
markers afterwards and the suite returned to 16/16.

| # | Mutation | Red | Kills |
|---|---|---|---|
| **M1** | Delete the line `if (limit.kind === 'throttled') return { status: 'rate_limited', … }` — the limiter still runs, its verdict is discarded | **2 / 16** | The gate itself. This is the ACBP-P7-002 shape: a control that executes and decides nothing. |
| **M2** | Pass `userId` instead of `sessionId` to `checkSessionLimit` | **1 / 16** | The keying. CDR-008 §8 rules a per-SESSION ceiling; collapsing it onto the user is a silent departure from an accepted decision (a stricter one, which is still not the one that was ruled). |
| **M3** | Return `rate_limited` instead of `unavailable` for `limit.kind === 'unavailable'` | **1 / 16** | The distinction between *"you are sending too many requests"* and *"we could not tell"* (CDR-076's rule about `0` versus `could not count`). |
| **M4** | Move the whole gate below the `getBackendUser` call | **11 / 16** | The ORDERING (CDR-082 §3.3). The large blast radius is the point: the limiter sits in the middle of the identity path, so moving it disturbs most of the surrounding behaviour rather than one assertion. |

**Baseline before and after: 16 / 16 passing, 0 mutations resident.**

### §1.1 The static guard was probed too

A guard that cannot fail is worse than no guard, and this repository has shipped one before
(`check-reset-lists.mjs`'s original "any one list passes the file" rule). `tools/check-rate-limit-coverage.mjs`
was probed by adding `apps/web/src/app/api/__probe/route.ts` exporting a bare `GET` that reaches nothing:

```
✖ rate-limit coverage check FAILED — 1 problem(s).
  apps/web/src/app/api/__probe/route.ts
    exports GET but never reaches the enforcement point.
```

The probe route was removed. The checker additionally **fails on zero handlers found** and **fails on a stale
EXEMPT entry**, so it cannot quietly degrade into measuring an empty set or carrying an excuse for a route that
no longer exists.

---

## §2 Findings made during the ticket, by me, against my own work

| | Finding | Where it landed |
|---|---|---|
| **F1** | **I wrote a canon correction claiming the ACCOUNT ceiling was enforced when only the SESSION ceiling was wired.** Caught on re-reading the sentence against the code. This is exactly the reachable-but-unwired shape of P6-010's `caps` and P6-011's usage key — and I had written the CDR §2 section warning about it. Fixed by WIRING the account ceiling rather than by softening the sentence, because the ticket's own standard is a control rather than a label. | `companies-request.ts`, `members-request.ts`, `profile-request.ts` |
| **F2** | **`genericErrorBody(429)` returned `internal_error`.** A throttled caller would have been told their request FAILED when it was REFUSED — and the correct client behaviour differs between those (retry after waiting, versus do not retry). | `webhooks/http.ts` |
| **F3** | **The finding that opened this ticket was overstated, and repeating it would have replaced one wrong sentence with another.** The SECURITY-VERIFICATION-PLAN Authentication row names *credential stuffing*, and that surface IS rate limited — by Clerk, because sign-in/sign-up are Clerk-hosted components. The row's defect is a missing ATTRIBUTION, not a missing control. | CDR-082 §7; the plan's note ⓐ |
| **F4** | **A second row made the same claim and the brief did not name it** — `REQUIREMENT-TRACEABILITY.csv`'s **ACC-001** row lists "Email verification; rate limiting". Found by sweeping for the defect CLASS rather than fixing the named instance (the P6-011 guard-coverage lesson). | ACC-001 row |
| **F5** | **`ErrorCodes.USAGE_LIMIT_EXCEEDED` is declared and has zero usages repository-wide**, so a spend-cap refusal and a request-rate refusal would both surface as `RATE_LIMIT_EXCEEDED`. Recorded rather than fixed: the spend cap has no HTTP surface at all yet (CDR-075 §4.3), and changing a shared public error code for a caller that does not exist is a speculative API change. | CDR-082 §4, §8.4 |
| **F7** | **THE ONE HOSTED CI FOUND, AND LOCAL VERIFICATION STRUCTURALLY COULD NOT.** The first version treated a missing session id as fail-closed, reasoning that Clerk never returns a `userId` without a `sessionId`. Hosted run [`31119231280`](https://github.com/aliahmed-soc/AI-Company-Builder-Platform/actions/runs/31119231280) on `81bbda6` came back **27 failed, every one a `503`** — five real-database route suites stub `auth()` as `{ userId }` alone, so **the strict version's actual failure mode was not one unmeterable request refused, it was every route on the surface down at once, from a single unexpected provider shape.** Fixed by falling back to the **user id**, which is *stricter* (all of one user's sessions share a bucket) rather than looser — never a shared key, never an outage, never unmetered. Three regression cases added, and the five stubs now carry a `sessionId` so they exercise the primary path. **This is the whole argument for the zero-skip hosted requirement**: those suites skip locally, so no amount of local green could have found it. | `verified-identity.ts`; `verified-identity.test.ts` |
| **F6** | **The bulk reset-list edit touched 75 array literals for 65 drop lists.** The extra ten were inspected individually rather than assumed benign; all were `const ALL = [...]` table lists or drop loops, plus one genuine assertion list (`provisioning.integration.test.ts`'s DELETE/TRUNCATE denial test) where including the new table is correct AND valuable — migration 0055 grants no DELETE, so the assertion holds and pins that decision. | verified, no change needed |

---

## §3 What this ticket does NOT prove

Stated here as well as in CDR-082 §6, because a limitation recorded only in a decision record is a limitation
whoever reads the tests will not see.

1. **Nothing here proves anything about credential stuffing.** That surface is Clerk's (§F3).
2. **Unauthenticated traffic is bounded by nothing in this repository.** There is no key to meter and no trusted
   proxy from which to take one; the correct home is a deployment edge and there is no deployment configuration
   in this repository at all. Pinned by a test asserting the stated behaviour so the gap cannot close by accident
   and go unrecorded — but a pinned gap is still a gap.
3. **No throughput or load claim is made.** Concurrent consumers on one key serialize on a row lock; that is
   correct and it is also a contention point. No load test was run.
4. **The real-PostgreSQL suite did not execute locally** — `ACBP_TEST_DATABASE_URL` is unset on this machine, so
   `describe.skipIf` skipped it. **A skipped suite is not a green one.** Hosted CI on the exact SHA, with zero
   skips, is the only evidence that the SQL bucket arithmetic agrees with the specification and that the
   concurrency assertions hold.
