# CDR-023 — Question and answer persistence (ACBP-P2-002)

**Status:** Accepted (autonomous lead, under the standing Phase 2 authorization). **Requirement:** DISC-008
(persistence half). **Governing ADR:** ADR-015 (audit/activity store). **Architecture:** DATA-ARCHITECTURE.md
(Question/Answer entities), EVENT-CATALOG.md:48, API-CONTRACTS.md:33. **Depends on:** ACBP-P2-001 (Done).

Records the interpretation decisions for P2-002. Everything here is the safer, reversible reading of canon;
nothing invents a requirement. **§4 flags the one audit-semantics interpretation prominently for owner
visibility** — it is resolved by canonical priority and is additive/reversible, so it is not treated as a gate.

## 1. What P2-002 is (and is not)

P2-002 is the **question + answer persistence layer** that hangs off the P2-001 interview session: the
`interview_questions` table (immutable rows, ordered within a session), the `interview_answers` table
(**append-only** — a revision is a **new row**, current answer = the max revision per question), and the
persistence operations to record/revise an answer, skip a question ("I don't know"), and read a session's Q&A
with current answers + full revision history.

P2-002 is **NOT**: question **generation**, adaptive batching (≤3), follow-ups, vagueness/contradiction
detection, model-suggested assumptions on skip, or rationale — all **P2-005**; understanding re-evaluation and
"stale" dependent flagging — **P2-005 consumer + M3**; typed memory and provenance ranking — **P2-006/P2-007**;
the model gateway — **P2-003**. P2-002 provides the questions **table + insert primitive**; P2-005 drives the
generation that populates it.

## 2. Data model (migration 0013; additive; company-scoped; FORCE RLS)

Additive expand migration (0001–0012 untouched; **no** new SECURITY DEFINER — still exactly three; no BYPASSRLS;
no owner runtime). Two company-owned, dual-keyed FORCE-RLS tables mirroring the 0012/0008 patterns.

**`interview_questions`** — DATA-ARCHITECTURE Question (`C`, key `question_id, session_id`, mutability **I =
immutable**, lifecycle `asked → answered/skipped`):
- `id uuid pk`, `session_id` (FK `interview_sessions`, cascade), `account_id`, `company_id` (dual-key, FKs);
  `position integer` (order within the session); `prompt text` (the question text); `created_at`.
- **Immutable:** grants are `select, insert` only — no UPDATE/DELETE grant, so a question row never changes.
  The lifecycle `answered/skipped` is **derived** from the answers table (not a mutable column), keeping the
  row genuinely immutable.
- `unique (session_id, position)` — questions are ordered and gap-free within a session.

**`interview_answers`** — DATA-ARCHITECTURE Answer (`C`, key `answer_id, question_id`, **1:1 Question**,
mutability **A = revisions append**, lifecycle `given → revised (new row)`), modelled on the
`company_profiles` append-only-revision precedent (composite `(entity, version)` PK; current = max version):
- `question_id` (FK `interview_questions`, cascade), `revision integer` (≥ 1), `session_id`, `account_id`,
  `company_id` (dual-key); `status text` (`answered | skipped`); `content text` (NULL **iff** `skipped` — the
  "I don't know" path records a skip with no founder content); `created_by_user_id` (the author — accountability
  for every revision); `created_at`.
- **PK `(question_id, revision)`** — serializes concurrent writers (loser retries), last-write-wins with a
  visible, immutable history. **Current answer = max(revision) per `question_id`.**
- **Append-only:** grants are `select, insert` only — no UPDATE/DELETE. A revision is a **new row**, never an
  in-place edit. This IS the retained revision history (§4).

Both tables: **FORCE RLS**, dual-keyed fail-closed select/insert policies requiring `account_id =
current_account AND company_id = current_company` (a validated `CompanyScope`); identity columns immutable at
the privilege level; no DELETE/TRUNCATE.

## 3. Operations, idempotency, and authorization

- **Record answer / revise answer** (`interview:participate`): insert an `answered` row for a question. The
  FIRST answer is `revision = 1`; a subsequent, **different** answer is a new `revision = max+1`. Resubmitting
  the **identical** current answer (same status + content) is a **no-op** returning the current answer — this
  satisfies API-CONTRACTS "Answer submission idempotent per question" via the `company_profiles` rename
  precedent (a no-op when nothing changed), without a separate idempotency-token column. **Concurrency:** the
  `(question_id, revision)` PK + `ON CONFLICT DO NOTHING` serializes writers on the revision number, and the use
  case **retries (bounded)** on a conflict — re-reading the new current answer and re-evaluating. So two
  concurrent DISTINCT answers each land as their own revision (both retained, no lost content); a concurrent
  IDENTICAL answer collapses to the idempotent no-op. No writer ever sees a duplicate-key error.
- **Skip** ("I don't know") (`interview:participate`): a `skipped` answer row with NULL content. Re-skipping an
  already-skipped question is a no-op.
- **Read Q&A** (`interview:read`): a session's questions in order, each with its current answer + a bounded
  revision history. Redacted DTO; no accountId/actor ids.
