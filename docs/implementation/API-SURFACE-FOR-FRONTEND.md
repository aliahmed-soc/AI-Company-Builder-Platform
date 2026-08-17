# API surface available to a first pass of frontend screens

**Status:** inventory, not a design. **Compiled:** 2026-08-17. **Scope:** every HTTP route under
`apps/web/src/app/api` that a signed-in user's browser would call, grouped by the screen it would serve. The
only route deliberately omitted is `POST /api/webhooks/clerk`, which is a provider-to-server webhook and has no
frontend caller.

This document exists so that frontend work starts from the shapes the server actually returns rather than from
shapes someone assumed. It is deliberately as clear about what is **missing** as about what is present: three of
the six screens named in the request cannot be built end-to-end today, and the reason differs for each.

No UI work is authorized by this document. Design direction is the owner's (`AGENTS.md` §1); this is the
inventory a design conversation would need in front of it.

---

## 0. How to read this

Every route below shares the same envelope, so it is stated once rather than forty times.

**Every route is `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.**

**Most, but not all, routes reject unknown query parameters** with `400 {"error":"bad_request"}` rather than
ignoring them — an approver who believes a filter is applied while seeing everything is a worse failure than an
error. Twenty-three of the thirty-five routes carry that gate. The rest never read the query string at all, and
four of them (`pause`, `resume`, `GET /api/account/members`, `GET /api/account/profile`) are declared without a
`Request` parameter, so they could not inspect it if they wanted to. Do not rely on an unknown parameter being
rejected; rely on it being meaningless.

**Failures every authenticated route can return, before its own logic runs:**

| Status | Body | Meaning for the UI |
|---|---|---|
| 401 | `{"error":"unauthorized"}` | No valid session. Send to sign-in. |
| 403 | `{"error":"email_unverified"}` | Signed in, email not verified. This is its own screen state. |
| 403 | `{"error":"forbidden"}` | Not permitted. **Deliberately indistinguishable** from "no such company" — do not try to tell a founder which one it was, the server will not tell you either. |
| 404 | `{"error":"not_found"}` | The named child resource does not exist. |
| 429 | opaque envelope + `Retry-After` | Request ceiling. The header is the only usable number; no balance or limit is disclosed. |
| 503 | `{"error":"unavailable"}` | A dependency is down. Retryable. |
| 500 | `{"error":"internal_error"}` | Bounded catch-all. Never carries detail. |

**Write routes are of two kinds, and it matters.** The ones that go through the shared parsers in
`companies-http.ts` (company create and rename, interview answer, memory create and edit, account profile,
member invite) enforce a 16 KiB body cap with **413** over it and **415** for a non-JSON content type, and
return domain validation failures as **400** with a `PublicErrorEnvelope` nested at `body.error`
(`{category, code, message, retryable, correlationId?}`).

The ones with a hand-rolled parser — `decisions`, `roadmap/edit`, `strategy/selection`, `tasks/{id}/delete`, and
`strategy/recommend` on the branch — call `request.json()` directly. They have **no size cap and no
content-type check**, and a malformed body is a flat **400** `{"error":"bad_request"}` rather than an envelope.
This is an inconsistency in the server, not in this document; a client cannot assume one shape.

**Roles.** Every company has `owner` and `viewer` members. Reads are almost all `owner + viewer`; writes are
almost all `owner`. The per-route role is stated below and comes from the `POLICY` matrix in
`packages/contracts/src/authz/authz.ts`. Authorization is enforced in `@acbp/core`, never in the route file, so
a UI that hides a button is decoration and never a control (`AGENTS.md` §18).

---

## 1. Company setup / onboarding — **buildable today**

| Method | Path | Role | Returns |
|---|---|---|---|
| POST | `/api/companies` | owner | **201** `{company:{companyId,status,creationMode}}` |
| GET | `/api/companies` | owner+viewer | **200** `{items:PortfolioItem[], nextCursor}` |
| GET | `/api/companies/{id}` | owner+viewer | **200** `{company:CompanyView}` |
| PATCH | `/api/companies/{id}` | owner | **200** `{changed, version?}` |
| GET | `/api/companies/{id}/provisioning` | owner+viewer | **200** the six-step status |
| POST | `/api/companies/{id}/provisioning/resume` | owner | **200** same shape, or **409** `conflict` |
| GET, POST | `/api/companies/{id}/interview` | owner+viewer | **200** `{session:InterviewSessionDTO}` |
| GET | `/api/companies/{id}/interview/qa` | owner+viewer | **200** `{qa:SessionQADTO}` |
| POST | `/api/companies/{id}/interview/questions/{qid}/answer` | owner+viewer | **200** `{answer:AnswerDTO, created}` |
| POST | `/api/companies/{id}/interview/resume` \| `/suspend` | owner+viewer | **200** `{session}`, or **409** `invalid_transition` |
| GET, POST | `/api/companies/{id}/memory` | read owner+viewer / write owner+viewer | **200** `{items}` / **201** `{item}` |
| GET, PATCH, DELETE | `/api/companies/{id}/memory/{mid}` | read owner+viewer, edit/delete owner | **200** `{item}` / `{memoryItemId}` |

**Shapes.**

- `PortfolioItem` — `companyId`, `name`, `status`, `role`, `createdAt`. No account id, no totals, no metrics.
- `CompanyView` — `companyId`, `status`, `displayStatus`, `name|null`, `description|null`,
  `profileVersion|null`. `status` is the internal lifecycle value
  (`draft|onboarding|active|paused|deactivating|deactivated`); **`displayStatus` is the one to render**
  (`provisioning|active|paused|deactivating|deactivated|unknown`) — it already collapses the states a founder
  should not have to distinguish.
- Provisioning — `companyId`, `companyStatus`, `steps[]`, `nextIncompleteStep|null`, `resumable`, `exhausted`,
  `completed`. Steps run in fixed order: `profile`, `mission_draft`, `research`, `roadmap`, `documents`,
  `activity`. Each step carries `step`, `order`, `status` (`pending|completed|failed`), `attempt`,
  `requestedAt`, `startedAt|null`, `completedAt|null`, `failedAt|null`, `failureCode|null`.
- `InterviewSessionDTO` — `sessionId`, `companyId`, `state`, `phase`, `startedAt|null`, `createdAt`,
  `updatedAt`. Same split as the company: `state` is internal, `phase` is the honest display value.
- `SessionQADTO` — `{sessionId, items[]}`, each item `{question, currentAnswer|null, revisions[], lifecycle}`
  with `lifecycle` in `asked|answered|skipped`. Questions carry `questionId`, `position`, `prompt`,
  `rationale|null`, `source`, `createdAt`; answers carry `questionId`, `revision`, `status`, `content|null`,
  `createdAt`. Full revision history is returned, not just the latest.
- `MemoryItemDTO` — `memoryItemId`, `type`, `content`, `sourceType`, `sourceRef`, `confidence|null`,
  `confirmationState` (`proposed|accepted|validated|invalidated`), `supersededBy|null`, `createdAt`.

**Worth knowing.** An answer body is `{status:'answered'|'skipped', content}` and content is capped at 10,000
characters. A memory PATCH is a versioned supersede returning the **new** item, not an in-place edit, and a lost
race returns **409** `conflict` — the UI needs a re-read path, not a retry.

---

## 2. Task board — **readable today, and almost entirely read-only**

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/companies/{id}/tasks` | owner+viewer | **200** `{board:TaskBoardDTO}` |
| GET | `/api/companies/{id}/tasks/{taskId}` | owner+viewer | **200** `{task:TaskDetailDTO}` |
| POST | `/api/companies/{id}/tasks/{taskId}/delete` | **owner** | **200** `{taskId, stateAtDelete}` |
| GET | `/api/companies/{id}/tasks/{taskId}/runs` | owner+viewer | **200** `{runs:TaskRunDTO[]}` |
| GET | `/api/companies/{id}/runs/{runId}` | owner+viewer | **200** `{run:TaskRunDTO}` |
| GET | `/api/companies/{id}/runs/{runId}/artifacts` | owner+viewer | **200** `{artifacts:ArtifactDTO[]}` |
| GET | `/api/companies/{id}/artifacts/{aid}` | owner+viewer | **200** `{artifact:ArtifactDTO}` |
| GET | `/api/companies/{id}/artifacts/{aid}/lineage` | owner+viewer | **200** `{lineage}` |

