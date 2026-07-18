# Product requirements for a comparable product

## A. Directly verified Polsia parity

- Authenticated company dashboard with mood/status, metrics, activity, documents, tasks, website, email, social, teams, ads, and chat.
- Company creation modes: build an idea, surprise me, or bring an existing business.
- Autonomous planning that reviews state and proposes tasks.
- Daily/night-shift scheduling plus manual task execution consuming credits.
- Task buckets for To Do, Recurring, In Progress, Completed, Rejected, and Failed.
- Task detail with type, creation time, structured description, repeat/delete, and run-now controls.
- Company-scoped team invitations.
- Company pause and account deactivation controls.
- Generated mission, market research, roadmap, public website, email mailbox, and activity feed.
- Public deployment URL, custom-domain entry point, versions/rollback entry point, secrets management with hidden values, and code download entry point.
- Subscription/credits ledger, plan tiers, Stripe portal, and revenue/ads fee copy.

## B. Partially verified requirements

- God Mode / continuous execution needs a safe sandbox test.
- OAuth integrations, Slack delivery, LinkedIn pages, analytics/CRM connectors, and account revocation need a disposable connected account.
- Ad campaigns, email outreach, support replies, social automation, and payments need explicit sandbox approval and budget controls.
- Approval scope, previews, cost estimates, recipient display, expiration, and revocation need dedicated evidence.
- Automatic retries, pause/resume semantics, cancellation, recurring tasks, and rollback need safe test records.
- Code ownership, export fidelity, deployment portability, and GitHub provisioning need artifact inspection under the user’s authorization.

## C. Unknown internal implementation

Prompt design, model selection/routing, worker boundaries, queues, schemas, tenancy isolation, authentication/token storage, memory algorithms, retry policy, observability backend, billing enforcement, and security controls cannot be inferred from normal product use.

## D. Recommended improvements

- Adaptive founder interview with visible required/optional fields and explicit assumptions.
- Multiple strategy options with cost, risk, timeline, and rationale comparison.
- Detailed action previews showing recipient, payload, estimated spend, data scope, and rollback path.
- Granular approvals: once, category, budget-capped, scheduled, and revocable.
- User-defined budgets and policies for ads, messages, credits, and deployments.
- Transparent company memory split into facts, assumptions, decisions, and sources, all editable/deletable.
- Strong audit log with actor, timestamp, status transitions, retries, costs, outputs, and errors.
- Emergency stop that pauses all autonomous work and external actions.
- Versioned deploys with diff, tests, rollback, and export verification.
- Portable code/data export with ownership and licensing terms.
- Clear integration permission scopes and one-click revoke.
- Resolve pricing inconsistency: extra company is shown as +$20/mo in UI but $25/mo in FAQ.
