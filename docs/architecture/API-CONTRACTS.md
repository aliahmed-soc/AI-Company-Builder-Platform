# API Contracts

Status: Proposed. Implementation-neutral domain contracts — not endpoint code. Global rules first; per-domain tables follow.

## Global mutation requirements

Every state-changing request carries / resolves, where applicable:

| Element | Rule |
|---|---|
| Actor | From authenticated session; never from request body |
| Tenant | Resolved server-side from membership (invariant 2) |
| Idempotency key | Client-supplied `Idempotency-Key` honored on all mutations; required for run-triggering and (future) external-effect operations (NFR-006) |
| Expected object version | Optimistic concurrency (`expected_version`) on versioned objects (understanding, roadmap, policies) |
| Correlation ID | Accepted or generated; propagated to jobs, tool calls, model calls, events (ADR-017) |
| Approval reference | Required by the dispatcher for approval-gated actions; validated server-side (APPR-009) — never trusted from the client as authorization by itself |
| Policy-evaluation reference | Attached by the server to gated mutations (POL-006) |
| Audit event | Every mutation emits one; high-risk mutations write audit in-transaction (ADR-015) |
| Usage implication | Declared per operation below; metering failure fails closed for metered operations (USAGE-001) |

**Global response rules:** no secret values in any response object (NFR-018, invariant 13); no raw provider errors to users — gateway-normalized categories only (ADR-011); error envelope: `{category, user_message, correlation_id, retryable}`; error categories: `validation` · `authn` · `authz` · `not_found` (tenant-safe: indistinguishable from denial) · `conflict` · `limit_exceeded` · `policy_blocked` · `approval_required` · `provider_unavailable` · `internal`.

## Domains

