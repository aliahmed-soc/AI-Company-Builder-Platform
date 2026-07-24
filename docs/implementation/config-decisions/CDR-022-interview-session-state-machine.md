# CDR-022 — Interview session persistence and state machine (ACBP-P2-001)

**Status:** Accepted (autonomous lead, under the standing Phase 2 authorization; no owner gate — the state set,
resume semantics, tenancy keying and events are all canonically pinned; see §7).
**Requirement:** DISC-007 (progressive resumable session). **Governing ADR:** ADR-008 (durability/checkpoint
semantics). **Architecture:** WORKFLOW-STATE-MACHINES.md §2; DATA-ARCHITECTURE.md:17; EVENT-CATALOG.md:47-48;
API-CONTRACTS.md:33. **Milestone:** M2 (the "interview resumable exactly / session kill-and-resume" slice).
**Depends on:** ACBP-P1-012 (Done).

Records the interpretation decisions for P2-001. Everything here is the *safer, reversible* reading of canon
(canonical source priority §2 of CLAUDE.md); nothing invents a requirement.

## 1. What P2-001 is (and is not)

P2-001 is the **interview session envelope**: the durable, company-scoped session entity, the server-enforced
state machine, exact resume, the `interview.started` audit event, and rejection of illegal transitions. It is
the persistence substrate every later M2/M3 discovery ticket attaches to.

P2-001 is **NOT**: questions/answers/revisions (P2-002), question generation / adaptivity / batching /
vagueness+contradiction detection / "I don't know" path / rationale (P2-005), the model gateway and usage
events (P2-003), typed memory (P2-006), or understanding/strategy generation and confirmation effects (M3,
P2-008/009). Where §2 lists a transition whose **effect** belongs to a later ticket, P2-001 defines the
transition as a legal, guarded member of the state machine but does **not** implement that effect.

## 2. The state machine (canon: WORKFLOW-STATE-MACHINES.md §2, verbatim state set)

```
not_started → in_progress ⇄ waiting_for_user → ready_for_review → confirmed ⏹ → superseded ⏹
```

Six states; the set is **closed and fully decided now** (unlike company lifecycle's deferred deactivate/delete,
these six are all canonical). Terminal: `confirmed` (produces the understanding version) and `superseded` (no
outgoing transition). Legal transitions, server-enforced (invalid → rejected + auditable):

| from | to | actor (canon) | implemented by |
|---|---|---|---|
| not_started | in_progress | system (post-onboarding), pre = company active | **P2-001** (start) |
| in_progress | waiting_for_user | system/user | **P2-001** (suspend) |
| waiting_for_user | in_progress | system/user — *resumable exactly (DISC-007)* | **P2-001** (resume) |
| in_progress | ready_for_review | system | later (M3; effect = understanding draft) |
| ready_for_review | confirmed | **owner only** | later (P2-009; effect = strategy unlock) |
| confirmed | superseded | system on material correction (DISC-008) | later (P2-002; opens a new session) |

The **full** legal-transition map lives in `@acbp/contracts` so illegal transitions are rejected uniformly
from day one; only the three P2-001 rows have executable operations. The contract mints the initial state
`not_started`; `startInterviewSession` performs the real `not_started → in_progress` transition (it does not
insert directly into `in_progress`), so the state machine is genuinely exercised, not bypassed.

## 3. Exact resume + "recovers to last confirmed answer"

- **"Close/reopen restores exactly" (DISC-007 acceptance):** the durable `interview_sessions` row is the single
  source of truth. Closing performs no write; reopening is a consistent read of the same committed row. The
  kill-and-resume proof: start → suspend to `waiting_for_user` → drop the connection → a fresh
  transaction/connection reads the identical state and durable fields → resume to `in_progress`.
- **"Corrupted session state recovers to the last confirmed answer" (DISC-007 edge; BACKLOG failure column):**
  realized in P2-001 as **atomic transitions** — every transition writes state (+ any effect + audit) in ONE
  transaction, so a failed transition rolls back wholly and leaves the prior committed state intact; a reader
  never observes a half-applied state. In P2-001 there are no answers yet, so the "last confirmed" checkpoint
  IS the session's last committed state. Per-*answer* checkpoint recovery becomes meaningful in P2-002 (answers)
  and is deferred there; this is additive and does not contradict §2.

## 4. `interview.started` — audited now; activity projection DEFERRED (documented deviation)

`interview.started` is registered in the closed `AUDIT_EVENTS` set and emitted on `not_started → in_progress`,
company-scoped (the writer stamps `company_id`/`account_id` from the caller's `CompanyScope`; subject = the
session id; empty metadata — the payload is the subject).

EVENT-CATALOG.md:47 lists `interview.started` as also fanning out to the **activity** feed. P2-001
**defers the activity projection** and ships the event **audit-only**, for these reasons:

- It is **not** in P2-001's acceptance criteria (which are entirely about resume exactness).
- Projecting requires **extending P1-009's deliberately CLOSED activity taxonomy** (the `activity_events`
  `activity_type` CHECK plus the `isProjectableActivity` allowlist), an invariant the P1-014 adversarial suite
  actively pins ("taxonomy closed = only the four company lifecycle events"). Expanding a completed ticket's
  closed invariant should be an isolated, deliberately-reviewed change made when the discovery activity/memory
  surface (P2-010, M3) actually consumes it — not a side effect of the session-persistence slice.
