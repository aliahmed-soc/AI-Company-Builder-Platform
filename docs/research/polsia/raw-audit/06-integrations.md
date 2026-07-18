# Integration inventory

| Provider / channel | Purpose visible in app | Current state | Evidence / confidence |
|---|---|---|---|
| Twitter / X | Connected social account, public post display, Auto-tweet and Tweet controls | Active-looking; one public post visible | UI, 99% |
| Company email | Polsia-provided company mailbox, welcome email, sent/received counters | One sent, zero received at audit time | UI, 99% |
| Slack | Narrative report delivery; task to wire up Slack delivery | Planned/task-backed, not connected | UI task + roadmap, 95% |
| LinkedIn | OAuth connection UI task for Company Pages | Planned/task-backed, not connected | UI task, 95% |
| Social/analytics/CRM/enterprise tools | Public site and roadmap describe cross-platform monitoring | Marketing/product claim; no connection wizard inspected | PUBLIC-SITE + roadmap, 70% |
| Stripe | Subscription billing portal and business payments | Subscription/payment controls visible; no payments yet | UI + FAQ, 95% |
| Render | Hosting provider named by FAQ | First-party FAQ claim; not independently network-verified | FAQ, 85% |
| PostgreSQL | Database named by FAQ | First-party FAQ claim; secrets UI shows hidden provided database value | FAQ + UI, 85% |
| Gmail, Outlook, Meta Ads, Instagram, Facebook, TikTok, YouTube, CRM vendors, domains, analytics | Requested inventory items | Not found as active connectors in inspected surfaces | UI coverage, 70% |

## Ownership and revocation

The inspected UI did not expose a general connected-account manager. A future task explicitly proposes a reusable account connection hub. OAuth permission scopes, revoke behavior, data sent/received, and customer-versus-Polsia account ownership therefore remain unknown.
