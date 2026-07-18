# Technical observations

## Deployment and product surface

- Onboarding activity visibly listed codebase setup, database setup, hosting warm-up, sandbox, seed repo, cloning, file reads/edits, npm, commit, and publishing.
- Dashboard exposed two public URL variants; the `.app` deployment rendered successfully in a separate tab with title `Vigilix`.
- The rendered site included a React-like navigation surface, Features/How It Works/Get Started anchors, theme toggle, narrative-monitoring copy, and mailto CTAs. The UI proves rendered behavior, not implementation details.

## First-party stack statement

The current FAQ states: React + Vite frontend, Node.js/Express backend, PostgreSQL database, and Render hosting. This is current product documentation, confidence 85%; it was not independently verified through source or network inspection.

## Secrets

App Secrets says user secrets are injected on every deploy, values are hidden, and changes take effect only after a subsequent Redeploy. A separate “Provided by Polsia” table showed many masked read-only values. No values were revealed, copied, or changed.

## Versions, rollback, and domains

Versions says rollback redeploys the live site, but “No versions yet” was shown. Manage Domains exposed the Polsia URL, Edit URL, and an empty custom-domain list. Redeploy and Edit URL were not activated.

## Network observation boundary

No developer-tools/network capture was performed. This was deliberate: normal UI evidence was sufficient for the report, and the safety rules prohibit extracting tokens, headers, private endpoints, or unrelated records. See `evidence/network-observations.csv`.

## Unknown implementation

Prompts, schemas, model routing, job queues, tenancy rules, memory algorithms, retry policy, token handling, authorization enforcement, and infrastructure topology cannot be established from this audit.
