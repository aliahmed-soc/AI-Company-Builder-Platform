# ChatGPT handoff: Polsia reconstruction package

## What is verified

The authenticated product exposes a company dashboard with tasks, social, metrics, documents, email, teams, website/deploy controls, ads, chat/activity, settings, credits, billing, and a public generated site. Onboarding visibly provisions company email, codebase, database, hosting, sandbox, site, documents, and initial tasks. Task tabs include To Do, Recurring, In Progress, Completed, Rejected, and Failed. A credit ledger and `$25/month` starter plan are visible. FAQ documents daily autonomous cycles, manual task credits, React/Vite + Node/Express + PostgreSQL + Render, Stripe-based billing, platform ads, approval limits, and non-abilities. A public site describes monitoring, narrative summaries, inbox/Slack delivery, schedules, and account connections.

## What is only documented or partial

OAuth connectors, event detection, narrative generation, Slack delivery, ads, customer payments, code download, deployment rollback, team invites, and run-now execution were exposed as UI/FAQ/roadmap concepts but not fully exercised. The audit deliberately avoided subscribe, spend, publish, invite, pause, delete, deactivate, secret reveal, domain edit, redeploy, and task execution.

## Important contradictions and unknowns

- New Company showed extra companies at `+$20/mo each`; FAQ says `$25/mo each`.
- A low-risk research task was run end-to-end and created a persisted competitive-audit document; the menu showed one remaining task credit afterward.
- The Payments dialog showed no payments yet and a Stripe portal handoff; no billing action was taken.
- Failed task had no visible error detail.
- Versions modal had no versions, so rollback behavior is unknown.
- Public Terms, Privacy, and Subprocessors pages were located; Acceptable Use is incorporated into Terms, but a standalone `/acceptable-use` URL returned 404.
- Private APIs, database schema, agent implementation, hosting topology, and security controls are unknown.
- The generated export now has a clean-copy verification package (`polsia-export-checked.zip`); the original archive was preserved.

## Recommended build direction

Use a tenant-isolated React/Vite-style web app, Node/TypeScript API, PostgreSQL, durable workflow engine, queue-backed connectors, isolated build/deploy workers, KMS-backed secrets, append-only audit log, and policy/approval gateway. Implement the MVP in `13-mvp-and-roadmap.md`, with trust and evidence labels as core product features rather than afterthoughts.

## Files and reading order

1. `01-executive-summary.md` — audit result and limits.
2. `02-application-map.md` through `10-product-requirements.md` — observed product map.
3. `11-product-requirements-document.md` — normalized requirements.
4. `12-requirements-traceability.csv` — source-to-requirement matrix.
5. `13-mvp-and-roadmap.md` — build sequencing.
6. `14-technical-architecture.md`, `15-conceptual-data-model.md`, `16-api-and-events.md` — implementation blueprint.
7. `17-acceptance-tests.md`, `18-risk-register.md` — quality and safety gates.
8. `19-competitive-gaps.md`, `20-open-questions.md` — differentiation and validation plan.
9. `evidence/*.csv` — structured evidence; `evidence/screenshots/` contains redacted screenshots only.
10. `diagrams/*.mmd` — system/workflow diagrams; solid edges are observed/documented and dashed edges are inferred/recommended.
11. `21-frontend-backend-requirements.md` — loaded frontend assets, runtime warnings, normalized backend route inventory, and implementation requirements.
12. `22-exported-code-verification.md` — verified generated app source, deployment/security configuration, and local quality results.
13. `23-quality-findings.md` — exact lint and dependency-advisory assessment.
14. `24-runtime-billing-quality-validation.md` — runtime task, billing/legal, private-backend boundary, and final code-quality validation.
15. `25-staging-verification-plan.md` — launch gates, evidence requirements, blockers, and recommended MVP build order.

## Evidence vocabulary

Use `observed`, `documented`, `partial`, `inferred`, and `unknown` exactly. Never upgrade a generated document or marketing copy into an implementation fact. Never report a paid or irreversible action as completed unless a provider receipt or UI confirmation exists.
