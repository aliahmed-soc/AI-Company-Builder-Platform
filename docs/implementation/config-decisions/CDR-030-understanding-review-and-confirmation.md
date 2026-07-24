# CDR-030 — Understanding review and confirmation (ACBP-P2-009)

**Status:** Accepted (autonomous lead, standing Phase 2 authorization). **Requirements:** UNDER-003 (review
controls), UNDER-004 (assumption lifecycle), DISC-008 (answer correction → dependency re-evaluation). **Governing
ADR:** ADR-015 (append-only audit; high-risk lifecycle transitions write audit in the same transaction).
**Architecture:** WORKFLOW-STATE-MACHINES §2 (understanding lifecycle `ready_for_review → confirmed ⏹ → superseded`),
API-CONTRACTS "Business understanding" domain, diagrams/04 (`review`/`flag`/`confirmed` nodes), DATA-ARCHITECTURE §3
(`confirmation_state`, `superseded_by`), EVENT-CATALOG (`understanding.confirmed`, `understanding.corrected`).
**Depends on:** P2-008 (Done — `understanding_documents`/`understanding_items`, migration 0019). **No open question
blocks it** (no IMPLEMENTATION-OPEN-QUESTIONS entry references P2-009).

Implement the owner's **review + confirmation gate** over a generated understanding version: the five per-item
controls, the owner-only overall confirm that unlocks strategy, and the DISC-008 correction that supersedes a
confirmation and flags dependents. This is the planning gate — **strategy generation (P3-001) is blocked until an
understanding version is confirmed.** No model call is made (BACKLOG Usage column = "—"); request-evidence /
request-research are **queued records** a later worker fulfils, never live execution — so P2-009 crosses **no**
live-provider gate (CDR-026 §0 stays closed).

## 1. What is reviewed / confirmed — the understanding-document VERSION (not the session)

P2-008 deliberately decoupled understanding generation from the interview session: `understanding_documents`
(migration 0019) is a company-owned, **immutable, versioned** artifact keyed by `(company_id, version)` with **no
`session_id`** — `generateUnderstanding` reads typed memory and writes a version; it never transitions the session.
Accordingly, **P2-009 models review and confirmation at the understanding-document-version grain**, which is exactly
what API-CONTRACTS specifies ("get current, review item …, confirm overall" with `item decisions, edits +
expected_version` optimistic concurrency on the *understanding version*). This is the safer, reversible
interpretation: it respects 0019's immutability, adds no mutation path to a merged table, and does **not** retrofit
session-state wiring into the already-merged P2-008.

**Interview-session lifecycle sync is an explicit out-of-scope boundary (deferred to P2-012 Slice B integration).**
The `interview_sessions` state machine (`ready_for_review → confirmed → superseded`, `@acbp/contracts` `interview.ts`)
remains the canonical *session* lifecycle, but because generation never advanced a session into `ready_for_review`,
P2-009 does not drive session transitions from the understanding gate. The confirmation gate defined here is the
authoritative strategy-unlock signal; joining it to the session state machine is the integration ticket's job. This
boundary is documented so no reader assumes the session automatically flips to `confirmed`.

## 2. The five review controls (UNDER-003; API-CONTRACTS; diagram 04 `review`)

The five owner controls over an item of a *specific* understanding version:
`approve · edit · reject · request_evidence · request_research`.

- Recorded as **append-only events** in `understanding_item_reviews` (one row per decision; the item's *effective*
  review state is its latest event). `understanding_items` (0019) stays immutable — an **edit records the owner's
  corrected text in the review row** (`note`), a supersede-pointer at the review layer, never an UPDATE of the item.
- **reject** — "Rejected items return to interview" (BACKLOG Failure column): the rejection is recorded with an
  optional reason in `note`; the effective understanding excludes rejected items. The actual re-interview visit is
  the discovery flow (not re-implemented here) — P2-009 records the rejection signal it consumes.
