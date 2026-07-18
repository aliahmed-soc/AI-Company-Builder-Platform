# Application map

Observation date: 2026-07-18 (Africa/Cairo). Confidence is 99% unless marked otherwise.

| Screen / component | Route or URL | Purpose and observed controls | Gate / status |
|---|---|---|---|
| Company dashboard | `/dashboard/<company-slug>` | Mood, God Mode, subscription CTA, tasks, Twitter, business metrics, documents, email, teams, website, ads, chat/activity | Company state `Shipped`; subscription CTA visible |
| Portfolio | `/dashboard` | Company table, views/users/revenue/day, company actions | One company visible |
| Menu | dashboard overlay | Portfolio, New Company, Credits, Payments, Upgrade, company/profile settings, About, Giftshop, Doctrine, FAQ, Download Code, Refer & Earn, Logout | Navigation overlay |
| Add another company | dashboard overlay | $25/mo sheet; one company, night shifts, credits, chat, infrastructure; extra-company and extra-credit selectors | Subscribe required; not submitted |
| Company settings | dashboard overlay | Rename company; Pause; Advanced/Danger Zone; Delete Company | Pause reversible; delete says cannot be undone |
| Profile settings | dashboard overlay | Full name, email, Twitter handle, content language, Save Changes, Deactivate Account | Deactivation warning; not submitted |
| Credits | dashboard overlay | Balance, expirable/permanent split, reset date, spend/refund/grant ledger | Read-only inspection |
| Payments | dashboard overlay | Stripe portal entry, “No payments yet” | Stripe button not opened |
| Upgrade / AI Employee | dashboard overlay | $25/month plan and extra credit tiers | Subscribe not clicked |
| Tasks manager | dashboard overlay | Tabs: To Do, Recurring, In Progress, Completed, Rejected, Failed; task cards | No task execution |
| Task detail | task overlay | Type, Created, description, Delete, Repeat, Run now | Run now is credit-spending; not clicked |
| Documents | dashboard overlay | Product Roadmap, Mission, Market Research | Read-only modals |
| Manage Domains | dashboard overlay | Polsia URL, Edit URL, custom domains | No custom domain connected |
| Versions | dashboard overlay | Rollback explanation; “No versions yet” | Redeploy/rollback not clicked |
| App Secrets | dashboard overlay | User secrets form; values hidden; provided secrets read-only; deploy required after changes | No values revealed or changed |
| Team invite | dashboard overlay | Company-scoped invite form; Send invite | Not submitted |
| FAQ | dashboard overlay | 40 questions across 9 categories | Current first-party product claims |
| About | `/about` | Founder/product narrative | Public content |
| Doctrine | public page reached from menu | Founders Doctrine and social links | Public content |
| Public deployment | `https://<company-slug>.polsia.app/` | Rendered landing page with Features, How It Works, Get Started, theme toggle, mailto CTAs | Rendered successfully |

## Deliberately untouched

`Start God Mode`, `Run task`, `Run now`, `Auto-tweet`, `Tweet`, `Run ads`, `Redeploy`, `Edit URL`, `Add`, `Send invite`, `Subscribe`, `Manage in Stripe`, `Pause`, `Delete`, `Deactivate`, and secret Reveal controls were not activated.
