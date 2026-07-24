# ACBP-P2-001 — independent review coverage

Two independent reviewers examined the complete diff (`main...edaa9ad`) of the interview session slice against
the CDR-022 tenancy/authz/audit/state-machine claims and the CLAUDE.md rules. Both ran against the real-PG test
evidence, not mocks.

## Security review — CLEAN

No HIGH/MEDIUM/LOW production-security findings across all seven axes: tenant isolation (dual-keyed FORCE RLS,
fail-closed without the company GUC, column-immutable identity, no DELETE/TRUNCATE), authorization (fresh
company-role check on every op; non-member and cross-company denied at scope resolution), audit integrity
(`interview.started` written in the session-start transaction; actor/account/company scope-stamped; subject =
session id; the audit-completeness partition still 1:1), no new privilege (three SECURITY DEFINER unchanged, no
BYPASSRLS, no owner runtime, migrations 0001–0012), leakage (redacted DTO; one coarse 403; bounded malformed
handling; no PII logs), no secrets/real identifiers, and state-machine safety (deny-by-default transition map;
optimistic from-state backstop; one-open-session partial index). Two non-security observations were raised and
are dispositioned below (SR-1, SR-2).

## Architecture / scope review — substantially clean

Scope fidelity PASS (every backlog column satisfied; no P2-002/P2-005/M3 scope leaked; all deferrals honored),
state-machine fidelity PASS (exact match to WORKFLOW §2), layering PASS (contracts zero-dep; core no provider
SDK; database Kysely-parameterized; apps/web only through @acbp/core; no cycle), canon + precedent consistency
PASS, test adequacy STRONG (no vacuous assertions). One MEDIUM doc/impl contradiction and four LOW items,
dispositioned below.

## Finding dispositions (all addressed at the review-fix commit)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| AR-MEDIUM-1 / SR-2 | Medium/Info | CDR-022 §2 claimed `startInterviewSession` "does not insert directly into in_progress", but the impl mints the row directly in `in_progress`. Functionally safe (atomic mint-and-enter; no client observes `not_started`), but the accepted CDR made a false claim about the code. | **FIXED (doc):** CDR-022 §2 rewritten to describe the atomic mint-and-enter (the row is born in `in_progress` with `started_at`, the state the entry produces; a separate UPDATE would be a pointless extra write nothing observes), while suspend/resume genuinely exercise the guard. No behavior change. |
| SR-1 / AR-LOW-2 | Low | Concurrent first-starts: both pass `findOpen`, the loser hits the partial-unique 23505 and surfaces as a bounded 500 instead of the graceful idempotent 200. Not a vulnerability (the index prevents the second row; the tx rolls back cleanly). | **FIXED (code):** `insertStarted` → `insertStartedIfAbsent` uses `ON CONFLICT (company_id) WHERE state <> 'superseded' DO NOTHING`; a null return means a concurrent winner exists, so the loser re-reads and returns the existing open session (`created: false`) with no second audit. New real-PG test drives two concurrent starts → exactly one session + one audit, both callers `ok`. Matches the P1-002 receipt-insert conflict precedent. |
| AR-LOW-1 | Low | Dead code: `InterviewSessionRepository.lockById` was never called (the guarded optimistic UPDATE is used instead). | **FIXED (code):** removed. |
| AR-LOW-3 | Low | EVENT-CATALOG.md:47 listed `interview.started` with a populated `activity` column and no annotation that the fan-out is deferred (CDR-022 §4). | **FIXED (doc):** the activity cell now reads "activity (deferred — see note)" and a Notes section records the audit-only-now / project-later decision and its rationale. |
| AR-LOW-4 | Low | Migration 0012's `started_at` shape CHECK is a biconditional, stricter than the one-directional expression written in CDR-022 §5. The implemented (stricter) form is better. | **FIXED (doc):** CDR-022 §5 now states the biconditional the migration actually enforces. |

## Residuals

None. Every finding is a fix (three docs, one behavior-hardening + test, one dead-code removal); no finding was
accepted-as-is. No security or tenant-isolation defect was found.
