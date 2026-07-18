# Polsia Audit Review and Corrected Build Direction

## Executive verdict

The audit package is valuable and materially improves confidence about Polsia's user-visible product. It is not yet safe to use unchanged as the project master specification.

The package mixes four different evidence classes:

1. Direct observations from the authenticated Polsia control panel.
2. Statements from Polsia's in-app FAQ and public legal/product pages.
3. Features generated for the disposable test company, Vigilix.
4. Recommended architecture and safety controls for our product.

The first two can establish Polsia parity. The third must not be mistaken for Polsia platform functionality. The fourth is our design, not evidence about Polsia.

## Overall confidence after review

| Area | Confidence | Assessment |
|---|---:|---|
| Main dashboard and navigation | 96% | Directly observed and supported by screenshots. |
| Company provisioning flow | 92% | Activity history strongly supports visible stages, but not private implementation. |
| Tasks, task states, planning, and credit use | 94% | One low-risk research task was eventually run successfully, although earlier documents were not updated. |
| Night shifts and manual task credits | 94% | Supported by UI and FAQ. |
| Generated website and code export | 96% | Live site and exported project were inspected. |
| Social, email, ads, and payments surfaces | 80% | Controls exist, but most external actions were not exercised. |
| Approval behavior | 55% | General FAQ claims exist; detailed approval enforcement was not demonstrated. |
| God Mode behavior | 60% | Button and product copy observed, but execution was not tested. |
| Exact onboarding interview | 45% | Paid creation flow prevented direct inspection. |
| Agent architecture | 35% | Capabilities and labels are visible; independent agents are not proven. |
| Private backend architecture and security | 25% | Route names and generated app templates do not reveal the control-plane implementation. |

## Critical corrections required

### 1. Task execution was verified later, but earlier files still say it was not run

The executive summary and claim-verification file say task execution was not completed. The later runtime-validation file records a successful low-risk research task, a persisted report document, and a reduced credit balance.

Correct conclusion:

- Planning and task creation: directly verified.
- One manual low-risk task run: directly verified.
- General reliability, retries, cancellation, recurring execution, and external side effects: still unverified.

The later runtime evidence should supersede the older claim wording.

### 2. Vigilix-specific functionality was incorrectly promoted into platform parity requirements

The generated test company was a social-listening product. Its roadmap and public website described:

- Follower-change detection
- Sentiment detection
- Narrative reports
- Slack report delivery
- Account monitoring

These prove that Polsia can generate a company plan and website containing those ideas. They do not prove that Polsia's own platform provides a reusable event-detection or Slack-delivery engine.

Therefore PRD-011 and PRD-012 must be removed from Polsia parity and treated as either:

- Test-company product requirements, or
- Optional future capabilities for our platform.

### 3. The exported Next.js project is not Polsia's platform source code

The exported project verifies the structure and quality of one generated customer application. It shows that Polsia can output a Next.js project with tests, security headers, Prisma setup, and deployment configuration.

It does not verify:

- Polsia's private dashboard frontend framework
- Polsia's task engine
- Polsia's database schema
- Agent orchestration
- Authorization enforcement
- Billing backend
- Queue system
- Model routing

Use the export as evidence for the generated-software product, not as the architecture blueprint for the Polsia control plane.

### 4. The approval system remains largely unknown

Observed onboarding performed code generation, deployment, and a welcome email without a visible per-action approval prompt. A safe research task also ran after the user initiated it.

The FAQ claims irreversible actions require approval, but no detailed approval center, approval token, expiration, payload binding, category authorization, or revocation behavior was demonstrated.

Correct conclusion:

- Some user initiation and warnings exist.
- General approval language exists.
- Fine-grained approval enforcement is not verified.
- Our proposed approval center is a competitive improvement, not parity.

### 5. Pricing has one unresolved contradiction

Strongly observed:

- Base plan: $25/month.
- One company.
- 30 night shifts.
- Five task credits.
- Extra credit tiers.

Unresolved:

- Upgrade UI showed extra companies at +$20/month each.
- FAQ said extra companies cost $25/month each.

Do not copy either extra-company price until the purchase or billing source of truth is confirmed.

### 6. The "70% of reachable surface" estimate is subjective

The audit inspected many important screens, but there is no complete denominator for all routes, states, feature flags, plans, or role-dependent screens. Treat 70% as an auditor estimate, not a measured coverage result.

### 7. Product claims and working quality must stay separate

The audit proves that many controls and capabilities are presented. It does not prove all of them work reliably at production scale. A feature must be tracked through separate dimensions:

- Visible in UI
- Documented
- Successfully executed
- Produced useful output
- Worked repeatedly
- Was controllable
- Was recoverable after failure

## Corrected Polsia parity baseline

These requirements are sufficiently supported to preserve in our product plan.

### Company and portfolio

