# MVP and roadmap

## MVP promise

“Give us a company brief; get a live, editable workspace that plans useful work, asks before consequential actions, and explains what happened.” The MVP should prove activation and safe autonomy without requiring a large integration catalog.

## MVP scope (build first)

1. Auth, tenant/company model, company brief, and three onboarding entry modes.
2. Resumable provisioning pipeline for email identity, code repository, database, hosted preview, documents, and initial tasks.
3. Dashboard with activity stream, task board, documents, metrics placeholders, public-site link, and chat/planning surface.
4. Task engine with To Do/Recurring/In Progress/Completed/Rejected/Failed, idempotency, retries, cancellation, and visible failure reasons.
5. One validated social connector and one validated email connector; read-only monitoring first, publishing behind approval.
6. Agent runtime with planner, researcher, builder, communicator, and reviewer roles; tool allowlists and budgets.
7. Approval center for posts, outbound email, spend, destructive changes, domain/deploy rollback, and legal/high-impact actions.
8. Deployment/versioning, secret masking, code export, and rollback checkpoint.
9. Credits/usage ledger and a Stripe-backed subscription shell; no customer-payment flow until legal/compliance review.
10. Audit log, tenant-isolation tests, consent/retention controls, and redacted observability.

## Release gates

- **Gate A — trustworthy onboarding:** 95% of test companies reach a live preview or receive a recoverable error; no orphaned tenant resources.
- **Gate B — trustworthy task loop:** every task has an owner, budget, trace, result, and retry/failed state; no duplicate external side effect in replay tests.
- **Gate C — trustworthy approvals:** prohibited actions cannot execute without a valid approval token; expired/revoked tokens fail closed.
- **Gate D — trustworthy operations:** deploy rollback, secret rotation, tenant isolation, export, and deletion retention tests pass.

## Roadmap

### R1: foundation (MVP)

Company/workspace, provisioning, dashboard, task state machine, basic agents, activity feed, one social/email connector, approvals, deployment and export.

### R2: operating loop

Recurring cycles, richer event rules, narrative reports, Slack delivery, recipient-specific formatting, recurring tasks, and human review queues.

### R3: growth surface

Ads with budget caps, payments and fee ledger, custom domains, team roles, 10+ connectors, multi-account dashboards, and campaign attribution.

### R4: intelligence and portability

Predictive insights, mobile push, public API, collaboration, natural-language data query, self-hosting, model choice, and customer-managed keys.

## Deliberately deferred

Phone calls, autonomous legal commitments, bank accounts, hiring, irreversible actions without approval, and any feature whose consent/fee/retention model is not explicit.