**The board comes pre-bucketed.** `TaskBoardDTO` is `{buckets[], counts, draftsOffBoard, unplaceable,
truncated}`. The columns are fixed and server-defined: `to_do`, `recurring`, `in_progress`, `completed`,
`rejected`, `failed`, `cancelled`, `held`. Each bucket carries its own `availability`
(`available|not_in_this_version`) — a column can exist in the contract and honestly report that this version
does not populate it, and the UI should render that rather than an empty column that implies "nothing here".

Each board task is `{task:TaskDTO, dependsOnTaskIds[], blocksTaskIds[], dependencyBlocked}`, and `TaskDTO` is
`taskId`, `companyId`, `state` (11 values), `phase` (9 display values), `title`, `description|null`,
`milestoneId|null`, `taskType|null`, `priority|null`, `createdAt`, `updatedAt`. Render `phase`.

Task detail adds `rationale`, `repeatedFromTaskId`, `controls[]` and `latestFailure`. **`controls` is the
button state, already computed** — each entry is `{control:'repeat'|'delete', available, reason}` with reason
in `cancel_first|not_finished|unknown_state|null`. A frontend should drive affordances from this rather than
re-deriving them from `state`, because the server will refuse on the same basis — with one caveat: `delete` has
a route behind it and **`repeat` does not**, so a `repeat` verdict of `available:true` currently describes a
capability with no endpoint. `latestFailure` carries
`category`, `summary`, `attemptsUsed`, `attemptsAllowed`, `retrySafety`, `nextAttempt` — enough to explain a
failure without inventing copy.