- User account and company workspace.
- Multiple-company portfolio and company switching.
- Company creation from an idea, a surprise-me path, or an existing business path, although the exact form questions remain unknown.
- Company status or mood.
- Company-specific settings.
- Company pause and account deactivation controls.

### Automated provisioning

- Visible onboarding progress.
- Company brief and profile.
- Market research, mission, roadmap, and initial tasks.
- Company email identity.
- Codebase or seed repository setup.
- Database and hosting setup.
- Sandbox or build environment.
- Generated public website.
- Welcome or launch communication.

### Planning and tasks

- AI planning that reviews the company and generates tasks.
- To Do, Recurring, In Progress, Completed, Rejected, and Failed states.
- Task descriptions and types.
- Scheduled nightly work.
- Manual task execution using credits.
- Repeat and delete controls.
- Activity history and generated result documents.
- Continuous/God Mode entry point, with exact runtime behavior still partial.

### Dashboard and business operations

- Activity/chat area.
- Documents.
- Business metrics.
- Email surface.
- Social/Twitter surface.
- Ads surface.
- Teams surface.
- Website, domains, versions, secrets, and deployment controls.
- Payments and billing surfaces.

### Generated software

- Generated public application or website.
- Code download/export.
- Version/rollback entry point.
- Custom domain entry point.
- Masked application secrets.
- Hosted deployment.
- Generated project that can build and pass tests, based on one inspected sample.

### Commercial model

- Monthly company subscription.
- Included night shifts.
- Manual task credits.
- Credit ledger with grants, spending, and refunds.
- Extra credit packages.
- Stripe billing portal.
- Documented revenue and managed-advertising fees.

## Partially verified—preserve capability but design behavior ourselves

- God Mode / continuous execution.
- OAuth account connections.
- General outbound email automation and follow-ups.
- Auto-posting and social scheduling.
- Advertising campaign execution.
- Customer payment collection.
- Team roles and collaboration permissions.
- GitHub repository ownership and transfer.
- Rollback execution.
- Automatic task retry.
- Recurring-task schedule configuration.
- Approval enforcement.
- Budget controls outside advertising.
- Export portability across infrastructure providers.

## Do not treat as verified Polsia parity

- Adaptive founder interview.
- Multiple strategy options with tradeoffs.
- Detailed action previews.
- Five formal autonomy levels.
- Visible and editable company memory.
- Fixed number of agents.
- Independent microservice for each worker.
- Mobile app generation.
- Slack report delivery as a native platform capability.
- Generic event and sentiment monitoring as a native platform capability.
- Kubernetes, Kafka, Terraform, or any particular orchestration framework.
- Exact database schema.
- Exact prompt or memory design.
- Server-side approval implementation.

## Requirements to add because our goal is to be better

These should remain mandatory differentiators:

1. Adaptive discovery interview.
2. Explicit facts, assumptions, preferences, and unanswered questions.
3. Multiple strategy options with cost, time, risk, and expected benefit.
4. Client selection or editing before plan execution.
5. Detailed previews for external, paid, public, or destructive actions.
6. Configurable approval levels and category policies.
7. Payload-bound, expiring, revocable approval records.
8. Budget, volume, recipient, and scheduling limits.
9. Transparent memory and decision history.
10. Emergency stop.
11. Visible error reasons, retries, and recovery.
12. Portable code, data, documents, and infrastructure ownership.

## Correct build sequence

### Phase 0 — Freeze the specification

Produce one source-of-truth PRD containing only:

- Verified parity requirements
- Partial requirements with explicit assumptions
- Better-than-Polsia requirements
- Non-goals
- Acceptance criteria

Remove test-company-specific product features from platform parity.

### Phase 1 — Trust and tenancy foundation

- Authentication
- Accounts, companies, and membership
- Tenant isolation
- Audit event model
- Credential vault
- Billing and usage ledger
- Policy and approval engine
- Emergency stop

### Phase 2 — Company creation and provisioning

- Discovery interview
- Business-understanding confirmation
- Strategy options
- Selected plan
- Resumable provisioning workflow
- Initial documents, tasks, preview site, and activity stream

### Phase 3 — Task and agent loop

- Planner
- Narrow specialist workers
- Task state machine
- Scheduled cycles
- Manual runs and credits
- Retry, cancellation, and failure details
- Result artifacts

### Phase 4 — Generated software

- Code generation in a sandbox
- Source repository
- Preview deployment
- Secret management
- Versioning
- Diff, test, approval, and production deployment
- Export

### Phase 5 — External operations

Start with one email integration and one social integration. Add ads, payments, support, and broader integrations only after the approval, audit, and reliability systems are proven.

## Immediate decision

The audit is strong enough to begin writing the final source-of-truth PRD. It is not strong enough to begin implementing the entire platform directly from the existing 25 documents.

The next artifact should be a corrected Master PRD that supersedes the inconsistent documents and preserves traceability back to them.
