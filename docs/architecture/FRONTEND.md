# FRONTEND — architecture and delivery constraints

Companion to `docs/implementation/FRONTEND-BACKLOG.csv`. The frontend is tracked **separately** from
the 104-ticket backend backlog so that backlog's denominator keeps meaning what it has always meant.

## The finding that shapes this entire plan

**Most of the domain has core use cases but no HTTP surface.** An inventory of `apps/web/src/app`
on `af364ff` finds these routes and no others:

| Area | Routes present |
|---|---|
| Companies | `GET/POST /api/companies`, `/api/companies/[companyId]`, `pause`, `resume`, `provisioning`, `provisioning/resume` |
| Discovery | `interview`, `interview/qa`, `interview/resume`, `interview/suspend`, `interview/questions/[questionId]/answer` |
| Memory | `memory`, `memory/[memoryItemId]` |
| Decision Room | `decision-room`, `decision-room/stream` |
| Activity | `activity` |
| Account | `account/profile`, `account/members`, `account/members/[membershipId]`, `account/members/accept` |
| Admin | `admin/accounts/[accountId]/companies/[companyId]/read` |
| Auth / system | `sign-in`, `sign-up`, `auth-check`, `webhooks/clerk` |

**There is no HTTP route for strategy, roadmap, goals, milestones, tasks, task runs, approvals,
policies, artifacts, revisions, usage, credit, export, or emergency stop.** Those capabilities are
implemented and tested in `@acbp/core` — `generateStrategyOptions`, `recordStrategyDecision`,
`generateRoadmap`, `generateTasks`, `getTaskBoard`, `dispatchToolCall`, `activateStop`,
`rebuildAccountUsageRollup` and the rest — but nothing exposes them to a browser.

**The consequence is a hard sequencing constraint, not an opinion.** Screens F3–F5 cannot be built
honestly until the routes they need exist, because the alternative is a screen that fabricates data
or calls nothing. Each such frontend ticket therefore declares an **API PREREQUISITE**, and that
prerequisite is *backend* work that is **not** in the 104-ticket backlog and must not be smuggled
into a frontend ticket.

## What is buildable today, and what is not

- **F0 (shell + design system)** — buildable now. Depends on no domain route.
- **F1 (auth, portfolio, companies)** — buildable now. Every route it needs exists.
- **F2 (interview, understanding, memory)** — buildable now. Every route it needs exists.
- **F3 (strategy and decisions)** — **BLOCKED on API routes.** Core use cases exist; HTTP does not.
- **F4 (planning and execution)** — **BLOCKED on API routes.**
- **F5 (approvals, policy, emergency control)** — **BLOCKED on API routes.**

## Direction (owner-authorized, reversible)

Calm, professional, trustworthy, operational rather than playful. Clean modern B2B SaaS,
light-first; dark theme only after core flows work. Neutral slate surfaces, restrained
blue/indigo accent, semantic success/warning/error. No gradients-as-decoration, no glassmorphism,
no mascot, **no fabricated dashboards or decorative metrics**. Persistent desktop sidebar with a
company switcher and a top-level company/system status; responsive mobile drawer. This is an
implementation default, not a final brand commitment — branding decision D-09 stays open and the
frontend must keep branding replaceable.

## Engineering rules

1. **Use existing backend routes and contracts.** Never weaken backend authorization to simplify a
   screen, and never re-implement a domain rule in a component — the server is authoritative.
2. **Every protected screen handles eight states:** unauthenticated, forbidden, not found, stale
   membership, loading, empty, validation error, internal failure. A screen missing one is not done.
3. **No raw internal identifiers in the UI**, and no fabricated data anywhere. An unavailable
   capability is labelled honestly rather than mocked.
4. **Accessibility is a gate, not a polish pass:** keyboard reachable, visible focus, WCAG 2.1 AA
   target, destructive actions confirmed, permission refusals explained in plain language.
5. **Tokens and components, not one-off styles.** Introduce a token or a component rather than a
   bespoke class, so the brand stays swappable.
6. **Tests per ticket:** component/unit, route/page, request mocking, plus real-backend E2E for the
   core journeys and an accessibility check. A production `next build` is part of finalization.

## Cross-company isolation is a UI concern too

The backend proves tenant isolation at the database and HTTP layers. The frontend adds its own
failure mode: cached data from company A rendering after a switch to company B. Every list and
detail view must key its cache by company id, and the F1 portfolio ticket carries an explicit
A → B → A switch test asserting no bleed.
