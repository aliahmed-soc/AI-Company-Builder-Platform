# CDR-087 — HTTP routes for strategy read and decision recording

**Status:** proposed · **Ticket:** ACBP-API-001 (slice 1 of the missing-route programme) ·
**Base:** `main` at `2761e7b` · **Input:** the slice-1 canonical discovery, not re-derived here.

**Number:** 087, not 086. CDR-086 is claimed by ACBP-P3-006 on the unmerged branch
`p3-006-strategy-eval-area`, which is confirmed to exist on the remote. Taking 086 would repeat the
ACBP-P7-013 id collision, where two branches claimed one number and one had to renumber itself
after the fact.

---

## §0 — What this ticket is, and what it deliberately is not

The domain has use cases with no HTTP surface. This slice exposes **three** of them:

| Method + path | Use case | Authz action → roles |
|---|---|---|
| `GET /api/companies/[companyId]/strategy` | `getLatestStrategyGeneration` | `strategy:read` → owner, viewer |
| `POST /api/companies/[companyId]/strategy/selection` | `recordStrategyDecision` | `strategy:select` → **owner only** |
| `POST /api/companies/[companyId]/decisions` | `recordDecision` | `decision:record` → **owner only** |

**All three are pure exposure.** The action exists, the use case exists and is covered by real-
PostgreSQL integration tests, and a `to*DTO` mapper already exists (`toSelectionDTO`,
`toDecisionDTO`, and the generation DTO on the strategy read). **No new authority, no new DTO, no
new database object, no migration.**

### §0.1 — What is deliberately excluded, and why

`POST /strategy` (generate), `POST /strategy/recommendation` and `POST /roadmap` are **NOT in this
slice**, and nothing here scaffolds toward them. `strategy:generate`, `strategy:recommend` and
`roadmap:generate` all include **viewer**, so an HTTP route would give a viewer a path to spend
account budget through a metered model call. That was defensible while only core and tests called
them; a route makes it real. The owner has held them pending a ruling and explicitly declined a
default. **This CDR must not be read as a template for them** — when the ruling lands, the
authorization question is settled in the registry, not by copying this file.

`POST /decisions` is included and `POST /strategy/selection` is included because both are
**owner-only** already. Neither widens what any role can reach.

---

## §1 — The gate decision: the route does not re-check authorization

`recordStrategyDecision` and `recordDecision` enforce owner-only **inside `@acbp/core`**, from the
company role resolved against an active membership. **The route MUST NOT repeat that check.**

This is not a style preference. ACBP-P6-002 shipped a caller-injectable approval port, and it was
deleted because a caller could satisfy a demand the policy engine owned — a second place that can
answer one authorization question is the defect that ticket paid to remove. A route that re-checks
`strategy:select` creates exactly that: two answers, which can disagree after a registry edit, and
the route's copy is the one no test of the registry covers.

**G1.** The route resolves identity and delegates. The refusal comes back as a typed result and is
mapped to a status code. There is no `if (role !== 'owner')` anywhere in `apps/web`.

**G2.** A viewer calling either POST must receive the coarse refusal the domain returns — the same
one a non-member gets. The route does not distinguish, because distinguishing is an oracle.

---

## §2 — `CompanyRuntime` methods stay REQUIRED

Three methods are added to the `CompanyRuntime` interface in
`apps/web/src/server/companies/companies-request.ts`. **None is optional.**

The interface already carries this rule with a reason: `checkRequestLimit` is documented as
"REQUIRED on this interface, never optional … A fake runtime in a test must declare it, so no
surface can be admitted by forgetting it." An optional method defeats that guard silently — a fake
runtime omits it, the surface still compiles, and nothing fails.

**G3.** Every new method is non-optional, and the existing fake runtimes are updated to declare
them. If a fake cannot produce the value, it **throws** rather than returning `undefined` — a
fixture that cannot produce the thing under test must fail loudly (the ACBP-P6-007 lesson: a
fixture returning null hid two emergency-stop scopes enforcing nothing).

---

## §3 — Three build-breaking checks these routes must satisfy

These are not review items. Each fails the build.

**§3.1 Rate limiting (ACBP-P7-013).** Every authenticated route consumes
`checkRequestLimit('session'|'account', key)`. `tools/check-rate-limit-coverage.mjs` fails the build
when a route stops reaching the ceiling. All three routes consume it.

**§3.2 CSRF origin gate (ACBP-P7-014).** Both POSTs are state-changing, so a cross-site unsafe-method
request must be refused **before the session is established**. The gate lives in `apps/web/src/proxy.ts`
and covers a route added later without being edited — so these two are covered by construction, and
`check:csrf-origin-gate` proves it. `GET /strategy` is a safe method and is unaffected.

