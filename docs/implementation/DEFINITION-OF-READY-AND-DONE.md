# Definition of Ready and Done

Status: Proposed for owner review. Applies to every ticket in `BACKLOG.csv`. Aligned with the standing project protocol (`.cursor/rules/model-routing.mdc`).

## Definition of Ready

A ticket may enter implementation only when it has **all** of:

1. Clear objective (one sentence, testable)
2. User or system value stated
3. Requirement IDs (from `REQUIREMENTS.csv`) or an explicit technical-foundation rationale
4. Governing ADRs listed
5. Dependencies listed (valid ticket IDs)
6. Scope boundaries — explicit non-scope stated
7. Acceptance criteria (executable, not aspirational)
8. Failure behavior defined
9. Security considerations recorded
10. Data ownership (tenant) stated for any persisted object
11. Audit implications stated
12. Usage implications stated (or "none")
13. Verification procedure (command or scripted steps)
14. **No unresolved decision that materially changes implementation** — if a `Blocked by questions` entry exists, the ticket is *not Ready* until the decision ticket resolves it

`BACKLOG.csv` carries a `Definition of Ready` column: `Ready` | `Ready-pending-decision(<ticket>)` | `Draft`.

## Definition of Done

A ticket is Done only when **all** of:

1. Requested scope implemented — nothing silently narrowed
2. Acceptance criteria pass (evidence recorded)
3. Relevant tests pass (targeted first, then affected suites)
4. Negative tests exist and pass where trust-critical
5. Tenant checks exist where the ticket touches tenant-owned data
6. Authorization is server-side
7. Audit behavior implemented as specified
8. Usage behavior implemented where applicable
9. Logs verified redacted (no new scanner findings)
10. Documentation updated (module README / architecture docs when contracts changed)
11. No placeholder behavior remains in requested functionality
12. No known requested failure is hidden
13. Verification evidence recorded in the completion handoff (protocol format)
14. `REQUIREMENT-TO-TICKET-TRACEABILITY.csv` updated if coverage changed

## Status definitions

| Status | Use when |
|---|---|
| **Done** | Every DoD item satisfied; verification evidence recorded. Never used with failing tests, skipped verification, placeholders, or hidden defects (protocol §9). |
| **Partial** | Useful work landed; some scope/verification remains; completed vs incomplete portions explicitly listed. |
| **Blocked** | A required decision, dependency, credential, or environment is unavailable; the smallest unblocking action is named. |
| **Rejected** | Owner/reviewer declines the approach; reason recorded; requirement coverage re-planned. |
| **Superseded** | Replaced by another ticket; successor referenced; traceability updated so no requirement silently loses coverage. |
