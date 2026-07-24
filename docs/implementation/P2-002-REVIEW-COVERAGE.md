# ACBP-P2-002 — independent review coverage

Two independent reviewers examined the complete diff (`main...0cc26bd`) of the Q&A persistence slice against
CDR-023 and the CLAUDE.md rules, running against the real-PG test evidence (not mocks). Both were asked to
render an explicit verdict on the CDR-023 §4 audit-deferral decision.

## Security review — CLEAN

No HIGH/MEDIUM production-security findings across all axes: tenant isolation (both tables dual-keyed under
FORCE RLS, fail-closed without the company GUC; every op under runInCompanyScope on scope.db), authorization
(interview:participate/read from the fresh company role; the client cannot inject a sessionId — resolved
server-side; a question from a foreign/superseded session cannot be answered), append-only/immutability
(SELECT+INSERT grants only; a revision is a new row; concurrent race graceful with no 500), data minimization
(no accountId/actor/content in DTOs/logs/errors; coarse 403; bounded malformed handling), no new privilege
(3 SECURITY DEFINER, no BYPASSRLS, migrations 0001–0013), no secrets/real identifiers. **§6 verdict: the audit
deferral is ACCEPTABLE — accountability is tamper-resistant at the privilege level (no UPDATE/DELETE grant),
the deferred events have no consumer, and a correction event is additive/reversible; NO P2-002-local audit
event is warranted.**

## Architecture / scope review — CLEAN, no must-fix

Scope faithful (every backlog column met; no P2-005/M3/P2-006 leakage; all deferrals honored), data model an
exact match to DATA-ARCHITECTURE:18-19 (immutable questions; append-only answers, current = max revision;
company_profiles precedent), layering clean (no new dep/cycle; contracts zero-dep; core no provider SDK;
database Kysely-only; web only through @acbp/core), precedent consistency strong (dual-keyed FORCE RLS, redacted
DTOs, bounded errors, server-side open-session resolution, addInterviewQuestion as the P2-002/P2-005 seam), test
adequacy strong (no vacuous assertions). **§2 verdict: acceptable-as-documented — deferring the audit is a
legitimate, reversible, correctly-flagged scope decision, NOT a mandatory owner gate; P2-002 should NOT register
an audit event now.**

## Finding dispositions (all addressed at the review-fix commit; none accepted as-is)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| SR-LOW-1 | Low (hardening) | `created_by_user_id` was nullable, so authorship rested on convention, not a DB constraint — weakening the accountability the audit-deferral argument relies on. | **FIXED (migration + schema):** `created_by_user_id` is now `NOT NULL` — accountability is structural. A new real-PG assertion proves a null author is rejected. (This is a deliberate divergence from the `company_profiles` nullable-author precedent, whose nullability existed for *system-authored* profile revisions; an interview answer is always founder-authored.) |
| SR-LOW-2 / AR-LOW-4 | Low (correctness/UX) | Concurrent DISTINCT answers dropped the loser's content, and CDR-023 §2 said "loser retries" while the impl did not retry (collapsed to a no-op). | **FIXED (code + doc):** `recordInterviewAnswer` now performs a **bounded retry** on an `ON CONFLICT` — re-reading the new current answer and re-appending the loser's distinct content at the next revision (both retained), or collapsing to the idempotent no-op when the winner wrote the same content. Two new real-PG tests prove concurrent DISTINCT answers both persist (revisions 1,2,3; contents v1,v2a,v2b) and concurrent IDENTICAL answers collapse to one new row. CDR-023 §2 rewritten to describe the bounded retry. |
| AR-LOW-1 | Low (doc framing) | CDR-023 §4's "specific EVENT-CATALOG '—' overrides the backlog shorthand" wording, read literally, inverts the CLAUDE.md priority (backlog outranks architecture docs). | **FIXED (doc):** §4 now leads with the load-bearing argument — P2-002's own backlog acceptance/test/rollback columns are pure persistence, "Revisions audited" is the obligation of the cross-milestone DISC-008 (whose only test is M3-gated), and ADR-015 reserves in-tx audit for high-risk operations (an answer edit is not one). The doc-precedence phrasing is softened. |
| AR-LOW-2 | Low (doc consistency) | EVENT-CATALOG:48 `interview.question_answered` "—" stood unannotated, unlike the P2-001 `interview.started` deferral note. | **FIXED (doc):** the row's consumers cell now reads "(deferred — see note)" and a parallel Notes entry records the audit-only/no-consumer/no-outbox deferral and the accountability argument. |
| AR-LOW-3 | Low (dead code) | `contracts/qa.ts` `nextRevision` was defined + unit-tested but the core recomputed inline (invites drift). | **FIXED (code):** `nextRevision` and its unit test removed; the retry loop computes from `currentAnswer().revision`, and `currentRevision` (still used by `getSessionQa`) remains. |

## Residuals

None. Every finding is a fix (two docs, two behavior/schema hardenings + tests, one dead-code removal); no
finding was accepted-as-is. Both reviewers rendered an explicit verdict that the CDR-023 §4 audit-deferral is
acceptable and not an owner gate; it is flagged for owner visibility as an additive/reversible interpretation.
