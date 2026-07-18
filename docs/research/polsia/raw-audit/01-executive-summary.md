# Executive summary

## Outcome

Polsia presents a dashboard for a company that can be created, researched, given a mission and roadmap, provisioned with a public site and infrastructure, and operated through scheduled or manually run tasks. The visible product is already useful as a company operating console, but several high-impact claims remain untested because they require payment, external accounts, task execution, publishing, or irreversible actions.

## Directly observed

- Authenticated company dashboard at `https://polsia.com/dashboard/<company-slug>`; company mood was `Shipped` and the UI said changes were live. (UI, 99%)
- Portfolio showed one company, two views, two users, and $0 revenue at audit time. (UI, 95%)
- Dashboard exposed Tasks, Twitter, Business, Documents, Email, Teams, Website, and Ads sections. (UI, 99%)
- The task manager exposed `To Do`, `↻ Recurring`, `In Progress`, `Completed`, `Rejected`, and `Failed` tabs. One failed task had `Failed`, `Created`, description, `Delete`, `Repeat`, and no visible error detail. (UI, 99%)
- A safe click on `+ New tasks` triggered autonomous planning and added three tasks to chat activity without a per-task approval prompt; no task was run. (UI, 95%)
- Company settings exposed `Pause`; Advanced exposed a Danger Zone with irreversible `Delete Company`. (UI, 99%)
- The public deployment rendered at `https://<company-slug>.polsia.app/` with a marketing landing page and theme toggle. (PUBLIC-SITE, 99%)

## Current commercial model observed

- Subscription sheet and FAQ show $25/month for one company, 30 night shifts, five task credits, unlimited Strategy & Planning Chat, server/database/email/browser, and $5/month AI credits. (UI + FAQ, 99%)
- Extra task-credit tiers are 15/$19, 25/$29, 50/$49, 100/$99, 200/$199, 500/$499, and 1000/$999 per month. (UI + FAQ, 99%)
- Credits screen showed balance 2: one expirable and one permanent; history showed bonus +2, spend −1, and refund +1. (UI, 99%)
- FAQ states Polsia takes 20% of generated revenue and uses its own ad account; ads have user-set budget limits and a 20% platform fee. (FAQ, 85%)
- The dashboard's add-company sheet showed `+$20/mo each`, while the FAQ says `$25/mo each`; this is a direct inconsistency requiring confirmation. (UI + FAQ, 95%)

## Coverage estimate

- 19 distinct user-visible screens/components were inspected, including dashboard, portfolio, billing, settings, task manager, documents, deployment controls, FAQ, public site, and safe onboarding entry points. This is an estimated 70% of the reachable dashboard surface, not a platform-wide denominator.
- 18 of 32 requested claims are directly supported by UI or current first-party FAQ; 7 are partially supported; 7 were not found or remain untestable without side effects. Exact classifications are in `09-claim-verification.md`.
- Network inspection was deliberately not performed; `evidence/network-observations.csv` records the limitation.

## Highest-value requirements for a comparable product

1. Company creation with idea, surprise-me, and existing-business paths.
2. Observable autonomous planning that creates prioritized tasks.
3. A task state machine with manual run, recurring, pause, failure, repeat, and credit accounting.
4. Company-scoped permissions, pause/emergency-stop, irreversible-action warnings, and strong audit logs.
5. Generated documents, public deployment, secrets UI with hidden values, versions/rollback, custom domains, and code export.
6. Transparent pricing, credits, fee rules, usage ledger, and subscription gates.