- **Audit-only-now → project-later is purely additive and reversible**; the reverse is not. Precedent:
  workspace-provisioning events (P1-012/CDR-018) are audit-only despite being events.

This resolves the only canon wording mismatch (BACKLOG's shorthand "interview.* audited" vs EVENT-CATALOG's
explicit per-event fan-out) toward the more specific architecture doc, and records the deferral so a later
ticket can add the projection deliberately. `interview.question_answered` (EVENT-CATALOG:48, audit column "—")
is a **P2-002** concern and is not introduced here.

## 5. Data model — `interview_sessions` (migration 0012; additive; company-scoped; FORCE RLS)

Additive expand migration (0001–0011 untouched; **no** new SECURITY DEFINER function — the allowlist stays
exactly three; no BYPASSRLS; no owner runtime connection). Mirrors the P1-012 dual-keyed FORCE-RLS pattern.

- `id uuid pk default gen_random_uuid()` (the `session_id`), `account_id`, `company_id` (both `not null`, FKs
  to `accounts`/`companies`, `on delete cascade`).
- `state text not null default 'not_started'`, `CHECK (state in (…the six…))` — the **full** canonical set, so
  no CHECK churn as later tickets add transitions.
- `started_at timestamptz` (set on the first entry to `in_progress`); `created_at`, `updated_at` (`not null
  default now()`). Shape CHECK: `state = 'not_started' or started_at is not null`.
- **One open session per company:** a partial unique index on `(company_id) WHERE state <> 'superseded'`
  (a company has at most one non-superseded session; historical superseded sessions accumulate).
- Timestamp columns for `ready_for_review`/`confirmed`/`superseded` are **deferred** to the tickets that
  implement those transitions (additive), keeping the P2-001 table tight to what it writes (the company.ts
  "keep the CHECK tight to what is reachable" philosophy).
- **Least privilege:** `grant select, insert on interview_sessions`; `grant update (state, started_at,
  updated_at)` only — identity columns (`id`, `account_id`, `company_id`, `created_at`) have no UPDATE grant,
  so they are immutable to `acbp_app` at the privilege level. No DELETE/TRUNCATE.
- **FORCE RLS**, dual-keyed fail-closed policies (select/insert/update) requiring
  `account_id::text = current_account AND company_id::text = current_company` — a validated `CompanyScope`,
  never account-only authority.

## 6. Authorization (ADR-022; company-membership role)

Two new closed authz actions, checked against the caller's **company**-membership role (API-CONTRACTS:33
"Company member"):

- `interview:read` → `owner | viewer` (get session / honest progress).
- `interview:participate` → `owner | viewer` (start, suspend, resume — any active company member conducts the
  interview).

There is deliberately **no** `interview:confirm` action yet: the `ready_for_review → confirmed` transition is
**owner-only** (§2) but its operation belongs to P2-009, which will register that action when it implements the
confirmation effect. Adding actions per-ticket keeps the policy surface exactly as wide as the implemented
operations (the P1-010→P1-013 convention).

## 7. Why no owner gate

Canonical discovery confirmed the four foundational axes are all pinned and mutually consistent across §2,
DATA-ARCHITECTURE, REQUIREMENTS/traceability, ADR-008, EVENT-CATALOG and API-CONTRACTS; no open question is
filed against interview/session/discovery/resume. The only judgment calls (checkpoint granularity for "last
confirmed", and honoring EVENT-CATALOG's audit/activity mapping over the backlog's shorthand) are
implementation-level and resolved above under "safer reversible interpretation, document it."

## 8. Slice plan

1. **Contracts + authz + audit** (`@acbp/contracts`): the closed state set + legal-transition map + guard +
   honest progress projection + redacted DTO; `interview:read`/`interview:participate` actions + matrix;
   `interview.started` registration + typed factory; exhaustive unit tests.
2. **Migration 0012** `interview_sessions` + real-PostgreSQL RLS/privilege/catalog/lifecycle + down/up/reapply
   tests; all existing suites' drop-lists extended.
3. **Core operations** (`@acbp/core` discovery module): `startInterviewSession` / `suspendInterviewSession` /
   `resumeInterviewSession` / `getInterviewSession` under fresh `CompanyScope` transactions; atomic transitions;
   `interview.started` emission; illegal-transition rejection; real-PG trust + **kill-and-resume** suite.
4. **API boundary**: authenticated `POST /api/companies/[companyId]/interview` (start), `POST …/interview/resume`,
   `GET …/interview` (session/progress); strict parsing; bounded errors; forged-scope negatives; `next build`.

## 9. Out of scope / deferred (explicit)

Activity projection of `interview.started` (§4); questions/answers/revisions and `interview.question_answered`
(P2-002); generation/adaptivity/batching (P2-005); gateway + usage (P2-003); memory (P2-006);
understanding/strategy generation, `understanding.generated/confirmed/corrected`, and the effects of the
`in_progress→ready_for_review`, `ready_for_review→confirmed`, `confirmed→superseded` transitions (M3); the
`interview:confirm` authz action (P2-009); per-answer checkpoint recovery (P2-002).
