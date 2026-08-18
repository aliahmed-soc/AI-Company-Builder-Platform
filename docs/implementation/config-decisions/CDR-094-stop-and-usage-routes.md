# CDR-094 — reaching the emergency stop and the account usage rollup over HTTP

**Status:** accepted (owner rulings, 2026-08-19) · **Ticket:** ACBP-API-011 · **Base:** `main` at `91b786b`
**Origin:** two `@acbp/core` modules that shipped complete, tested and reachable by nobody. The frontend backlog's
last two blocked rows (ACBP-FE-017 emergency stop, ACBP-FE-018 usage display) are blocked on exactly that.

**Number: 094.** Swept with `git ls-tree` across **all 131 local and remote branches**, not `main` alone — 090 is
claimed by `origin/p8-api-006-cdr`, 091/092 by `origin/p8-api-006-model-gateway`, and 093 by ACBP-API-010, which is
already on `main`. "Highest on `main` plus one" has collided three times in this programme (ACBP-P7-013, and again
on CDR-090/091/092); the sweep is the countermeasure.

---

## §0 — This ticket is EXPOSURE, and the boundary is the whole point

`packages/core/src/stops/index.ts` carries a warning written after an independent review found every stop use case
called by nothing: *"Being exported is not being reachable, and an index that only guards the export list cannot
see the difference."* `packages/core/src/usage/index.ts` carries the companion note that
`rebuildAccountUsageRollup` is *"deliberately reachable from NO API route"*.

So the two modules look alike from the outside and are **not** alike. One is unreachable by oversight; the other is
unreachable by ruling. This ticket routes the first kind and leaves the second, and §3 is where that line is drawn
explicitly so the absence reads as decided rather than overlooked.

## §1 — No authorization lives in the routes or the request layer

Inherited verbatim from CDR-087 §1 and CDR-088 §1. `@acbp/core` decides from the company role resolved against an
active membership; a second place answering the same question is the defect ACBP-P6-002 paid to remove when the
caller-injectable approval port was deleted.

Both actions **already existed** — nothing was invented, which the owner's ruling required be reported rather than
assumed:

| Action | Policy | Registered at | Checked at |
|---|---|---|---|
| `stop:activate` | `['owner']` | `packages/contracts/src/authz/authz.ts:404` | `stop-service.ts:116` |
| `stop:read` | `['owner', 'viewer']` | `packages/contracts/src/authz/authz.ts:410` | `stop-service.ts:574` |
| `usage:read` | account-owner only | `API-CONTRACTS` — *"account rollup = account owner"* | `usage-rollup-service.ts:216` |

## §2 — The stop surface

| Route | Method | Core | Authorization |
|---|---|---|---|
| `/api/companies/{companyId}/stops` | GET | `readStopState` | `stop:read` — owner + viewer |
| `/api/companies/{companyId}/stops` | POST | `activateStop` | `stop:activate` — owner only |

### §2.1 — The honesty signals are forwarded, and that is load-bearing

`readStopState` returns `heldQueueCaveat` and a per-stop `heldQueueCompleteness`. Core's own comments say both are
*"SUPPLIED, NOT ENFORCED. A surface can ignore this field entirely and nothing in the codebase will notice; there
is no surface yet, and no check that one renders it."*

**This ticket creates the first surface that could ignore them.** The queue records what a stop INTERRUPTED, never
everything it covers, so a count shown without the caveat is a floor presented as a total — CDR-072 §0's failure
arriving through a read model. Both travel on the wire, and `stop-surface.test.ts` pins that they do (mutation M2).

### §2.2 — The stop is deliberately NOT metered

`resolveMeteredContext` guards the four generate paths against a per-company ceiling. Wiring it here would mean an
operator whose company had exhausted its generate bucket could be **refused the halt**. A control that stops working
under load is not an emergency control. The session and account ceilings still apply — they are about abuse, not
spend, and they run for every surface in `companies-request.ts`.

### §2.3 — Eleven refusal reasons, three statuses, chosen by reason