- **request_evidence / request_research** — **queued** requests (Usage = "—"): a decision row with the request note.
  A later Research worker (P5) fulfils them. No live model/tool call is made in P2-009.
- **Idempotency** (API-CONTRACTS "Item decisions idempotent"): a retried decision must not error or double-apply.
  The append-only log tolerates retries; a caller-supplied `expected_version` guards staleness (below), and
  re-recording the same latest decision is a no-op at the effective-state layer.
- **Optimistic concurrency** (API-CONTRACTS line 14): every item decision carries `expected_version` = the
  understanding version the owner is reviewing. A decision against a **non-current** version (a newer version was
  generated meanwhile) is rejected as **stale** — never silently applied to superseded content.

Authorization: item review decisions and the overall confirm are **owner-only** (`understanding:review`,
`understanding:confirm`); reading stays owner+viewer (`understanding:read`, P2-008). This matches API-CONTRACTS
"Owner (confirm), member (read)" and the UNDER-003 "Owner-only confirm" traceability. Review is a corrective,
owner-authority operation, so it is registered owner-only rather than folded into the owner+viewer read grant (the
closed-registry, no-overloading convention established by P2-010's `memory:edit`/`memory:delete`).

## 3. Overall confirm — the strategy gate (WORKFLOW §2 line 30; owner only)

`ready_for_review → confirmed` is **owner only**. Confirming records a `confirmed` event in
`understanding_confirmation_events` for the **current** understanding version. Preconditions:
- the version being confirmed is the company's **current (max) version** and `expected_version` matches (a stale
  confirm of a superseded version is rejected);
- "Must-sections resolved" (WORKFLOW §2): the required sections are not left unaddressed — for MVP this is the
  current-version + expected_version check plus that at least one review decision exists / the document is present;
  the closed section set is the six understanding classes (0019). (No new "must-section" config is invented; the
  gate is version-currency + reviewed.)

**Effect:** the confirmation event is the queryable **strategy-unlock token**. `isCurrentUnderstandingConfirmed`
(a company-scoped read) is true IFF the current version has a `confirmed` event and **no** `corrected` event. Strategy
generation (P3-001) consults this predicate; **planning is blocked while it is false** ("planning blocked pre-confirm"
acceptance). Confirming writes `understanding.confirmed` (metadata `{version, confirmed_by}`) **in the same
transaction** (ADR-015 audit-or-nothing). Idempotency: `UNIQUE(document_id, kind)` + `ON CONFLICT DO NOTHING` — a
repeat confirm of an already-confirmed version is a graceful no-op.

## 4. Correction / supersede — DISC-008 dependents flagged (WORKFLOW §2 line 31)

`confirmed → superseded` occurs on a **material correction** (DISC-008). Because the tables are append-only, a
correction does **not** UPDATE the confirmation; it records a `corrected` event in
`understanding_confirmation_events` (`UNIQUE(document_id, kind)`), which supersedes the confirmation: the
strategy-unlock predicate flips back to false ("new session/version opens; dependents flagged"). The correction event
carries `correction_ref` (what changed, bounded) and `dependents_flagged`.

**Dependents in the MVP schema:** the only concrete downstream artifact of a confirmed understanding is the
**strategy unlock** (strategy options do not exist until P3-001). A correction therefore flags the strategy stage
stale by revoking the unlock — `dependents_flagged` records the count/label of downstream stages invalidated (MVP:
`strategy`). This is the honest, testable realization of "corrections flag dependents": after a correction the gate
re-blocks planning until a new version is generated (P2-008) and re-confirmed. Emits `understanding.corrected`
(metadata `{version, correction_ref, dependents_flagged}`, DISC-008) **in the same transaction** (ADR-015).

## 5. Schema — migration 0020 (additive; two tables)

Additive (0001–0019 untouched; **no new SECURITY DEFINER — still exactly three**; no BYPASSRLS; no new role; no
owner runtime). Two company-owned, **dual-keyed FORCE-RLS, append-only** tables (the 0019 pattern):