**§3.3 Security headers (ACBP-P7-015).** The header sweep walks **every** route and page driving the
real proxy. Three new routes join it automatically and must pass.

---

## §4 — The adversarial matrix (ACBP-P1-014)

Every route in this repository joins
`apps/web/src/server/adversarial/http-routes.adversarial.integration.test.ts`, against **real
PostgreSQL**. Three properties per route:

**G4 — cross-company refusal.** A member of company A calling with company B's id is refused, and
**no row moves**. Asserted from the database, not from the response.

**G5 — the oracle property.** A **foreign** company id and an **unknown** company id produce
**byte-identical** status and body. This is the trust-critical #1 property, and the reason it is
stated as byte-identity rather than "both refuse" is that a refusal which differs in shape still
tells an attacker which ids exist.

**G6 — malformed ids never succeed and never leak.** A malformed id yields a bounded envelope whose
only key is `error`, containing no SQLSTATE, no constraint name, no table name, and no company id.

---

## §5 — Failure vocabulary

Each use case's result union maps to a status code in `companies-http.ts`. **A result variant with
no mapping must not fall through to 200** — the mapping is exhaustive over the union, so adding a
variant to core without mapping it is a compile error rather than a silent success.

| Domain result | HTTP | Note |
|---|---|---|
| forbidden / non-member / wrong role | 403 or 404, **identical for foreign and unknown** | G5 |
| not found | same as foreign | G5 |
| validation failure | 400, bounded `PublicErrorEnvelope` | no field echo |
| company not active | 409 | Gate 14 refusal, already a variant |
| rate limited | 429 + `retryAfterSeconds` | §3.1 |
| success | 200 | DTO only, no internal ids |

### §5.1 — `not_found` is a REAL arm here, and it does not break the oracle

Read from the source, not assumed. `RecordStrategyDecisionResult` and `RecordDecisionResult` each
carry **four** arms — `ok`, `forbidden`, `not_found`, `invalid` — unlike `readDecisionRoom`, whose
own comment records that it has *"no `not_found` arm to map: the domain answers an unknown, foreign
and unauthorized company"* identically.

So these two routes cannot simply copy the Decision Room's mapping. The question is whether a
distinct `not_found` re-opens the oracle G5 closes. **It does not, and the reason is the granularity
the two arms speak at:**

- **`forbidden`** is decided at the **company** level, by scope resolution against an active
  membership. A foreign company id and an unknown company id both fail there, both yield
  `forbidden`, and G5 holds at the boundary an attacker actually probes.
- **`not_found`** is decided at the **sub-resource** level — the generation or selection — and the
  decision-record comment says it covers *"absent/**invisible**"*. Invisible is RLS: a selection
  belonging to another company is not visible to this caller and is therefore indistinguishable
  from one that never existed. A foreign selection id and an unknown selection id both yield
  `not_found`.

**G7 — the oracle property is asserted at BOTH granularities, not one.** The adversarial matrix must
cover: (a) foreign company id vs unknown company id → byte-identical, and (b) foreign *selection*
id vs unknown *selection* id, inside a company the caller legitimately holds → byte-identical. Only
(a) was named in §4. Testing (a) alone would leave the sub-resource oracle unproven, and that is the
level at which these two routes actually differ from every route built before them.

**G8 — `not_found` and `forbidden` must not be collapsed into one status code to "be safe."**
Collapsing them would hide a real distinction from a legitimate owner — who is entitled to know that
a selection id is wrong rather than that they lack access — while buying nothing, because each arm
is already non-distinguishing within its own granularity.

---

## §6 — Verification required before this ticket is implementation-complete

1. TDD: each route's test written and **watched to fail** before the handler exists.
2. `pnpm run check` — full suite.
3. Real-PostgreSQL adversarial suite, **zero skips**, covering G4/G5/G6 per route.
4. `check:rate-limit-coverage`, `check:csrf-origin-gate`, the security-headers sweep.
5. **Mutation-test every guard added here**, recording the hosted run id — the standing rule is that
   a guard nobody has tried to break is not evidence.
6. **Two independent review passes** before reporting implementation-complete.
7. Exact-head hosted CI green with zero skips.

Exact-main green with zero skips is required before any branch deletion, which remains an owner
gate.

---

## §7 — Open, and not decided here

- Whether `usage:read` should include viewer (#19) — held.
- The payload-binding preview read path for approvals (#16) — held; not found in the tree, and its
  absence is not established.
- ACBP-P6-002's evaluation point 1 — unresolved, and the reason `POST /tasks` is not in any slice.