`STOP_REFUSAL_REASONS` is one closed union spanning three different kinds of "no", so one status would be wrong for
eight of them. 400 for a malformed request, 404 for a thing that does not exist here (under RLS "not yours" and "not
there" are genuinely one answer), 409 for a state conflict. The reason travels, on the `control_unavailable`
precedent.

`already_active` is the row that matters most: it means the halt you asked for **is already in force**, and it is
the one refusal an operator could misread as a failure to stop. It is 409, and a test asserts no reason maps to 2xx.

### §2.4 — ⚠️ The body is parsed, never validated, and `scope` is forwarded RAW

Two of the seven scopes (`capability`, `integration`) are refused BY NAME as unenforceable (CDR-072 §1-G10). A
boundary that pre-filtered them would replace a specific, actionable refusal with an anonymous 400 — and refusing by
name only works if the name arrives. The route therefore forwards every key untouched, using the **shared bounded
parser** (16 KiB cap, content-type check) rather than a bare `request.json()`: `parseRecommendBody` took that
treatment because it was the route that spends money; this is the route that halts the platform.

## §3 — What is DELIBERATELY NOT ROUTED

### §3.1 — `rebuildAccountUsageRollup` and `reconcileAccountUsageRollup` stay routeless

**This absence is a decision, not an omission.** `CDR-073 §3.2` records whether an account owner may trigger a
rebuild on demand, or whether it is platform-only, as an **open owner question**, and no `usage:rebuild`
authorization action exists for a route to authorize against. Registering one now would encode an answer nobody
gave; routing the rebuild under `usage:read` would hand a maintenance write to anyone who may read a report. Both
functions also RETURN account figures and WRITE, which is a materially different exposure from a reporting read.

The same legibility move as the `runs/{runId}/artifacts` note: the reader who comes looking for the rebuild endpoint
finds the reason it is not here, not silence.

### §3.2 — `clearStop` and `reviewHeldWork` stay routeless, and a stop cannot be lifted through the API

Clearing a stop **opens** ADMIN-002's mandatory confirm-or-discard review. That review is `reviewHeldWork`, which
takes a `heldWorkId` — and **no exported core read produces one.** `StopRepository.listHeld` is called from exactly
one place, privately, inside `clearStop`, to compute a count. So the review is reachable in principle and
un-drivable in practice.

This ticket's first draft closed that with a `listHeldWork` read and was **refused at the owner gate**: adding a
read core does not have is a domain addition, not the exposure this ticket is scoped to. The draft was reverted in
full — no partial door, no scaffolding — because a half-built path is how "exported is not reachable" got its second
life on this very module.

**The consequence, stated rather than softened: a stop raised through this API cannot be lifted through this API.**
Clearing requires a direct core call until the follow-on ticket lands. That is recorded in
`docs/agent/TICKET-held-work-review-surface.md`, in `packages/core/src/stops/index.ts`, and beside the missing
function in `companies-request.ts`, so anyone reaching for it finds the reason.

### §3.3 — Four refusal reasons therefore have no producer

`not_found`, `not_active`, `already_reviewed` and `stop_still_active` are raised only by `clearStop` and
`reviewHeldWork`. Their status mappings exist and are correct; nothing can currently return them. Disclosed here on
the CDR-092 §10 discipline — a mapping that is right and unreachable must not be reported as a working clear path.

## §4 — The usage surface

`GET /api/account/usage?periodStart=YYYY-MM-01` → `readAccountUsageRollup`.

**ACCOUNT-scoped, and there is no account selector on the route at all** — the account is resolved from the
server-verified session, which makes "read another account's spend" unexpressible rather than merely refused. The
`readCreditLedger` review-pass-1 HIGH is the precedent: that function first ran in a COMPANY scope, so it checked the
caller's company-membership role, and a company owner who was only an account VIEWER would have been handed the whole
account's spending. A rollup spans companies by design, so RLS cannot narrow it and the authorization is the only
thing standing between a viewer and the account's total spend.

### §4.1 — `not_computed` is a 200 carrying `null`

Core distinguishes "computed and zero" from "never computed" deliberately, and only the first is safe to show as a
total. A 404 would assert the period does not exist — false, and an error page on a normal first visit. A zeroed body
would report a measurement nobody took. `periodStart` still travels so the client knows which period is absent.

`periodStart` is **required with no default**: defaulting to "this month" would hand a client plausible figures for a
period it never named.

### §4.2 — The denial reason is dropped

`readAccountUsageRollup` can answer `denied` with an `AccountAccessDenialReason`. Echoing it would let a caller
enumerate account state, so `denied` and `forbidden` map to the identical opaque 403. No oracle.

## §5 — Mutation results (run 2026-08-19, all applied and reverted)

Every mutation was applied to a **committed** baseline and reverted with `git checkout --`. On the first attempt that
undo was run against uncommitted work and discarded two files' worth of changes wholesale; the baseline was restored
by hand and committed first. Recorded because the lesson is general: `git checkout --` is not a scoped undo.

| # | Mutation | `AssertionError` |
|---|---|---|
| M1 | `already_active` 409 → 200 | `already_active: expected 200 to be greater than or equal to 400` |
| M2 | drop core's `heldQueueCaveat` | `expected '' to be 'The held-work queue records what this…'` |
| M3 | `not_computed` → zeroed figures | `expected { periodStart: '2026-08-01', …(5) } to be null` |
| M4 | coerce `targetId` with `String()` | `expected "vi.fn()" to be called with … {"targetId": null}` |
| M5 | spread the activation allowlist | `expected [ …(4) ] to deeply equal [ …(3) ]` |

Each killed 1–3 rows, never a whole block — a block going red at once means a fixture threw, not that a claim was
isolated (the ACBP-P7-008 lesson). The `AssertionError` line is quoted, never the test name or the count.

## §6 — ⚠️ What is NOT proven locally, and is owed from hosted CI

**The authorization mutation lives in core and needs real PostgreSQL.** `stop:activate` is enforced at
`stop-service.ts:116`, and the binding evidence is `stop-service.integration.test.ts:122` — *"a VIEWER may not
activate, clear or review — and no row is written by the attempt"*. Local PostgreSQL is unreachable (port 5433
closed, `ACBP_TEST_DATABASE_URL` unset), so **that suite SKIPS here and a skip is not a pass.**

Owed on the exact head, at zero skips:

1. The real-PG stop suite runs rather than skips.
2. The `stop:activate` check deleted from `activateStop` reddens `stop-service.integration.test.ts:122`, with the
   `AssertionError` quoted — the owner's applied-verified bar for the viewer/non-member row.
3. Seeded invisibility for both new reads, to the CDR-093 standard: a foreign account's rollup and a foreign
   company's stop must be proven invisible with the foreign row actually **seeded**, not absent. Disclosed-as-
   unproven is an interim state and not a merge state.

Until 1–3 are green on the exact SHA, this ticket is not done, and no part of §5 should be read as covering them.