**Deletion is a confirm-then-act flow, with two different refusals.** Body is
`{confirmed:boolean, reason?:string|null}` and `confirmed` must be a real boolean — the string `"false"` is
rejected, not coerced. Omitting it, or sending a non-boolean, is a route-level **400** `bad_request`. Sending an
explicit `confirmed:false` reaches the domain and returns **409** `confirmation_required` — that is the one to
render as "are you sure?", and it is reachable only by asking. Against a task in the wrong state: **409**
`{"error":"control_unavailable","reason":...}`, a distinct code because the next action differs.

**The gap.** There is **no route to create, edit, move, start, retry, or cancel a task.** `POST .../tasks/generate`
creates the whole set from the roadmap in one metered call (§7), and delete removes one. Everything else a board
usually offers does not exist at the API layer. A board built today is a *viewer* with one destructive action.

---

## 3. Approvals inbox — **readable, but nothing can be approved**

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/companies/{id}/approvals` | owner+viewer | **200** `{approvals:ApprovalInboxItem[]}` |

Each item: `approvalRequestId`, `action`, `reason`, `expectedResult`, `preview`, `riskClass`, `reversibility`,
`scope`, `estimatedCostCredits`, `toolId`, `toolVersion`. That list is an allowlist, applied deliberately: the
core use case returns the raw database row, and the request-layer mapper drops the tool payload, the tenant ids,
the run id and the policy pins before they can reach the route.

**`GET` is the only method on this route.** There is no approve endpoint, no reject endpoint, and no decision
endpoint anywhere under `/api/companies/{id}/approvals`. The approval *decision* logic exists in `@acbp/core`
and is exercised by its own tests — the authorization matrix even carries an `approval:decide` action, owner-only
— but nothing over HTTP ever calls it.

So an approvals inbox screen can list what is waiting and can show risk, scope and estimated cost — and its two
primary buttons have nothing to call. This is the single largest hole in the current API surface relative to the
product, and it should be a ticket before it is a screen.

---

## 4. Activity feed — **buildable today**

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/companies/{id}/activity?cursor=&limit=` | owner+viewer | **200** paged feed |

`limit` defaults to 25 and caps at 100; an invalid value falls back to the default rather than erroring. A bad
cursor is **400** `invalid_cursor`. Note that the portfolio list at `GET /api/companies` does the opposite with
the same-named parameter — it **rejects** a bad `limit` with **400** `invalid_limit` instead of clamping — so a
shared paging component cannot assume one behaviour.

The body is `{items, nextCursor, projectionMode, asOf, sourceThrough, lagSeconds}`. The last four are honesty
metadata and are worth surfacing rather than dropping: `projectionMode` is `'synchronous'` and `lagSeconds` is
`0` today, but they exist so that the day the feed becomes eventually consistent, the UI already knows how stale
its data is instead of silently presenting a lagging view as current.

Each item is `{id, type, occurredAt, state, actorType, summary}`. `state` is `proposed|executed` — a proposed
approval and an executed one are different events and must not render identically. `summary` is a flat
key/value map of **allowlisted keys per type**, never a free-text message, so the UI supplies the sentence and
the server supplies only the facts:

