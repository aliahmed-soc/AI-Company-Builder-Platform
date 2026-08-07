# CDR-082 — HTTP rate limiting at the API layer (ACBP-P7-013)

Governing: **NFR-010** (`REQUIREMENTS.csv:131` — *"OWASP ASVS-aligned controls: input validation, output encoding,
CSRF protection, rate limiting, dependency scanning in CI, and third-party pen review before public beta"*);
**ADR-003** §6/§12 (rate limits are one of the sixteen **beta launch conditions**, mapped there to NFR-010 as the
*"rate limiting / abuse baseline"*); **CDR-008** §8 (the values); `USAGE-AND-BILLING-ARCHITECTURE.md` §3 (the
placement). Raised as a finding by **ACBP-P7-007** (CDR-080 §4), which ruled that NFR-010's absent baseline items
become separate implementation tickets rather than being built inside a verification pass.

> **THE TWO THINGS THAT MAKE THIS TICKET SMALL.** The values were decided on 2026-07-18 and the placement was
> decided in the billing architecture. Neither is a design question here, and inventing either would have been
> the charter violation ("never silently invent a requirement") dressed up as engineering. What was missing was
> not a decision. It was an implementation.

---

## §1 What the investigation established, before any code

Four questions were asked before anything was written, because three of them had answers already in the
repository and the fourth had an answer that forecloses an entire design.

### §1.1 The values are already ruled — CDR-008 §8, Accepted

`CDR-008` (*Interim Usage Caps and Rate Limits*, Accepted 2026-07-18, interim, revisit-bound to the first alpha
telemetry review) lists seven layers. Its **first** layer is this control, verbatim:

> **Technical request limits:** per-session API ceiling 60 req/min sustained, burst 120; per-account 300 req/min.

CDR-008 §20 names its consumer as **ACBP-P6-010 (values)**. P6-010 shipped the *hard cost caps* — the sixth layer,
$5/day and $50/month — and did not touch the first. So the request-limit values have been accepted and
unimplemented for nineteen days. **This ticket invents no number.** All three come from §8 and are re-exported
from `@acbp/config` with the interim label and the revisit trigger attached at the definition, following the
precedent P6-010 set for the cost caps.

### §1.2 The placement is already ruled — USAGE-AND-BILLING-ARCHITECTURE §3

The control table that maps each of ADR-003's pre-beta controls to the component that owns it reads:

> | Rate limits | api layer (per session/account) + gateway (per company) |

That settles the question this ticket was asked to establish — middleware, route handler, or deployment edge —
in favour of the **api layer**, and it settles the key: **per session and per account**. This is a canon finding,
not a preference, and it happens to agree with the two independent arguments below (§3.2, §3.3).

The *gateway (per company)* half is **not this ticket's**. It is the model-call layer, it is keyed on company,
and CDR-075/P6-010 already own that seam. Two limiters, two dimensions, no overlap — see §5.

### §1.3 Clerk covers the auth surface, and only the auth surface

`apps/web/src/app/sign-in/[[...sign-in]]/page.tsx` and its sign-up counterpart render Clerk's hosted `<SignIn/>`
and `<SignUp/>` components. Credential submission therefore goes to **Clerk's Frontend API**, not to any route in
this repository — there is no `/api/sign-in`, and `grep` finds no credential-accepting handler. Clerk applies its
own rate limits at that edge.

**So the predicted answer held: the auth endpoints are covered and the product routes are not.** Every one of the
22 handlers under `apps/web/src/app/api/**` is reachable with a valid session and, before this ticket, had no
frequency bound of any kind.

This has a direct consequence for §7's canon correction, and it is a **narrower** correction than the finding that
prompted this ticket assumed. See §7.

### §1.4 There is no deployment configuration in this repository — so an edge answer is unbuildable

Searched at depth 3, excluding `node_modules`: no `vercel.json`, no `render.yaml`, no `Dockerfile`, no `fly.toml`,
no `*.tf`, no `docker-compose*`, no `Procfile`, no `app.yaml`. There is also **no `middleware.ts`** anywhere in
`apps/web`.

**Recorded as a constraint rather than assumed away, per the ticket brief.** A design that answers "put the rate
limit at the CDN / load balancer / WAF" is not wrong in general and is in fact the right place for the one thing
this control cannot do (§6.1). It is simply **not buildable in this repository today**, because there is no
artefact here in which to express it and nothing that would deploy it. Naming the edge as the answer would have
produced a ticket whose deliverable is a sentence.

---

## §2 The failure this ticket is written against

`ACBP-P7-002` found that pausing a company was **a label, not a control** — five artefacts described a gate that
no production code path read. `ACBP-P6-010` shipped a spend ceiling that **no production caller passes**, and said
so. The same trap is wide open here: a `checkRateLimit` function with a tidy token bucket, a green unit suite and
no call site would satisfy every word of this ticket's title and bound nothing.

**Therefore the acceptance condition of this ticket is enforcement on the real handlers, and the guard against
regression is static.** `tools/check-rate-limit-coverage.mjs` fails the build when a route handler under
`apps/web/src/app/api/**` exports an HTTP method that does not pass through the limiter. A route added next month
cannot silently omit it. This follows the established idiom — `check-stop-port.mjs`, `check-approval-port.mjs`,
`check-migration-drain-loops.mjs`, `check-reset-lists.mjs` — every one of which exists because the same class of
gap shipped once already.

---

## §3 Decisions

### §3.1 State lives in PostgreSQL — table `api_rate_limit_buckets` (migration `0055`)

An in-memory counter is **not a rate limit under more than one instance**; it is a per-process courtesy that
degrades silently and in the attacker's favour exactly when load makes a second instance appear. Since the
deployment topology is unknown (§1.4), assuming one process would be assuming the most convenient fact available.

PostgreSQL is already the system of record, already reached on every one of these requests, and already carries
the comparable machinery (`usage_events`' idempotency key, the credit ledger's reservations). Redis would be a new
external resource — an **owner gate** — for a benefit this ticket cannot yet measure.

The table is **global, not tenant-scoped**: a session bucket must be consultable before any account is resolved
(§3.3), so it carries no `company_id` and no `account_id` FK, following the precedent of the `users` identity-root
mapping in migration `0002`. Its RLS posture and grants are stated in the migration itself.

### §3.2 The bucket is a token bucket, because that is the only shape that holds both of CDR-008's numbers

"60 req/min sustained, **burst 120**" is two numbers about one limit. A fixed 60/min window expresses the sustained
rate and forbids the burst. A fixed 120/min window permits the burst and raises the sustained rate to 120 — double
what was ruled. A sliding 60/min window forbids the burst too.

A **token bucket of capacity 120 refilling at 60/min** is the structure that means exactly what §8 says: a client
may spend up to 120 in one go, and thereafter sustains 60/min. The account limit (300/min) is the same structure
with capacity equal to its rate, since §8 states no separate account burst and inventing one is out of scope.

Tokens are stored as **integer milli-tokens**, never floats — the same discipline the money columns use, and for
the same reason: a fractional refill accumulated in floating point drifts, and a limit that drifts is a limit
nobody can reason about.

**Consumption is one statement.** `INSERT … ON CONFLICT DO UPDATE … RETURNING` computes the refill, decides, and
decrements *inside* the row lock, returning both the verdict and the remaining tokens. A read-then-write pair would
be a lost-update race in which two concurrent requests each observe the same balance and both spend it — precisely
the defect this control exists to prevent, reintroduced in its own implementation.

### §3.3 The key is the server-verified session, then the account — never the IP address

Canon says per session/account (§1.2). Two independent arguments arrive at the same place, and the second is a
security argument this repository has already made elsewhere.

1. **`x-forwarded-for` is browser-controlled.** With no deployment configuration (§1.4) there is no trusted proxy
   and therefore no trustworthy client IP. This repository's standing rule is *"browser-controlled claims never
   authorize"*. An IP-keyed limiter here would be evadable by setting a header — and, worse, **an attacker could
   spend a victim's bucket by forging their address**, converting a protection into a denial-of-service primitive
   aimed at a specific user.
2. **The session id is cryptographically verified and free.** Clerk's `auth()` verifies the session token
   server-side without a network call. The account requires the internal-user resolution the request performs
   anyway.

**Ordering matters and is deliberate.** The session check runs *before* `resolveVerifiedIdentity` reaches
`getBackendUser`, which is a network call to Clerk's Backend API on every protected request. Limiting after that
call would leave the platform's most expensive per-request dependency unbounded — the limiter would be standing
behind the thing most worth protecting. The account check runs after identity resolution, because that is the
earliest point at which the account is known.

**When there is no session id the key falls back to the USER id — never a shared key, never a refusal.** The first
implementation refused outright, reasoning that Clerk does not produce a verified user without a session. Hosted CI
disproved the premise expensively: five real-database route suites stub `auth()` as `{ userId }` alone, and **every
route in them returned 503**. The strict version's real failure mode was therefore not one unmeterable request
refused — it was the whole surface down at once, from a single unexpected provider shape. The user id is the right
fallback precisely because it is **stricter**: every session of one user then shares one bucket, so the ceiling
still binds, and binds harder. A shared constant key would let any caller throttle everyone else; admitting
unmetered would fail open. Recorded as F7 in `P7-013-REVIEW-COVERAGE.md` §2.

**Unauthenticated requests are deliberately NOT metered here, and this is the sharpest limitation in the ticket.**
See §6.1.

---

## §4 Refusal semantics

A refusal is **429** with the existing `PublicErrorEnvelope`. No new status, no new envelope.

`ErrorCodes.RATE_LIMIT_EXCEEDED` already exists and already maps `limit_exceeded → 429`. It is used today for a
*provider* rate limit surfaced from the model gateway; it is the correct code for this too, and the two are
distinguishable by the layer that produced them.

**A finding, recorded rather than fixed here.** `ErrorCodes.USAGE_LIMIT_EXCEEDED` is declared in
`packages/contracts/src/errors.ts:32` and has **zero usages anywhere in the repository**. `CATEGORY_DEFAULTS` maps
no category to it. So a spend-cap refusal (NFR-015) and a request-rate refusal (NFR-010) would both surface as
`RATE_LIMIT_EXCEEDED` — the vocabulary to tell them apart was defined and never wired. That is the "two limiters
disagree" risk the brief asked about, and it is real, but **it is a pre-existing defect on the spend-cap side, not
one this ticket creates**: the spend cap has no HTTP surface at all yet (CDR-075 §4.3 — no production caller passes
`caps`). Changing the meaning of a shared error code on behalf of a caller that does not exist would be a public
API change made speculatively. Recorded in §8 as a proposed follow-up.

**The refusal is not audited as a security event.** `audit_events` is a tenant-scoped, retained record of
authorization-relevant decisions; writing one per throttled request would let an unauthenticated-adjacent flood
drive unbounded audit growth — turning a protection into an amplifier. Throttling is observable through the
counter and the structured log line, neither of which is retained per-tenant.

---

## §5 Interaction with NFR-015 spend caps and `usage_events` — why they cannot disagree

| | This control (NFR-010) | Spend caps (NFR-015 / CDR-075) |
|---|---|---|
| Bounds | **request frequency** | **money** |
| Unit | requests per minute | micros of estimated provider cost |
| Key | session, account | company, account |
| Window | 1 minute (rolling, by refill) | day, month |
| Reads | `api_rate_limit_buckets` | `usage_events` via the ledger |
| Layer | api (`apps/web`) | model gateway (`@acbp/core`) |

They share no key, no window, no unit and no storage. **Neither can be substituted for the other, and this ticket
claims nothing about spend.** A single request can consume an unbounded amount of money (one expensive model call)
and a thousand cheap requests can consume none — which is exactly why ADR-003 lists *hard usage limits* and *rate
limits* as two separate controls of the sixteen.

**`usage_events` is deliberately not written by this control.** A usage event means *the platform did metered
work*; a throttled request did none. Recording refusals there would corrupt the ledger that the spend caps and the
reconciliation job (launch gate 7) read — a rate limiter that inflates the spend figures would make the two
limiters disagree in the one way that matters. This is the risk the brief named, and avoiding it is a decision,
not an omission.

---

## §6 What this control does NOT bound — stated because a limit believed to be wider than it is, is worse than none

### §6.1 It does not bound unauthenticated traffic, and nothing in this repository does

The limiter keys on a verified session (§3.3). A request with no session is rejected by
`resolveVerifiedIdentity` **before** the limiter has a key, so an unauthenticated flood is bounded only by whatever
capacity the (undeclared) deployment has. It is cheap to reject — no Clerk Backend call, no domain work — but it is
not *bounded*.

Metering it would require keying on IP, which §3.3 shows is worse than useless without a trusted proxy, or writing
a database row for every anonymous request, which hands an unauthenticated attacker a write amplifier. **The
correct home for this is the deployment edge, and §1.4 established that this repository has no deployment
configuration in which to put it.** It is named in §8 as an owner decision, not quietly deferred.

### §6.2 It does not bound the Clerk-hosted auth surface

Sign-in and sign-up traffic never reaches this application (§1.3). Clerk's limits apply there and this ticket
neither strengthens nor verifies them. **No test here proves anything about credential stuffing**, and §7 corrects
the canon row that implied otherwise.

### §6.3 It does not bound the webhook route

`/api/webhooks/clerk` has no session by construction; it is authenticated by **signature**. It is excluded from
the coverage checker by name, with the reason recorded there. Rate-limiting a signed webhook sender risks dropping
legitimate identity events, whose loss is a correctness problem (`ACBP-P1-002`'s whole subject), not a safety one.

### §6.4 The burst is per session, so N sessions get N bursts

A single user holding ten valid sessions may burst 10 × 120. The account ceiling (300/min) is what bounds that, and
it is the reason CDR-008 specified two layers rather than one. **An account with more than three actively bursting
sessions is bounded by the account limit, not the session limit** — the same arithmetic property P6-010 recorded
for its 3× account cost ceiling, and it will read as a broken session limit to whoever first tests it with five.

### §6.5 It is a fixed clock-free bucket, not a distributed fair scheduler

Two application instances consuming the same bucket serialize on one row lock. That is correct, and it is also a
contention point under high concurrency on a single key; no load test has been run, and no throughput claim is
made here.

---

## §7 The canon corrections — narrower than the finding assumed, and that matters

`SECURITY-VERIFICATION-PLAN.md:7`, the **Authentication** row, lists as preventive controls: *"Clerk-managed
authn; server-side session verification; rate limits"*, against the threats *"Credential stuffing; session theft"*.

The finding that prompted this ticket read that as canon asserting a control that does not exist. **On
investigation it is more precisely half-true, and correcting it to "absent" would have replaced one wrong sentence
with another.** For the threat that row actually names — *credential stuffing* — the control **does** exist, at
Clerk, because the credential surface is Clerk-hosted (§1.3). What did not exist is any rate limiting on this
application's own routes.

The row is therefore corrected by **attribution**, not deletion: the Clerk-side limit is named as Clerk's, this
ticket's api-layer limit is named as ours, and the gap §6.1 leaves is named as a gap.

**A second row makes the same claim and the finding did not name it.** `REQUIREMENT-TRACEABILITY.csv:2`, the
**ACC-001** row, lists preventive controls *"Email verification; rate limiting"*. Same class, same defect, one
requirement away — and it was found only because the sweep was widened past the row the brief supplied. Corrected
in the same pass. *(This is the guard-coverage lesson from P6-011 applied deliberately: when a class of defect is
found, sweep for the class rather than fixing the instance.)*

The two **NFR-010** rows move from *"Partially covered — scan gates only"* to a statement naming which of the three
absent baseline items this ticket closes (**rate limiting**) and which two remain absent (**CSRF protection**,
**security headers / CSP**). They do **not** move to "Covered": the pen review has still not happened, and two of
the three items are still missing. A row that read "Covered" here would be the exact artefact ACBP-P7-002 and
ACBP-P7-007 both exist to document.

> **Note on merge order.** `ACBP-P7-007` is in flight on an unmerged branch and edits these same rows and this same
> plan line. This ticket branches from `main` and edits `main`'s text; whichever merges second resolves a conflict
> in these four locations. Recorded here so the conflict is expected rather than surprising.

---

## §8 Open — owner decisions this ticket does not take

| | Decision | Why it is not taken here |
|---|---|---|
| §8.1 | **Unauthenticated / pre-session rate limiting** (§6.1) | Needs a deployment edge; §1.4 established there is no deployment configuration in this repository. A new external resource is an owner gate. |
| §8.2 | **CSRF protection** — the second of NFR-010's three absent items | CDR-080 §4's ruling makes it a separate ticket; unaddressed here. |
| §8.3 | **Security headers / CSP** — the third | As above. |
| §8.4 | **Wiring `USAGE_LIMIT_EXCEEDED`** so a spend refusal is distinguishable from a rate refusal (§4) | A public API change on behalf of a caller that does not exist yet (CDR-075 §4.3). Belongs with the ticket that gives spend caps an HTTP surface. |
| §8.5 | **The final values** | CDR-008 is explicitly interim and revisit-bound; **AOQ-14** remains open and needs alpha telemetry that no deployment exists to produce. Unchanged by this ticket. |
| §8.6 | **Bucket retention** | Rows are self-expiring in effect (a full bucket is indistinguishable from no row) but nothing deletes them; a sweep job is a scheduling decision and there is no scheduler. |
