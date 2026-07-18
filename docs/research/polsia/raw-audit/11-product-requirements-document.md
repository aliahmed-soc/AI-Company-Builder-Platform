# Product Requirements Document

## Scope and evidence discipline

This PRD describes the product reconstructed from the authenticated Polsia dashboard, public company site, first-party FAQ, documents, and safe UI exploration on 2026-07-18 (Africa/Cairo). **Observed** means directly visible in the product; **documented** means stated by Polsia in FAQ or generated product documents; **partial** means only one path or a limited sample was observed; **inferred** means a design implication, not a claim about private implementation; **unknown** means not verified. No private APIs, source code, database, deployment console, or paid/irreversible action was inspected.

## Product outcome

Polsia presents a company as an autonomous operating system: a founder supplies an idea or existing business, the system provisions a workspace and public site, plans and executes tasks, monitors connected channels, sends communications, and reports progress. The comparable product must preserve human control for consequential actions while making routine operating work continuous and explainable.

## Personas

- **Founder/operator** — defines the company, approves sensitive work, watches metrics, and downloads or requests code changes.
- **Collaborator** — receives scoped access to one company; team invite behavior was observed but not completed.
- **Customer/prospect** — interacts with the generated public site, email, social posts, ads, or payments.
- **Platform operator** — manages safety, billing, integrations, usage, and incident recovery (recommended role; not directly observed).

## Functional requirements

| ID | Requirement | Evidence status | Priority | Acceptance summary |
|---|---|---|---|---|
| PRD-001 | Create a company from an idea, surprise-me prompt, or existing-business brief | documented; partial UI | Must | New Company exposes all three entry modes and persists a company brief. |
| PRD-002 | Provision a company workspace | observed; documented | Must | Onboarding records setup of email, codebase, database, hosting, sandbox, site, roadmap, mission, research, and tasks; failures are visible and retryable. |
| PRD-003 | Show onboarding progress as an activity stream | observed | Must | Each stage is timestamped, ordered, and ends in an explicit completed/failed state. |
| PRD-004 | Provide a company dashboard | observed | Must | Dashboard exposes mood/status, tasks, social, metrics, documents, email, teams, website, ads, chat/activity, and settings entry points. |
| PRD-005 | Generate and manage tasks | observed; documented | Must | Tasks have state, type, creation time, description, delete/repeat/run-now controls, and credit accounting. |
| PRD-006 | Support scheduled autonomous operating cycles | documented; partial | Must | A cycle reviews state, checks signals, plans tasks, executes allowed work, updates dashboards, and reports a result. |
| PRD-007 | Support manual task execution | documented; partial | Should | Run Now consumes one task credit, shows preflight/credit cost, and produces an auditable result. |
| PRD-008 | Provide task-state history | observed; partial | Must | To Do, Recurring, In Progress, Completed, Rejected, and Failed are filterable; failure includes actionable detail. |
| PRD-009 | Support approvals for consequential actions | documented; partial | Must | Actions such as irreversible changes, legal commitments, phone calls, and high-risk external communications require approval and record who/when/what. |
| PRD-010 | Connect external platforms through OAuth or equivalent | observed in roadmap; partial | Must | Account connection state, scopes, health, reauth, disconnect, and last sync are visible; secrets are never exposed. |
| PRD-011 | Detect events and produce narrative summaries | observed in site/roadmap; partial | Should | Event rules cover mentions, follower changes, performance drops, renewal dates, sentiment shifts; each narrative cites source events. |
| PRD-012 | Deliver reports through email and Slack | observed in roadmap/site; partial | Should | User can configure schedule, recipients, channel, retry, and delivery status. |
| PRD-013 | Provide social publishing controls | observed | Should | Twitter link, Auto-tweet, and Tweet actions exist with draft/approval/audit semantics. |
| PRD-014 | Support email operations | observed; partial | Should | Company mailbox has sent/received counts; outbound messages have recipient, consent/policy check, approval, and delivery status. |
| PRD-015 | Provide generated public website | observed | Must | Site is reachable at platform URLs, includes navigation/theme toggle/CTA, and has version/deploy status. |
| PRD-016 | Manage domains and deployments | observed; partial | Must | User can view platform URL, manage custom domain intent, inspect versions, redeploy, and see deployment health. |
| PRD-017 | Manage application secrets safely | observed | Must | User secrets can be created/changed/removed; values are masked; changes require next deploy; provided secrets are read-only. |
| PRD-018 | Provide code export and change-through-chat workflow | documented; partial | Should | Download Code exports a reproducible project; chat can propose and deploy changes with diff, tests, approval, and rollback. |
| PRD-019 | Track business metrics | observed | Must | Visitors, revenue, and payment setup status are visible with source, timestamp, and unknown/zero distinction. |
| PRD-020 | Support payments and platform fees | documented; partial | Must | Customer payments route to a balance, platform fee is explained, and Stripe portal/billing status is visible without exposing payment data. |
| PRD-021 | Support ads with budget limits and approval | documented; partial | Should | Campaign objective, budget cap, target, creative, fee, approval, delivery, and stop controls are auditable. |
| PRD-022 | Support teams with company-scoped access | observed; partial | Should | Invite grants access only to selected company; role, invite state, revoke, and audit are available. |
| PRD-023 | Provide documents and company memory | observed | Must | Mission, roadmap, research, and generated documents are versioned, searchable, and linked to decisions/tasks. |
| PRD-024 | Provide chat/planning interface | observed; partial | Must | User can ask for planning or a task; system previews intent, affected resources, cost, and approval needs. |
| PRD-025 | Provide billing/credits ledger | observed; documented | Must | Balance, expirable/permanent credits, reset date, spend/refund ledger, plan, and Stripe portal link are visible. |
| PRD-026 | Support pause, cancel, and account deactivation | observed; documented | Must | Pause stops daily work without deleting data; deactivation takes sites offline; cancellation preserves data. |
| PRD-027 | Enforce tenant isolation and secure data handling | documented; inferred design | Must | Company-scoped authorization, encryption, secret redaction, consent, retention, and export/delete controls are tested. |
| PRD-028 | Explain claims and uncertainty | inferred | Must | UI labels observed facts, generated recommendations, pending verification, and unknowns; no fabricated execution success. |

