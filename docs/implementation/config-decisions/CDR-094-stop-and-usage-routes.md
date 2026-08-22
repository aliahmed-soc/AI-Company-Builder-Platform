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

1. ~~The real-PG stop suite runs rather than skips.~~ **MET.** CI run `32193687297` on head `c86b5a3` completed
   **success at 316/316 test files with no skip segment** — the real-PG suites ran. Local skips were an artefact of
   an unreachable local database, not of the code.
2. ~~The `stop:activate` check reddens the viewer test.~~ **MET — see §6.1.**
3. ~~Seeded invisibility for both new reads.~~ **MET.** Run `32197980520` on `6122d7e`: success, **316/316 test
   files, no skip segment**. Both proofs executed, verified by count delta rather than by the log line that
   produced the claim — `usage-rollup-service.integration.test.ts` went **11 → 12** tests and
   `stop-service.integration.test.ts` **35 → 36**, both files green. (Vitest prints per-test lines only for slow
   tests, so the usage proof's absence from the log was not evidence either way; the delta is.)

**Owner ruling 2026-08-19: 2 and 3 land BEFORE this PR merges.** Both now have hosted, zero-skip evidence.

### §6.1 — The applied authz mutation, and the two runs that proved nothing first

**THE PROOF.** Probe branch `p8-mut-api011-stop-authz` (`9f8a426`), run **32199539213**, real PostgreSQL:

```
AssertionError: expected { status: 'ok', …(5) } to deeply equal { status: 'forbidden' }
- Expected
+ Received
  {
-   "status": "forbidden",
+   "heldCount": 2,
+   "pausedCount": 1,
+   "scope": "account_wide",
+   "status": "ok",
+   "stopId": "043fb786-cc04-4800-9c4c-42545266858d",
+   "stopRequestedCount": 1,
  }
 ❯ packages/core/src/stops/stop-service.integration.test.ts:124:79
```

Read the RECEIVED side rather than the status alone: with the check weakened, a **viewer halted the platform**. A
real stop row exists, 2 tasks were held, 1 was transitioned `running → paused`, and 1 live run was asked to
safe-stop. The refusal is the only thing between a viewer and that, and nothing in the route or request layer
duplicates it (CDR-087 §1).

**THE MUTATION SHAPE MATTERS, and the first attempt got it wrong.** `'stop:activate'` → `'stop:read'`, not a
deletion — because `stop:activate` maps to `['owner']` and `stop:read` to `['owner','viewer']`
(`packages/contracts/src/authz/authz.ts:404`, `:410`), so a viewer passes a check that must refuse them, while
`role` stays referenced.

**TWO EARLIER RUNS PROVED NOTHING AND ARE RECORDED RATHER THAN QUIETLY REPLACED:**

| Run | Result | Why it was not evidence |
|---|---|---|
| `32197163447` (`3154b34`) | failure | The check was DELETED, making `role` unused: `115:19 error 'role' is defined but never used`. Lint runs before tests in the aggregate gate, so the suite never executed. **Zero AssertionError lines.** |
| `32198073763` (`9f8a426`) | cancelled | `ci.yml:32` sets `concurrency: group: ci-…-${{ github.ref }}` with `cancel-in-progress: true`. Lint was clean, but the run never finished. |

Both would have been reported as "the probe went red" by anything that reads the conclusion instead of the log.
A `cancelled` run reports `status: completed`, and `gh run watch --exit-status` returns 1 for a cancel exactly as
it does for a genuine failure. **This is the third time on this programme that a red exit code was mistaken for
evidence** — the standing rule is to quote the `AssertionError` line, never the count, the test name, or the exit
code, and it was re-learned here rather than applied.

The probe branch is KEPT, not deleted, on the ACBP-P7-008 precedent: the branch is what makes the run id
reproducible, and each probe branch IS a run id's evidence. It must never be merged.

---

## §7 — The "visible at startup" claim was the ruling's intent, not the behaviour

Two comments asserted that a missing or unparseable `ANTHROPIC_API_KEY` is surfaced **at startup**:

- `apps/web/src/server/webhooks/clerk-runtime.ts` — *"Parsed HERE, at composition, so a missing or unparseable
  ANTHROPIC_API_KEY is visible at startup — the property CDR-090 §1-G3 asked for."*
- `packages/config/src/index.ts` — *"THROWS when the key is absent — deliberately, and at STARTUP rather than on
  the first paid call."*

**CDR-090 §1-G3 did ask for startup visibility, and the code does not deliver it.** `getClerkIdentityRuntime` is a
lazy module singleton, every consumer outside the Clerk webhook route reaches it through a request-scoped
`await import('../webhooks/clerk-runtime.js')`, and there is **no `instrumentation.ts` anywhere under `apps/web`**
(enumerated, not globbed). Nothing runs the parse at boot, so `model_provider.not_configured` fires on the FIRST
REQUEST that touches the runtime.

The consequence is operational and small but real: starting the dev server tells an operator nothing about whether
the key is usable, and a misconfiguration surfaces at the first generate attempt.

**Both comments are corrected in this ticket** to describe first-request firing and to separate the two claims that
were being conflated. `parseModelProviderConfig` throwing unconditionally is a guarantee it makes and keeps; "an
operator sees it at boot" is a guarantee nothing currently makes, and it belongs to the composition path rather
than to the parser.

**Whether an instrumentation hook should restore true startup visibility is OPEN and deliberately NOT built here**
(owner ruling 2026-08-19). Filed as **ACBP-API-012** in `docs/implementation/API-BACKLOG.csv`, with the acceptance
bar written as *a test proves it, not a comment asserting it* — because this row exists precisely because prose
claimed a property the code did not have. No scaffolding toward it exists in this branch.

> **RESOLVED 2026-08-22 by ACBP-API-012.** The paragraph above is left as written because it is an accurate
> record of what was true when this CDR was accepted. It is no longer current: `apps/web/src/instrumentation.ts`
> now runs at boot and reports through `apps/web/src/server/startup/model-provider-report.ts`, which
> `clerk-runtime.ts` shares so the boot line and the composition line have one definition. The acceptance bar was
> met on its own terms — `instrumentation.test.ts` drives `register()` rather than asserting anything about it,
> and states the boundary it cannot cross: it proves this repository's half, not that Next.js calls `register()`,
> which is the framework's contract.

This is the third time on this programme that a comment has stated an intended property as an achieved one
(ACBP-P6-007's stop scopes, ACBP-P7-002's company pause, and now this). The pattern is not a documentation
problem: a claim that cannot be pointed at an enforcer is a claim that will be believed until something expensive
disproves it.