- Authz reuses the P2-001 actions `interview:participate` (writes) and `interview:read` (read) — writing an
  answer is participating in the interview; both are owner|viewer company members (API-CONTRACTS "Company
  member"). No new authz action.
- **Question insert** is an internal primitive (P2-005 drives generation). P2-002 exposes it so answers have a
  question to attach to and the persistence path is testable end to end.

## 4. Audit / event emission — DEFERRED (persistence-only), with the reasoning

P2-002's **acceptance criterion is pure persistence**: *"Revision creates new row; history retained."* P2-002
delivers exactly that. On the "Revisions audited" security note, canon is resolved as follows and **no
audit-store event or domain event is emitted by P2-002**:

- **DATA-ARCHITECTURE Question audit = "—"** and **EVENT-CATALOG:48 `interview.question_answered` audit = "—"**
  — the answer write is deliberately **not** an audit-store event (per-answer audit rows would bloat the
  immutable audit store; the append-only answers table is the record).
- **REQUIREMENT-TRACEABILITY DISC-008** routes "Corrections audited" to **WORKFLOW §2 `superseded` + ADR-015 +
  `understanding.corrected`** (EVENT-CATALOG:50, "audited (DISC-008)", carrying `dependents_flagged`) — an
  **Understanding-layer (M3)** event, **out of P2-002 scope**. The audit-grade correction record is produced
  where dependents can be re-evaluated, which does not exist until M3.
- **`interview.question_answered`** is a **domain/outbox** event whose only consumers are Understanding
  (incremental) and typed memory (EVENT-CATALOG:48) — **neither exists yet** (P2-006/M3), and no transactional
  outbox is built. Emitting it now would have no consumer.
- The P2-001 contracts registry already records this: `interview.question_answered` is deliberately **not** in
  the closed `AUDIT_EVENTS` set ("a P2-002 concern and is NOT registered").

The **load-bearing argument** is not doc-precedence (the CLAUDE.md priority actually ranks the backlog *above*
the architecture docs) but the ticket's own scope + the governing ADR:

- P2-002's own backlog **acceptance / required-tests / verification / rollback** columns are pure persistence —
  *"Revision creates new row; history retained"* / *"Revision tests"* / *"API suite"* / *"Append-only"*. None
  names an audit-event emission. The "Revisions audited" security-column note is the obligation of **DISC-008**,
  a **cross-milestone** requirement (Discovery + Understanding) whose only listed test is **"Dependency
  re-evaluation tests"** — which cannot exist until dependents exist (M3), and which the traceability routes
  through WORKFLOW §2 `superseded` + `understanding.corrected`.
- **ADR-015** (the governing ADR) reserves an in-transaction audit write for **high-risk operations**
  (approvals, policy decisions, lifecycle transitions, ledger writes, emergency stops). A founder editing their
  own interview answer is not in that set — so ADR-015 does not oblige an in-tx audit event for an answer write.

**Therefore P2-002 persists and emits nothing.** Accountability is preserved at the data layer: every
answer/revision row is an **immutable, authored (`created_by_user_id NOT NULL`), timestamped** append — the
`acbp_app` role holds no UPDATE/DELETE grant on the table at all, so the history is tamper-resistant at the
privilege level, which is the core property an audit trail provides, and it satisfies "history retained". The
audit-store correction event (`understanding.corrected`, M3) and the `interview.question_answered` domain
fan-out are **deferred to when their consumers and the outbox exist** — exactly as P2-001 deferred
`interview.started`'s activity projection.

**Owner-visibility note:** this is the single interpretation made on a point where the backlog's one-word
"revisions audited" shorthand and the specific EVENT-CATALOG "—" / traceability→M3 routing diverge. It is
resolved toward the specific canonical sources and is **additive/reversible** — a dedicated audit-store event
for corrections can be registered later (or delivered as `understanding.corrected` in M3) without reworking the
append-only tables. Flagged here and in the PR so the owner can redirect if a P2-002-local audit event is
preferred.

## 5. Slice plan

1. **Contracts** (`@acbp/contracts`): the answer status set + redacted Question/Answer/QA-view DTOs + pure
   helpers (current-answer resolution, revision derivation); exhaustive unit tests. No new authz/audit.
2. **Migration 0013** `interview_questions` + `interview_answers` + real-PostgreSQL RLS/privilege/append-only/
   revision/catalog + down/up/reapply tests; existing suites' drop-lists extended.
3. **Core operations** (`@acbp/core` discovery): `recordAnswer` / `skipQuestion` / `getSessionQA` (+ the
   question-insert primitive) under fresh `CompanyScope`; append-only revision writes; idempotent no-op;
   real-PG revision/history/idempotency/isolation suite.
4. **API boundary**: authenticated routes to record/revise an answer, skip a question, and read the Q&A;
   strict parsing; bounded errors; forged-scope negatives; `next build`.
5. **Adversarial + docs**: real-DB HTTP adversarial (cross-tenant denial, forged claims, bounded errors);
   INTERVIEW.md Q&A section; reviews; finalization.

## 6. Out of scope / deferred (explicit)

Question generation/adaptivity/batching, vagueness/contradiction detection, suggested assumptions, rationale
(P2-005); understanding re-evaluation + stale flagging and `understanding.corrected` (M3); typed memory +
provenance consumption of `interview_answer` source refs (P2-006/P2-007); the model gateway (P2-003); the
`interview.question_answered` domain-event emission and any answer/correction audit-store event (§4, deferred).
