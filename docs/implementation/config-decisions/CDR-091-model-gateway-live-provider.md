# CDR-091 — Live model gateway: Anthropic provider + the five numbers CDR-090 left open

**Ticket:** ACBP-API-006 · **Status:** ACCEPTED · **Date:** 2026-08-14
**Supersedes:** the BLOCKED §3.1–§3.5 of [CDR-090](CDR-090-metered-generation-routes.md). Everything
CDR-090 settled (§1 composition, §2 error envelope) stands unchanged.

CDR-090 was written without a provider and deliberately refused to default five numbers. Four are now
ruled by the owner as **PM technical defaults — reversible in one line each**. The fifth, retry policy,
was held to the full bar and is decided here on evidence rather than by default.

---

## §1 — What was actually missing

CDR-090 §1 recorded a verified fact: a search of the composition layer for `gateway` returns **zero**
matches. That is still true. `createClerkIdentityRuntime` builds a database client, a webhook verifier,
an identity reader and a webhook service — and nothing else. All fourteen shipped HTTP routes are
database-only, which is why this never came up.

What *does* exist, and is complete:

- `@acbp/contracts` `model/gateway.ts` — the internal `ModelGatewayRequest`/`ModelGatewayResult` seam,
  the seven-value error taxonomy, per-task-class timeouts and the retry/re-ask ceilings.
- `@acbp/contracts` `adapters/model-provider.ts` — the provider-facing `ModelProvider` port.
- `@acbp/core` `model/model-gateway.ts` — `callModel`: policy pre-check, timeout, bounded retry, bounded
  re-ask, fallback eligibility, normalized errors, fail-closed usage metering.
- `@acbp/adapters` `model/fake-provider.ts` — the only `ModelProvider` implementation that has ever existed.

**So the gap is exactly one thing: a real `ModelProvider`.** The gateway itself is built and tested; it
has simply never had a provider that costs money. This CDR adds `AnthropicModelProvider` in
`@acbp/adapters` (the only package permitted to hold a provider SDK, same rule that confines
`@clerk/backend`) and wires it through the composition layer.

---

## §2 — The four PM defaults (owner-ruled, reversible in one line)

> ### ⚠️ VALIDATION STATUS: §2.1 and §2.2 ARE UNMEASURED ESTIMATES
>
> **No live model call has ever been made from this repository.** The 60s provider timeout and the 90s route
> `maxDuration` below are estimates, not observations — nobody has seen how long a real generation takes.
>
> Three attempts were made on 2026-08-14 and all three failed before reaching the model: no key present; then a
> key the loader could not read (UTF-16 BOM); then an OAuth token the API reported as **revoked**
> (`"OAuth access token has been revoked."`), which is also the wrong credential class for the `x-api-key` path
> this provider uses (see §5).
>
> **Do not wire the routes to these numbers until one real generation is measured.** Concretely, if the observed
> p95 for a 16-field strategy generation lands near 60s, the inner/outer split is too tight and both numbers move;
> if it lands at 10–15s, 60s is generous and 90s may fit deployment edges that it currently rules out. Either way
> the answer is an hour's measurement, not an argument — and this box comes out in the same commit that records
> the number.

### §2.1 — Request timeout: **60s** *(resolves CDR-090 §3.1)*

Generation calls (strategy, roadmap, tasks) are slower than simple completions; 60s gives real headroom
without hanging a request indefinitely.

**Where it goes, and why that matters.** The gateway already enforces a per-task-class deadline —
`TIMEOUT_CLASS_MS.generation` is **120_000**, ratified under IOQ-13. This 60s is the **provider client's**
timeout, i.e. the inner bound. The two are deliberately not equal and the ordering is load-bearing:

> **inner (provider client, 60s) < outer (gateway class deadline, 120s)**

If the inner exceeded the outer, the gateway's `withTimeout` would always fire first, the provider's own
abort would be dead code, and the retry budget would be spent on a deadline that never belonged to the
provider. Reversing them is a one-line change and a silent behavioural inversion, so the ordering is
asserted by a test rather than left to a comment.

CDR-090 §3.1 warned that the four call shapes "will not share a timeout, and assuming they do is the
error to avoid." That warning stands and is **not** resolved by this default: 60s is a single starting
value for all shapes, chosen because no per-shape latency has been measured. Per-shape timeouts remain
open, now blocked on observation rather than on P2-011.

### §2.2 — Route `maxDuration`: **90s**, with a plain statement about the ceiling *(resolves §3.2)*

60s (§2.1) + 30s buffer for the surrounding work — the authz check, context assembly, the DB writes and
the usage-event write that fail-closed metering requires.