| `type` | `summary` keys |
|---|---|
| `company.created` | `creation_mode` |
| `company.updated` | `changed_fields` |
| `company.paused`, `company.resumed` | *(none)* |
| `task.created` | `has_milestone` |
| `task.started` | `attempt` |
| `task.completed` | `artifact_count`, `no_artifact_rationale` |
| `task.failed` | `attempt`, `failure_category`, `retry_state` |
| `approval.requested` | `tool_id`, `risk_class`, `scope`, `estimated_cost_credits` |
| `approval.approved` | `decision_path`, `decider_type` |
| `approval.rejected` | `decider_type` |

---

## 5. Decision room — the richest single read, and where usage actually lives

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/api/companies/{id}/decision-room` | owner+viewer | **200** `{room:DecisionRoomView}` |
| GET | `/api/companies/{id}/decision-room/stream?intervalMs=` | owner+viewer | **200** `text/event-stream` |

`DecisionRoomView` is `{sections[], integrity, usage, asOf, digest}`. Ten sections in fixed order:
`needs_your_decision`, `recommended_next_actions`, `questions_from_ai`, `options_under_consideration`,
`approved_and_queued`, `executing`, `results`, `blocked_work`, `failed_work`, `recent_decisions`.

**Each section carries its own `status`** (`ok|restricted|unavailable`), plus `queue`, `count|null`, `items[]`
and `truncated`. This is the shape to respect most carefully: a viewer who lacks a sub-permission gets that section
as `restricted`, not as empty, and a UI that renders `restricted` and `ok` identically is telling a founder that
a queue is empty when it is merely hidden. `count` is the true total; `items` is capped at 20 per section.

An item is `{id, kind, title, state, occurredAt, detail}` where `kind` is one of `task`, `approval_request`,
`approval_decision`, `held_work`, `strategy_option`, `strategy_decision`, `interview_question`. `detail` is a
flat map assembled per kind, with null values omitted — treat every key as optional.

**Usage is here and nowhere else.** `usage` is `{status, figures|null}` with figures
`{eventCount, inputTokens, outputTokens, estimatedCostMicros}`, gated on `usage:read` which is **owner only** —
a viewer receives `{status:'restricted', figures:null}`. This is company-scoped consumption, not an account
balance. See §6.

**The stream.** `intervalMs` defaults to 5000 and clamps to [2000, 60000]. Events: `room` on first read and
again whenever `digest` changes, carrying `{deliveryMode:'poll_backed', intervalSeconds, asOf, digest, counts}`;
an SSE comment heartbeat on unchanged ticks; and exactly one terminal `closed` event with a reason of
`max_lifetime` (a hard 5-minute cap), `unauthorized`, or `unavailable`. Authorization is re-checked on **every**
tick, so revoking a membership closes the stream rather than leaving it running. `Last-Event-ID` is **not**
implemented — a client that wants continuity past five minutes must reconnect and re-read.

---

## 6. Usage and credits — **no route exists**

There is no HTTP surface for a credit balance, a credit ledger, an account usage rollup, or a spending quota. A
usage/credits screen cannot be built today, and this is not a case of an unpolished endpoint — nothing is there.

What exists, and where:

- **Database:** `credit_transactions`, `usage_events`, `account_usage_rollups`, `usage_corrections`.
- **Core use cases:** `readCreditLedger` (`billing:read`), `readAccountUsageRollup` (`usage:read`),
  `preflightRun`, `reserveCredit`, `settleRun`, `recordUsageCorrection`. All real, all tested, none
  HTTP-reachable — a search of `apps/web` for any of those names returns nothing.
- **The only spend signal on the wire:** the decision room's company-scoped `usage.figures` (owner only, §5),
  and the per-item `estimatedCostCredits` on approvals (§3) — an estimate for one pending action, not a balance.

Two things must not be mistaken for a budget control. The **429** ceiling is a request-frequency limit, not
spend. And the **402** `budget_exhausted` mapping on the generate routes is correct but **unreachable**: nothing
on those paths debits credit yet. `ACBP-API-009` is the ticket for that wiring and it is deliberately out of
scope of the current slice; until it lands, no screen may present a working budget control, because there is not
one (`AGENTS.md` §18).

---

## 7. Strategy and roadmap — reads are on `main`, the four generate writes are on a branch

| Method | Path | Role | Returns | On `main`? |
|---|---|---|---|---|
| GET | `/api/companies/{id}/strategy` | owner+viewer | **200** `{generation:StrategyGenerationDTO\|null}` | yes |
| POST | `/api/companies/{id}/strategy/selection` | owner | **200** `{selection}` | yes |
| POST | `/api/companies/{id}/decisions` | owner | **200** `{decision}` | yes |
| GET | `/api/companies/{id}/roadmap` | owner+viewer | **200** `{roadmap:RoadmapDTO\|null}` | yes |
| POST | `/api/companies/{id}/roadmap/edit` | owner | **200** `{roadmap, flaggedTaskCount}` | yes |
| POST | `/api/companies/{id}/strategy/generate` | **owner** | **200** `{generation}` | **no — PR #111** |
| POST | `/api/companies/{id}/strategy/recommend` | **owner** | **200** `{recommendation}` | **no — PR #111** |
| POST | `/api/companies/{id}/roadmap/generate` | **owner** | **200** `{roadmap}` | **no — PR #111** |
| POST | `/api/companies/{id}/tasks/generate` | **owner** | **200** tasks + partial-plan counters | **no — PR #111** |

PR #111 is stacked on `p8-api-006-model-gateway` (PR #107), not on `main`, so merging #111 alone does not put
those four routes on `main`.

**`null` is a success.** Both GETs return **200** with a null body field when nothing has been generated yet —
never a 404. That is the honest first-visit empty state and the UI should treat it as one.

`StrategyGenerationDTO` carries `generationId`, `companyId`, `understandingVersion`, `status`
(`complete|fewer_than_three`), `optionCount`, `fewerReason|null`, `similarityCheckResult`,
`modelFlaggedPartial`, `options[]`, `recommendation|null`, `selection|null`, `decision|null`, `createdAt`. An
option is exactly three properties — `optionId`, `ordinal`, and a nested **`fields`** object holding sixteen
named strings, so it is `option.fields.description`, not `option.description`: `description`, `customer`,
`offer`, `business_model`, `scope`, `benefits`, `risks`, `cost_range`, `effort`, `time_to_validate`,
`time_to_launch`, `required_resources`, `key_assumptions`, `validation_method`, `success_metrics`,
`confidence`. Note
`fewer_than_three` and `modelFlaggedPartial`: a generation may honestly return less than it intended, and the
screen has to be able to say so.

`RoadmapDTO` carries `roadmapId`, `companyId`, `version`, `decisionId`, `status` (`complete|partial`), `origin`
(`generated|edited`), `supersedesRoadmapId|null`, `editReason|null`, `modelFlaggedPartial`, `goals[]`,
`milestones[]`, `createdAt`. Goals are `{goalId, ordinal, title, description|null, status}`; milestones are
`{milestoneId, ordinal, goalId|null, title, description|null, status}`.

**The four generate routes are metered** and behave unlike every other write here: `maxDuration = 90`, a
company-scoped rate ceiling on top of the usual one, **502** `generation_failed` / `recommendation_failed` for
an upstream provider failure (not 500 — this platform is fine, the provider was not), and eight distinct **409**
preconditions (`no_understanding`, `not_confirmed`, `stale_understanding`, `no_decision`, `stale_decision`,
`no_roadmap`, `no_milestones_in_scope`, `stale_roadmap`) which each imply a different next step for the founder.
`roadmap/generate` can also return the pre-existing **409** `decision_rejected`, when the company's latest
strategy decision was a rejection — a ninth distinct next step, and the one case where retrying is futile until
the founder revisits the strategy.
`tasks/generate` also returns partial-plan counters — `partial`, `tasksMissingType`, `milestonesOmitted`,
`tasksMissingRationale`, `memoryItemsConsidered` — which exist so a UI can disclose that a plan came back
incomplete instead of presenting it as whole.

---

## 8. Account, membership and platform admin

| Method | Path | Role | Returns |
|---|---|---|---|
| GET, PATCH | `/api/account/profile` | **owner only, both** | **200** `{profile}` |
| GET | `/api/account/members` | owner+viewer | **200** `{members:MemberView[]}` |
| POST | `/api/account/members` | owner | **201** `{membership:{membershipId,role}, inviteToken}` |
| DELETE | `/api/account/members/{mid}` | owner | **204** empty |
| POST | `/api/account/members/accept` | any signed-in user | **200** `{membership:{membershipId,accountId,role}}` |
| POST | `/api/admin/accounts/{aid}/companies/{cid}/read` | platform admin | **200** four fields, `no-store` |

`AccountProfileView` is `{accountId, displayName|null, locale, email|null, emailVerified}`. `MemberView` is
`{membershipId, role, status, memberUserId|null, invitedEmail|null, createdAt}` with status in
`invited|active|revoked`. **`invitedEmail` is `null` for a viewer on every row** — reading it is gated on an
owner-only permission — so a member list rendered for a viewer must not present a blank email as "no email on
file".

Two details that shape the UI. **The raw invite token is returned exactly once**, in the 201 from the invite
call — it is never readable again, so the screen that creates an invite is the only place it can be shown or
copied. And revoking the last owner is **409** `last_owner`, a distinct code from the generic `conflict`.

The admin route is not a tenant role: it is gated on a `platform_admins` database check, requires a body of
exactly `{reason: string}` (1–512 characters, no other keys), and returns only `companyId`, `status`,
`creationMode`, `createdAt`. It is a break-glass read, not an admin console.

---

## 9. Pause and resume are not the emergency stop

| Method | Path | Role | Returns |
|---|---|---|---|
| POST | `/api/companies/{id}/pause` | owner | **200** `{status:'paused'}` |
| POST | `/api/companies/{id}/resume` | owner | **200** `{status:'active'}` |

Neither takes a body. Both are strict transitions — pause requires exactly `active`, resume requires exactly
`paused` — and anything else is **409** `{"error":"invalid_transition","from":...}`, which gives the UI the
current state to re-render from.

**What pause actually does:** it flips the company's lifecycle status, and four separate gates then refuse
autonomous work while it is not `active` — run start, tool dispatch, job enqueue, and the job checkpoint. The
tool-dispatch gate is the one that matters for an in-flight run: a run already executing finishes its current
tool call and is refused the next one with `company_not_active`. So pause is more than a "no new work" flag; it
does stop work in progress at the next boundary.

**What it is still not:** the emergency stop. That is a separate mechanism — an `emergency_stops` record, with
`activateStop`, `clearStop` and `readStopState` in core — and the differences are narrower than they sound but
real: a stop records held work and moves the task to `paused` so an operator can see what was interrupted and
resume it deliberately, and it can be scoped, where pause is the whole company and leaves no held-work record.
The stop mechanism has **no HTTP route at all**, so an emergency-stop screen cannot be built today.

Two honest sentences a UI may use: pause halts this company's autonomous work at the next safe boundary; and no
platform-wide emergency stop is exposed. Labelling the pause button as *the* emergency stop would still be a
control that promises more than the server records (`AGENTS.md` §18).

---

## 10. Summary against the six screens requested

| Screen | Verdict |
|---|---|
| Company setup | **Buildable.** Create, read, rename, provisioning status and resume, the full interview loop, and memory CRUD are all present and merged. |
| Task board | **Buildable as a read.** Board, detail, runs and artifacts are complete, and `controls[]` gives button state directly. There is no create/edit/move/start/retry/cancel route — only generate-all and delete-one. |
| Approvals inbox | **Half.** The list and every field an approver needs are there. Approve and reject do not exist over HTTP. Needs a ticket. |
| Usage / credits | **Not buildable.** No route. Ledger and rollups exist in core and the database only. `ACBP-API-009` covers the generate-path wiring; a read API is not ticketed. |
| Emergency stop | **Not buildable as named.** Pause/resume does halt this company's autonomous work at the next boundary, and that is worth a button — but the stop system, which records held work and can be scoped, has no HTTP surface. |
| Activity feed | **Buildable.** Cursor paging, typed events, allowlisted summaries, and honest staleness metadata. |

**How this document was checked, so the next reader knows what it rests on.** The route list, the exported
methods and the on-`main` column were enumerated from the tree and from `git log origin/main`; response mapping
was read from the `*-http.ts` mappers; DTO fields were traced into `@acbp/contracts` and `@acbp/core`; roles were
quoted from the `POLICY` matrix. It was then reviewed adversarially against the code, and that pass found real
errors which are corrected above — a missing route in the scope statement, two claims stated as universal that
hold for most routes but not all, a wrong status code on the delete confirmation, a use case named wrongly, a
flat option shape that is actually nested, and a pause characterization that understated what pause stops.
Anything still wrong here is wrong in the same way: read the cited file before betting a screen on a sentence.

Two cross-cutting notes for whoever designs against this. Almost every DTO ships an internal `state` alongside a
display-oriented `phase` or `displayStatus`, and the display value is the one to render — the internal one is
there for correctness, not for founders. And `restricted` is never the same as empty, in the decision room and in
the board's `availability` flag: the server distinguishes "you may not see this" from "there is nothing here",
and a UI that collapses the two would be lying to a paying user about their own company.
