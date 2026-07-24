# Interview sessions (ACBP-P2-001)

The durable, company-scoped founder-discovery **session envelope**: the entity, the server-enforced state
machine, exact resume, and the one audited event. Delivered under **CDR-022**; requirement **DISC-007**;
governing **ADR-008** (durability/checkpoint semantics); state machine **WORKFLOW-STATE-MACHINES.md §2**.

This is the persistence substrate every later M2/M3 discovery ticket attaches to. It is deliberately narrow:
questions/answers/revisions (P2-002), question generation and adaptivity (P2-005), the model gateway (P2-003),
typed memory (P2-006), and understanding/strategy generation (M3) are **out of scope** and build on top of it.

## State machine

```
not_started → in_progress ⇄ waiting_for_user → ready_for_review → confirmed ⏹ → superseded ⏹
```

Six states, closed and fully decided now (`@acbp/contracts` `INTERVIEW_SESSION_STATES`). Terminal: `confirmed`
(produces the understanding version) and `superseded` (no outgoing transition). The **full** legal-transition
map lives in the contract (`isLegalInterviewTransition`), so illegal transitions are rejected uniformly from
day one — but P2-001 gives executable operations to only three of them:

| Transition | Operation (P2-001) | Notes |
|---|---|---|
| not_started → in_progress | `startInterviewSession` | pre = company **active**; emits `interview.started`; idempotent |
| in_progress → waiting_for_user | `suspendInterviewSession` | the user pauses / leaves |
| waiting_for_user → in_progress | `resumeInterviewSession` | **exact resume** (DISC-007) |
| in_progress → ready_for_review | later (M3) | effect = understanding draft |
| ready_for_review → confirmed | later (P2-009, owner-only) | effect = strategy unlock |
| confirmed → superseded | later (P2-002, DISC-008) | opens a new session/version |

The state machine is **server-enforced**: a transition is validated against the contract map, and the
repository UPDATE carries the `from`-state predicate as an optimistic-concurrency backstop (a racing transition
finds the row no longer in `from` and applies nothing).

## Exact resume + recovery

- **"Close/reopen restores exactly" (DISC-007):** the durable `interview_sessions` row is the single source of
  truth. Closing performs no write; reopening is a consistent read of the same committed row. A company has at
  most one **open** (non-superseded) session, so the operations target it — the caller never needs a session id.
- **"Recovers to last confirmed answer" (DISC-007 edge):** realized as **atomic transitions** — every
  transition writes state (+ any effect + audit) in ONE transaction, so a failed transition rolls back wholly
  and a reader never observes a half-applied state. In P2-001 there are no answers yet, so the checkpoint is the
  session's last committed state; per-*answer* checkpoint recovery becomes meaningful in P2-002.

The M2 kill-and-resume proof (real PostgreSQL) starts a session, suspends it to `waiting_for_user`, then shows
the durable state survives independent transactions **and** a direct storage-layer read before resuming.

## Data model — `interview_sessions` (migration 0012)

Additive expand migration (0001–0011 untouched; **no** new SECURITY DEFINER function — still exactly three; no
BYPASSRLS; no owner runtime connection). Company-scoped, mirroring the P1-012 dual-keyed FORCE-RLS pattern:

- `id` (server-generated uuid, the `session_id`), `account_id`, `company_id` (FKs, cascade); `state` (CHECK the
  closed six states); `started_at` (set on the first entry to `in_progress`); `created_at`; `updated_at`.
  Shape CHECK: `started_at` is set iff `state <> 'not_started'`.
- **One open session per company:** a partial unique index on `(company_id) WHERE state <> 'superseded'`.
- **Least privilege:** `grant select, insert`; `grant update (state, started_at, updated_at)` only — identity
  columns are immutable to `acbp_app` at the privilege level; no DELETE/TRUNCATE.
- **FORCE RLS**, dual-keyed fail-closed policies (select/insert/update) requiring `account_id = current_account
  AND company_id = current_company` — a validated `CompanyScope`, never account-only authority.

## Authorization (ADR-022)

Two closed authz actions, checked against the caller's **company**-membership role (API-CONTRACTS "Company
member"): `interview:read` and `interview:participate`, both `owner | viewer`. There is deliberately **no**
`interview:confirm` action. P2-009 implemented the owner-only confirmation gate at the **understanding-version**
grain (`understanding:confirm` / `understanding:review`; CDR-030), NOT as an `interview_sessions` state transition:
P2-008 decoupled understanding generation from the session (`understanding_documents` carries no `session_id`), so
the confirmation gate is an understanding-version concept (the strategy-unlock token). Syncing the
`interview_sessions` `ready_for_review → confirmed → superseded` state machine to that gate is the deferred **P2-012**
Slice B integration — this doc's transition table below (rows for those transitions) records the session-state intent,
not a P2-009 effect.

## Audit — `interview.started` (audit-only; activity projection deferred)

Exactly one durable event: `interview.started`, emitted on `not_started → in_progress`, company-scoped (the
writer stamps `company_id`/`account_id` from the `CompanyScope`; subject = the session id; empty metadata). It
is registered in the closed `AUDIT_EVENTS` set and produced by exactly one approved operation
(`interview.start`) in the core audit-completeness partition.

`interview.started` is shipped **audit-only**. EVENT-CATALOG lists it as also fanning out to the activity feed,
but projecting it would extend P1-009's deliberately **closed** activity taxonomy (which the P1-014 adversarial
suite pins), a change better isolated to when the discovery activity/memory surface (M3) consumes it.
Audit-only-now → project-later is additive and reversible (CDR-022 §4). `interview.question_answered`
(EVENT-CATALOG:48) is a P2-002 concern and is not introduced here.