**Saying it plainly, as instructed: on several common deployment edges 90s is not achievable.** Vercel's
Hobby tier caps serverless function duration at 60s, which is *below* this value and below the provider
timeout it is meant to exceed — a 60s provider call plus any surrounding work cannot fit. On that edge
the effective behaviour would be a platform kill mid-generation, not a clean timeout, and the money is
already spent when it happens. Pro-tier and Fluid-compute ceilings are higher and do accommodate 90s.

**This repo does not pick the deployment edge** — it is an open `OWNER-ACTION-PACK.md` item. So: the
route declares 90s, and if the chosen edge's ceiling is lower, that is a real constraint to be resolved
by choosing the edge or lowering §2.1, **not** something to paper over by silently capping. A comment at
the declaration says so, and the deployment-edge decision now has a concrete number attached to it.

### §2.3 — Rate limit on generate routes: **5 requests per minute per company** *(resolves §3.3)*

Deliberately NOT the existing read-sized ceiling. CDR-090 §3.3 flagged reusing it as a trap, and the
reasoning is recorded here rather than only the number:

- **Per company, not per account or per IP.** The company is the unit that owns the budget and the unit
  RLS already scopes every generation to. Per-IP would let one company exhaust another's headroom from a
  shared egress; per-account would let one noisy company starve its siblings.
- **Single digits, because every call spends real money.** At Claude Opus 5 rates a strategy generation
  with a large assembled context is a non-trivial per-call cost. Five per minute is roughly a founder
  iterating deliberately — regenerate, read, adjust, regenerate. It is *not* enough for a script.
- **5 rather than 1:** a legitimate user does retry by hand after an unsatisfying generation, and a
  ceiling of 1/min turns ordinary product use into a support ticket.
- **A ceiling is not a budget.** This bounds the *rate* of spend, not the *total*. Nothing here stops a
  company spending five calls a minute all day. Total spend is the credit ledger's job — see §3, which
  finds it unwired.

### §2.4 — Budget exhausted: **402 Payment Required** *(resolves §3.4)*

More semantically correct than reusing 429. The client needs to distinguish "slow down" (429 — the same
request will succeed later, unchanged) from "pay us" (402 — the same request will *never* succeed until
something outside the request changes). Collapsing them tells a client to retry a request that retrying
cannot fix, which is exactly the retry-storm-against-a-wall this repo's bounded-retry discipline exists
to prevent.

Requires a new arm on the request-layer result union; the gateway's existing `budget_exceeded` error
category maps to it. Note this leaves `toErrorCategory` in the contracts layer unchanged — it maps
`budget_exceeded` to `limit_exceeded`, which is the *platform* category, not the HTTP status. The HTTP
mapping is the delivery layer's job and that is where 402 is applied.

---

## §3 — Retry policy: **NO AUTOMATIC RETRY above the gateway** *(resolves §3.5, full bar)*

The owner held this one back from the defaults with a specific instruction: this project shipped and
caught a double-charge bug once (D9), the credit system's idempotency exists because of it, and a retry
on a generate call is a retry on a spend. So the first question is not "how many retries" but "what
exactly gets charged twice."

### §3.1 — What the investigation found

**Q: Does the existing credit-reservation idempotency key cover a retried generate call, or only the
original attempt?**

**A: Neither. It does not cover generate calls at all — because generate calls do not touch the credit
ledger.**

Verified with two independent searches: `reserveCredit`, `settleRun` and `preflightRun` appear **only**
in `credit-service.ts` (their definition) and in that service's own tests. **There is no production
caller anywhere in the repository.** The credit ledger is fully built, migrated (0041), RLS-tested and
real-PG proven — and entirely unwired. `generateStrategyOptions`, `generateRoadmap` and `generateTasks`
never reserve, never settle, and never consult a balance.

The ledger is also keyed to the wrong entity for this path: `credit_transactions.run_id` references a
**task run**. A strategy generation is not a task run. Even fully wired, today's ledger has no row shape
for "a founder generated a strategy."

### §3.2 — So can a retry double-charge?

Two different things are called "a charge," and they must be separated:

| | Can a retry double it? | Why |
|---|---|---|
| **Credit-ledger debit** | **No** | Zero credits move on a generate call. A retry cannot double-debit a ledger the path never touches. |
| **Real provider money** | **Yes** | Anthropic bills every attempt that reaches it, whether or not this repo records it. |