- `understanding_item_reviews`: `id`, `account_id`, `company_id`, `document_id` (FK `understanding_documents`),
  `item_id` (FK `understanding_items`), `decision` (CHECK in `approved | edited | rejected | evidence_requested |
  research_requested`), `note` (nullable, bounded — edited text / reject reason / request note), `decided_by_user_id`,
  `created_at`. **SELECT + INSERT** grants only (append-only event log). Dual-keyed (account AND company) fail-closed
  RLS policies.
- `understanding_confirmation_events`: `id`, `account_id`, `company_id`, `document_id` (FK
  `understanding_documents`), `version` (int), `kind` (CHECK in `confirmed | corrected`), `actor_user_id`,
  `correction_ref` (nullable, bounded — set only for `corrected`), `dependents_flagged` (nullable int — set only for
  `corrected`), `created_at`. **UNIQUE `(document_id, kind)`** (idempotent confirm; one correction per version).
  **SELECT + INSERT** grants only. Dual-keyed fail-closed RLS.

Cross-company reads/writes are impossible (both keys enforced). Every schema-reset list, the two-tenant harness
`ALL_TABLES`, and every catalog/grant assertion is updated **in the same slice** as the migration (the P2-003
reset-list lesson — never omit a table from a reset list).

## 6. Audit + tenancy + composition

Two NEW registered audit events (already catalogued as P2-009 in EVENT-CATALOG): `understanding.confirmed`
(subject `understanding_document`, metadata `{version, confirmed_by}`) and `understanding.corrected` (subject
`understanding_document`, metadata `{version, correction_ref, dependents_flagged}`). Both are added to the
`@acbp/contracts` `AUDIT_EVENTS` registry and the `@acbp/core` `AUDITED_OPERATIONS` compile-exhaustive partition in
the **same** change (the two must move together). Two NEW authored operations map to them:
`understanding.review-decision` (per-item; audited so item decisions are non-repudiable — BACKLOG "Item decisions
audited") and the confirm/correct operations. Metadata is bounded and **carries no item content or PII**.

Every mutation runs in a **fresh company scope** (`runInCompanyScope`) with the server-resolved account/company/actor
and the owner-only authz check; the review/confirm/correct write + its audit event are one transaction
(audit-or-nothing). No browser-supplied identity is trusted; internal DB state is authoritative.

## 7. Slice plan

1. **CDR-030** (this) + branch + draft PR.
2. **Contracts**: review-decision + confirmation-event enums/DTOs, `expected_version` staleness helper, the
   `isCurrentUnderstandingConfirmed` gate shape, `understanding.confirmed`/`understanding.corrected` audit
   registration, `understanding:review`/`understanding:confirm` authz actions (owner-only). Unit-tested; exact-set
   audit/authz enumeration tests updated.
3. **Migration 0020** + repo/schema + **every** reset list/catalog assertion + real-PG lifecycle/RLS/privilege suite.
4. **Core**: `recordUnderstandingReview`, `confirmUnderstanding`, `correctUnderstanding`, and the
   `isCurrentUnderstandingConfirmed` gate — owner-only, company-scoped, audit-in-tx; integration tests (5 controls,
   gate blocks pre-confirm, correction flags dependents, idempotency, staleness, cross-company negatives).
5. **Docs** (API-CONTRACTS status notes, DATA-ARCHITECTURE, AUTHORIZATION, AUDIT, EVENT-CATALOG, INTERVIEW,
   PROJECT-STATE, EXECUTION-LOG) + review coverage + reviews + finalize.

## 8. Out of scope / deferred

Strategy option generation and its consumption of the unlock predicate (P3-001); the HTTP understanding review/confirm
routes + live provider (CDR-026 §0 — sequenced with the live provider, exactly as P2-008 deferred its routes);
interview-session-state sync to the confirmation gate (P2-012 Slice B integration, §1); actual Research/evidence
worker fulfilment of queued requests (P5); context assembly (P2-007); the evaluation suite (P2-011). No migration 0021.