## HTTP API

All authenticated; the acting user + account are server-resolved; `companyId` is a membership-validated
selector; no request body and no query parameters are accepted (any query → bounded 400); every handler wraps
throws into the bounded generic 500 envelope.

| Method + path | Operation |
|---|---|
| `GET  /api/companies/{companyId}/interview` | current open session |
| `POST /api/companies/{companyId}/interview` | start (idempotent) |
| `POST /api/companies/{companyId}/interview/suspend` | in_progress → waiting_for_user |
| `POST /api/companies/{companyId}/interview/resume` | waiting_for_user → in_progress |

Responses: `200 { session }` (redacted DTO — sessionId, companyId, state, honest phase, timestamps; no
accountId/actor); `company_not_active` → coarse `409`; `invalid_transition` → `409 { from }`; `not_found` →
`404`; any denial → one opaque `403`.

## Questions and answers (ACBP-P2-002; CDR-023)

The Q&A persistence layer hangs off the session. Two company-owned, dual-keyed FORCE-RLS tables (migration
0013):

- **`interview_questions`** — DATA-ARCHITECTURE Question (`I`, immutable). Ordered per session (`unique
  (session_id, position)`); `SELECT + INSERT` grants only, so a question row never changes and its
  `answered/skipped` lifecycle is *derived* from the answers, never a stored column.
- **`interview_answers`** — DATA-ARCHITECTURE Answer (`A`, append-only; "given→revised(new row)"). Composite PK
  `(question_id, revision)`; **current answer = max(revision) per question**; `status` (`answered | skipped`)
  with a content-shape CHECK (answered needs 1–10k content, skipped forbids it); `created_by_user_id` records
  the author of every revision. `SELECT + INSERT` grants only — a revision is a **new row**, never an in-place
  edit (the `company_profiles` append-only precedent).

Operations (`@acbp/core`): `addInterviewQuestion` (the persistence primitive P2-005 drives),
`recordInterviewAnswer` (append a revision; resubmitting the identical current answer is an **idempotent no-op**;
a concurrent revision race is graceful via `ON CONFLICT (question_id, revision) DO NOTHING`), and `getSessionQa`
(questions in order, each with current answer + full revision history + derived lifecycle). Authz reuses
`interview:participate` (writes) and `interview:read`. HTTP: `GET …/interview/qa` and
`POST …/interview/questions/{questionId}/answer` (body `{ status, content? }`) — the operations target the
company's **open** session (resolved server-side; the client never supplies a session id).

**Adaptive orchestration (ACBP-P2-005; CDR-028; diagram 04).** On top of the P2-002 persistence, P2-005 adds the
adaptive loop as `@acbp/core` use cases that call the P2-003 **gateway** (the model call runs BETWEEN scoped
operations, never inside a held transaction):
- `generateAdaptiveBatch` — reads prior answers → gateway (`interview.followups@1`, `generation`) → **≤3** questions
  (DISC-001), each persisted with a truthful **rationale** ("why we ask", DISC-006) and `source='adaptive'`; a
  generation failure persists the **static fallback bank flagged `source='static_fallback'`** (DISC-002; honest
  degradation). Migration 0018 added `interview_questions.rationale` + `.source` (immutable, append-only).
- `evaluateAnswer` — gateway (`interview.answer_quality@1`) → **clear** stores a `user_fact` typed memory item
  (interview-answer source path); **vague** returns one clarifying prompt (DISC-003); **contradictory** surfaces
  the conflict — **never a silent override** (DISC-004, MEM-004 spirit). Detection FAILS OPEN to clear so a model
  outage never blocks the founder.
- `suggestAssumptionForSkip` — an "I don't know" → gateway (`interview.assumption@1`) → a labeled `ai_assumption`
  memory item (`model_generation` source; never a `user_fact`) (DISC-005).
Every call meters usage (the gateway's fail-closed `usage_events` — P2-005's audit). The output parsers are
deny-by-default (`parseFollowUps`/`parseAnswerQuality`/`parseAssumption`); the gateway is wired with a
schema-dispatching `interviewOutputValidator`. **v1 uses the deterministic FAKE provider; live generation is the
deferred owner gate CDR-026 §0** — so the HTTP orchestration routes are sequenced with the live provider (the
engine is proven by the scripted real-PG integration suite). Full context assembly (secret blocklist + MEM-004
precedence) is **P2-007**.

**Persistence-only (CDR-023 §4):** P2-002 emits **no** audit-store event and **no** domain event. Accountability
lives in the append-only, authored, timestamped, never-mutated rows. Canon marks `interview.question_answered`
audit "—" (EVENT-CATALOG) and routes the *audited* correction to the M3 `understanding.corrected` event; that
event's consumers (Understanding, memory) and the transactional outbox do not exist yet, so both the domain
fan-out and any correction audit event are **deferred to M3** — exactly as `interview.started`'s activity
projection is deferred.

## Deferred (explicit)

Activity projection of `interview.started`; the `interview.question_answered` domain fan-out and any answer/
correction **audit-store event** (P2-002 is persistence-only — CDR-023 §4, deferred to M3); question
generation/adaptivity/batching, vagueness/contradiction detection, suggested assumptions, rationale (P2-005);
understanding re-evaluation + stale flagging and `understanding.corrected` (M3); typed memory + provenance
consumption of `interview_answer` refs (P2-006/P2-007); gateway + usage (P2-003); understanding/strategy
generation and the effects of the `ready_for_review`/`confirmed`/`superseded` transitions (M3); the
`interview:confirm` authz action (P2-009); per-answer checkpoint recovery.