The credit half is safe for an uncomfortable reason — not because an idempotency guarantee holds, but
because **the thing that would enforce it is not connected**. That is not a guarantee to build on. Had
the ledger been wired, the two existing unique indexes would both have applied
(`credit_transactions_reservation_key_uq` on `(account_id, idempotency_key)`, and
`credit_transactions_run_reservation_uq` on `run_id` — the second holding even when a caller supplies a
*fresh* key, which is the stronger structural guard). Neither is reachable from a generate call.

**The owner's rule therefore binds:** *"do not ship a retry that trusts an idempotency guarantee nobody
has proven for this path."* No such guarantee exists for this path. **No automatic retry above the
gateway.** The HTTP route does not retry, and the request layer does not retry.

### §3.3 — The retry layer that already exists, and is honest

The gateway's own bounded retry (`runProvider`, ≤ 2 attempts on `timeout` / `rate_limited` /
`provider_unavailable`) is **not** what this ruling forbids, and it is worth stating why it is sound:

it **accumulates** every attempt's tokens — `usage = addUsage(usage, providerUsage)` — into the **single**
usage event it records. Two attempts that each consumed tokens are metered as the sum, not as the last
one. The meter tells the truth about what was spent.

**One honest limit, pre-existing and not introduced here:** `singleCall` only receives `providerUsage`
when the provider *returned a response*. An attempt that times out client-side contributes **zero**
tokens to the meter, even though the provider may have generated — and billed — a complete response
before the client gave up. That under-counts real spend. It is inherent to a client-side deadline, it
predates this ticket, and it is recorded here rather than fixed, because fixing it needs a provider-side
usage reconciliation this repo has no mechanism for.

### §3.4 — The hazard this ticket would have introduced, and the fix

**The Anthropic SDK retries internally by default: `maxRetries: 2`, on 408/409/429/5xx and connection
errors.** Wiring the client naively puts a third retry layer *inside* `provider.generate()`, invisible to
the gateway:

- The gateway sees **one** call and records **one** usage event carrying only the final attempt's tokens.
  Every SDK-internal retry that consumed tokens is **silently unmetered**.
- It stacks multiplicatively with the gateway's own retry: 3 SDK attempts × 3 gateway attempts = **up to
  9 provider calls**, and up to 9 real charges, for one logical generation.
- It defeats the deliberate design of `runProvider`, whose whole point is that retries are bounded,
  counted, and metered.

**Ruling: `maxRetries: 0` on the Anthropic client. The gateway's bounded retry is the only retry layer in
the system.** This is asserted by a test, not left to a constructor argument nobody re-reads, and it is
mutation-proven: raising it must fail.

### §3.5 — What would have to change to allow retry above the gateway

Recorded so a future ticket does not re-derive it. All three, not any one:

1. The credit ledger is wired to generation calls, with a row shape that fits a generation (not a task run).
2. A generate call carries a caller-stable idempotency key — stable across the retry, not a fresh UUID per
   HTTP request, which would defeat the index entirely.
3. A real-PostgreSQL test proves a replayed generate call produces exactly one debit, mutation-verified.

---

## §4 — Model and composition

- **Model: `claude-opus-5`.** The repo's own guidance is to default to the latest and most capable Claude
  model for AI applications; strategy and roadmap generation is the quality-bearing work this platform
  exists to do, and `TASK_CLASS_POLICY` already marks `generation` fallback-INELIGIBLE precisely because
  quality matters more than availability there.
- **Adaptive thinking** (`thinking: {type: 'adaptive'}`) — Opus 5 runs it by default; stated explicitly so
  the request does not depend on a default that differed one model generation ago.
- **Composition (resolves CDR-090 §1-G2): one gateway per runtime,** memoized exactly as
  `getClerkIdentityRuntime` is. A request-scoped gateway would rebuild an HTTP client per request and
  discard connection reuse; the isolation it buys is not needed for a stateless client.
- **Absent/misconfigured gateway fails CLOSED and startup-visible** (CDR-090 §1-G3, unchanged): the config
  is validated when the runtime is built, not on the first paid call.
- **The API key is a `Secret`** from `@acbp/config`, never logged, never returned, never in an error. The
  trust-critical #15 secret-egress sweep covers every route and would catch a leak of it.

---

## §5 — Credential classes: which token actually works, measured

Anthropic issues more than one kind of credential and they are **not interchangeable**. This cost a round trip
on ACBP-API-006 and is recorded so the next person spends none.

| Credential | Shape | Auth header | Works with this provider? |
|---|---|---|---|
| **API key** (Console) | `sk-ant-api03-…` | `x-api-key` | **Yes** — this is what `AnthropicModelProvider` sends |
| OAuth / environment token (`ant auth login`, `ant auth print-credentials`) | `sk-ant-oat01-…` | `Authorization: Bearer` **plus** `anthropic-beta: oauth-2025-04-20` | **No** — not implemented |

