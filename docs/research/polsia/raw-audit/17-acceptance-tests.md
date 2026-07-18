# Acceptance tests

Each test should run against a disposable tenant and record an audit trace. `Observed` tests mirror visible Polsia behavior; `Recommended` tests define safe comparable-product behavior.

| ID | Scenario | Given/When | Expected |
|---|---|---|---|
| AT-001 | Create company modes | User opens New Company | Idea, Surprise me, and Existing business paths are available; brief is persisted without payment side effect. |
| AT-002 | Provisioning | Valid brief submitted | Email, code, database, hosting, site, documents, and initial tasks are created or each step fails visibly with retry. |
| AT-003 | Activity stream | Onboarding runs/retries | Events are ordered, timestamped, correlated, and never claim success without a receipt. |
| AT-004 | Dashboard | Active company opened | Company-scoped modules load; another company’s data is absent. |
| AT-005 | Task controls | Task detail opened | State, type, age, description, delete/repeat/run-now controls are visible; destructive controls require confirmation. |
| AT-006 | Cycle | Scheduled cycle starts | Review, signal collection, planning, allowed execution, dashboard update, and report events appear in order. |
| AT-007 | Run-now credit | User requests manual run | Preflight shows credit cost and side effects; insufficient credit blocks execution; ledger is atomic. |
| AT-008 | Failure recovery | Provider/tool fails | Task becomes Failed with reason, retryability, last attempt, and no duplicate external side effect. |
| AT-009 | Approval gate | Agent proposes post/email/spend/delete | Proposal is queued; execution endpoint rejects missing/expired/mismatched approval. |
| AT-010 | OAuth | User authorizes connector | Scopes, account identity, consent timestamp, health, disconnect, and reauth are visible; token is masked. |
| AT-011 | Event narrative | Provider event arrives twice | One normalized event and one narrative are produced; duplicate is ignored and provenance is shown. |
| AT-012 | Report delivery | Scheduled email/Slack report runs | Recipient/channel policy is checked, delivery receipt or failure is stored, retries are bounded. |
| AT-013 | Social publish | Draft approved | Exact approved content hash is published once; provider receipt and URL are stored. |
| AT-014 | Company email | Outbound message proposed | Consent, recipient, content, unsubscribe/legal checks and approval are recorded before send. |
| AT-015 | Public site | Preview/deploy succeeds | URL loads, health check passes, version is recorded, and unavailable site shows truthful status. |
| AT-016 | Rollback | Prior healthy version exists | Rollback requires approval, deploys prior immutable artifact, and records outcome. |
| AT-017 | Secrets | Secret added/changed | Value is masked, excluded from logs, and becomes active only after next deploy. |
| AT-018 | Code export | User requests download | Export contains source/config template but no secret values; checksum and revision are shown. |
| AT-019 | Metrics | No traffic/payment exists | UI distinguishes zero from unknown and shows source/timestamp. |
| AT-020 | Billing/credits | Spend/refund/expiry occurs | Ledger is append-only, balance reconciles, and plan/portal status is truthful. |
| AT-021 | Ads | Campaign exceeds budget | Platform blocks creation or pauses spend at cap; fee and approval are explicit. |
| AT-022 | Team invite | Invite sent | Invite grants only selected company; revoke removes access; audit event includes actor and scope. |
| AT-023 | Documents | Mission/roadmap edited | New version retains author/provenance and links to dependent tasks. |
| AT-024 | Chat intent | User asks for an action | System classifies intent, previews cost/resources, asks approval when needed, then traces execution. |
| AT-025 | Credit race | Two runs spend final credit | One succeeds; one receives deterministic insufficient-credit result; no negative balance. |
| AT-026 | Pause/deactivate | Company paused/deactivated | Scheduled work stops; data remains; public-site state and reactivation path are truthful. |
| AT-027 | Isolation attack | Member requests another company ID | API and database deny access; denial is audited without leaking existence. |
| AT-028 | Uncertainty | Evidence conflicts or is missing | UI marks unknown/partial/inferred; no generated claim is presented as observed fact. |

## Exit criteria

All Must requirements have automated coverage for authorization, idempotency, auditability, and failure handling. No P0 security, privacy, billing, or irreversible-action defect remains open.