| Domain | Main operations | Request concepts | Response concepts | AuthZ | Idempotency | Audit | Req IDs |
|---|---|---|---|---|---|---|---|
| Authentication | register, verify email, login, logout, refresh session | credentials, verification token | session (opaque), user summary | Public (rate-limited) → session | Verification tokens single-use | auth.* events; failed logins rate-limited+audited | ACC-001/002 |
| Accounts | get, update profile, deactivate, request deletion | profile fields, confirmations | account view | Account owner | Deletion request idempotent | Lifecycle audited; deletion two-step | ACC-003/004/005 |
| Memberships | invite (company-scoped), accept, revoke, list | invitee, company scope, role | membership view | Owner (invite/revoke) | Invite tokens single-use | role/revocation audited | ADMIN-003 |
| Companies | create, get, list (portfolio), rename, pause, resume, deactivate, delete | creation mode + brief; lifecycle confirmations | company view, portfolio rows, status | Member (read), owner (lifecycle) | Create idempotent via key | company.* events; delete = COMP-007 flow | COMP-001..008, PORT-001..004 |
| Provisioning (implemented P1-012) | status (GET), resume (POST — the ONLY mutation; no start/retry/acknowledge/cancel) | none (companyId route selector only; no params/body) | ordered six-step status {companyId, companyStatus, steps, nextIncompleteStep, resumable, exhausted, completed} | Member (read), owner (resume) | Resume idempotent; exhausted → safe 409 | provisioning.* audit-only events (never activity) | COMP-002/003, CDR-018 |
| Admin (implemented P1-013) | ONE operation: POST /api/admin/accounts/[accountId]/companies/[companyId]/read (no list/search/mutation/impersonation/audit-export/UI/SSE) | body EXACTLY {reason} (verbatim, ≤512 code points, no NUL; unknown properties + every query param rejected; validated before any DB work) | exactly {companyId, status, creationMode, createdAt} — never accountId/actor/reason echo | Platform admin ONLY (fresh platform_admins self-check; tenant roles/Clerk claims never grant); ONE coarse 403 for every denial (no existence oracle) | n/a (read; each request re-verifies + re-audits) | admin.tenant_read written in the TARGET tenant's trail BEFORE response (audit failure → bounded 500, no data); audit-only, never activity | NFR-002, CDR-019 |
| Discovery interviews | start/resume session, get next batch (≤3), answer, revise answer, skip ("I don't know"), get rationale | answers, revisions | question batch, session progress (honest), suggested assumptions | Company member | Answer submission idempotent per question | interview.* events; revisions audited | DISC-001..008 |
| Business understanding | get current, review item (approve/edit/reject/request-evidence/request-research), confirm overall | item decisions, edits + expected_version | classified items with confidence, staleness flags | Owner (confirm), member (read) | Item decisions idempotent | understanding.* events | UNDER-001..005 |
| Strategy options | list for understanding version, request another, select, edit, combine, reject | selection/edit/combination payloads | 16-field options, similarity check result, AI recommendation + rationale | Owner (select) | Selection idempotent | strategy.*, decision.recorded (immutable) | STRAT-001..006 |
| Decisions | list, get | — | immutable decision records with linked context | Member (read) | n/a (read) | — (records are the audit) | STRAT-006 |
| Goals / Roadmaps | get, edit (versioned), list milestones | edits + expected_version + reason | roadmap versions, affected-task flags | Owner (edit) | Version-guarded | ROAD-002 version audit | ROAD-001/002, PLAN-001 |
| Tasks | list (by state), get detail, create (via planning or chat), reject, repeat, delete, cancel, request stop | steering text, control actions | task views incl. failure detail (TASK-006), retry visibility (TASK-010) | Member (read), owner/operator (controls) | Run-trigger + repeat idempotent (key) | task.* events; delete confirmed | TASK-001..010, PLAN-002 |
| Task runs | run now (with preflight), get run trace | preflight ack, idempotency key | preflight (credit cost, side-effect class), run trace with tool calls | Owner/operator | **Required** — one credit spend per key (BILL-002 race rule) | run + ledger atomic | TASK-004, USAGE-001 |
| Approvals | list inbox, get request (full APPR-002 content + preview), approve, reject, edit-then-approve, schedule, batch-approve, revoke | decision + optional edited payload (rebinds hash) | approval views with payload digest, expiry | **Approver/owner only; actor-type human/delegated (invariant 5)** | Decisions idempotent per approval | approval.* events, in-tx | APPR-002..010 |
| Policies | get effective policies, update limits/forbidden lists | policy config + expected_version | versioned policy views | Owner | Version-guarded | policy changes audited | POL-001/005/006 |
| Workers | list definitions, get, pause/disable per company | control actions | worker views: capability, allowlist, status | Owner (controls) | Idempotent toggles | WORK-006 audits | WORK-001..006 |
| Tools | list registry (risk classes), get call records | — | tool defs; call records with policy/approval refs | Member (read); registry mutation = admin | n/a (read) | TOOL-002 completeness | TOOL-001/002 |
| Memory | list/filter items, get, edit, delete, resolve source link | edits, deletions | typed items with provenance + confidence | Owner (edit/delete), member (read) | Edit version-guarded | MEM-002/003 audits | MEM-001..004 |
| Documents | list, get (+versions), download, rate usefulness, request revision | revision guidance | documents with provenance (worker, inputs, model version); revision lineage | Member (read), owner (revise) | Revision request idempotent | provenance complete | TASK-005, J-12/J-13 |
| Usage | get company usage, get account rollup, get ledger | period filters | usage views separating technical usage / provider cost / billable / entitlement / credits (ADR-013 §5) | Owner; account rollup = account owner | n/a (read) | — | USAGE-001/002, BILL-002 |
| Billing | get subscription, portal handoff link, purchase credits, cancel | — | entitlement view, portal URL | Account owner | Purchase idempotent via provider | billing audits; webhook signature-verified | BILL-001..006 (Phase 7) |
| Activity | feed (paged, filtered), SSE stream | filters | events with proposed-vs-executed marking (ACT-003) | Company member | n/a (read) | — | ACT-001..005, DEC-001 |
| Audit | export range (admin/owner), integrity status | date range | redacted audit export | Owner (own company), admin (reason-captured) | n/a (read) | export itself audited | ACT-002, NFR-008 |
| Integrations | list connections, connect (OAuth dance), get health, revoke | provider, scopes | connection views (identity, scopes, health — never tokens) | Owner | Revoke idempotent | integration.* events; revoke = fail-closed enforcement | INTEG-001/003 (Post-MVP) |
| Exports | request export (scopes), get status, download | scope selection | export job status, manifest, archive link (tenant-scoped signed URL) | Owner | Request idempotent | export audited; ownership check (invariant 19) | EXPORT-001/002 (Post-MVP) |
| Emergency stop | activate (scope), clear, list held work, review/confirm/discard held items | scope + target | stop states, held-work queue | Owner | Activate/clear idempotent | emergency_stop.* + resume review audits | ADMIN-001/002 |