## Non-functional requirements

- **Safety:** default-deny for irreversible, legally binding, paid, or externally visible actions; approval tokens are single-use and expire.
- **Auditability:** every state transition, tool invocation, approval, external side effect, retry, and rollback has an immutable event record.
- **Reliability:** idempotent jobs, retry with backoff, dead-letter handling, and resumable onboarding/cycles.
- **Tenant isolation:** every query and event carries `tenant_id` and `company_id`; cross-company access tests must fail closed.
- **Privacy:** encrypt data in transit/at rest; mask secrets and personal identifiers in logs; configurable retention and export.
- **Explainability:** show source, timestamp, confidence, and evidence links for metrics, narratives, and agent decisions.
- **Performance:** dashboard first meaningful content under 2 seconds on a warm session; long work is asynchronous with progress.
- **Accessibility:** keyboard navigation, semantic labels, color-independent states, readable focus and error messaging.
- **Portability:** export code, documents, events, and configuration in documented formats; self-hosting remains a roadmap item.

## Out of scope for MVP

Phone calls, bank-account access, hiring, autonomous legal commitments, self-hosting, predictive insights, mobile push, public API, collaboration-grade natural-language querying, and broad platform coverage beyond the first validated connectors.

## Success metrics

Activation (brief-to-live-site completion), time to first useful task, weekly autonomous-cycle completion, approval turnaround, successful integration sync rate, deployment success rate, report delivery success, customer-visible incident rate, credit utilization, and retention/cancellation reasons.

## Open implementation decisions

See `20-open-questions.md`. Any implementation choice not supported by evidence must be recorded as a recommendation and validated through product, security, and legal review before launch.