Measured directly against `/v1/messages` with one token, three schemes:

```
x-api-key            -> 401  {"type":"authentication_error","message":"API key is invalid."}
Bearer + oauth beta  -> 401  {"type":"authentication_error","message":"OAuth access token has been revoked."}
Bearer (no beta hdr) -> 401  {"type":"authentication_error","message":"OAuth access token has been revoked."}
```

Two separate lessons in one result. First, **an OAuth token presented as an API key does not report an auth-type
mismatch — it reports `"API key is invalid."`**, which reads as "wrong key" and sends you looking for a typo
rather than at the credential class. Second, the differing message under `Bearer` is what identified the token as
revoked; a single-scheme probe would have left both facts ambiguous.

### ⛔ OWNER RULING 2026-08-14 — OAuth-shaped credentials are OUT OF SCOPE for production use

**Anthropic's own policy restricts OAuth credentials to Claude Code and Claude.ai.** They are therefore not a
sanctioned credential for this product, and this repository will not route them in production regardless of
whether the mechanism works. A production credential here is a Console API key (`sk-ant-api03-…`).

This is a **policy** boundary, not a technical one — the plumbing described below functions as far as it was
ever verified. That distinction matters when reading the rest of this section: the code exists and is tested,
and the ruling says not to rely on it. No further support for routing OAuth credentials is to be built.

**RESOLVED — option 2, owner's decision.** The `authToken` branch is **deleted** and replaced by a typed refusal:
`AnthropicModelProvider` throws `UnsupportedCredentialError` at construction when the configured credential is
`sk-ant-oat…`, with a message naming the policy, citing this section, and saying what IS accepted. Fail closed,
not dead-but-functional — a branch that merely goes unused invites the next reader who discovers it works to
switch it back on.

**The gate runs FIRST, above the injected-client shortcut, and the position is load-bearing.** The first version
sat below it, so passing a `client` — a test seam with nothing to do with credentials — silently skipped the
check. A gate an unrelated option can step around is not a gate. Pinned by mutation M-AP9: moving it back below
that shortcut fails the suite.

Mutation-proven: removing the refusal (M-AP8, killed by 4 tests), moving the gate below the injected-client
shortcut (M-AP9), and leaking the credential into the error message (M-AP10, killed by the security test — the
error carries the credential's CLASS, never its value).

> **A note on how M-AP9 was scored, because it nearly went the other way.** Its first run reported SURVIVED with
> 20/20 green. The mutation had not applied — a here-string that failed to match left the file unchanged, and an
> unmutated file trivially passes. The re-run asserts the gate's index moves from before to after the shortcut
> and that the file's contents actually differ, and only then runs the suite. **A mutation result is worthless
> unless you can show the mutation landed**; a green run from an unapplied mutation looks exactly like a real
> survival and would have been recorded as a coverage gap that does not exist.

### How the credential is handled now

`classifyCredential` still decides by shape, but its `oauth` result now leads to a refusal rather than to a
second auth path. `api_key` is the only class the provider will build a client for, and it builds that client
with `apiKey` alone — `authToken` is never set on any accepted credential, pinned by test so that a future edit
reintroducing it is not silent.

An unrecognised prefix falls back to `api_key`: the only default that survives Anthropic introducing a new
API-key shape, where defaulting to `oauth` would refuse every real key on a rename.

**⚠️ THE SUCCESS PATH REMAINS UNVERIFIED.** No credential of any class has ever completed a call from this
repository. The refusal and the classification are evidence-backed — the measured 401s above — but that a
Console API key *succeeds* is expectation, not observation. The ruling does not resolve this: refusing OAuth
narrows what still needs verifying, it does not verify what remains. See the §2 validation block.

(Mutations M-AP5/6/7, which pinned the deleted routing branch, are superseded by M-AP8/9/10 above.)

### Operator note — writing the key on Windows

`.env.local` is gitignored (`.gitignore:3`, `.env.*`) and is the right home for it. Do **not** create it with
PowerShell's `>>` or `Out-File`: PowerShell 5.1 defaults to **UTF-16 LE**, and a `.env` written that way begins
`FF FE` with a NUL after every character. The demo loader now decodes by BOM, but other tooling will not. Prefer:

```
node -e "require('fs').appendFileSync('.env.local','\nANTHROPIC_API_KEY=sk-ant-api03-…\n')"
```
