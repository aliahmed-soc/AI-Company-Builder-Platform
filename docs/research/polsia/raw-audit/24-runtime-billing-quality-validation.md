# Runtime, billing, and final quality validation

Audit date: 2026-07-18 (Africa/Cairo). Evidence is limited to the authenticated dashboard UI, first-party FAQ/payment surfaces, and a separate copy of the downloaded generated-code archive.

## 1. Runtime validation

| Check | Result | Evidence | Classification |
|---|---|---|---|
| Run a low-risk research task | Completed | `Audit 5 social listening rivals` showed start, two search phases, report writing, and `Task completed` | observed |
| Result artifact | Created | Dashboard document `Social Listening Competitive Audit: Brandwatch, Brand24, Notified, Mentionlytics, Monday.com Agent Factory` appeared with a report preview | observed |
| Credit behavior | One remaining credit visible after the run | Menu showed `Credits 1` after completion; no purchase was made | observed |
| External side effects | None intentionally exercised | Research-only task; no subscribe, publish, ads, invite, redeploy, or delete action | observed |

This validates the visible task-run path and result persistence, but not private API response bodies, auth/CSRF enforcement, rate limits, queue durability, or backend internals. Direct API navigation was blocked by the browser client and page evaluation had no usable `fetch` context.

## 2. Billing and legal validation

The authenticated FAQ contained 40 questions across 9 categories. It documents:

- `$25/month` for one company, 30 night shifts (1/day), and 5 task credits; extra task-credit tiers range from 15 for `$19/month` through 1000 for `$999/month`.
- A 20% platform fee for Polsia-run business operations and ads; the user sets an ad budget.
- Stripe as the billing portal; upgrade changes are immediate/prorated, and cancellation pauses the company without deleting data.
- Company deletion is permanent and irreversible.
- Data is described as encrypted at rest/in transit, tokens protected with AES-256, and not shared with third parties.
- Polsia cannot make legal commitments or take irreversible actions without approval.

The visible Upgrade sheet independently showed `$25/month`, `+$20/month each` for extra companies, and the same task-credit tiers. This conflicts with the FAQ's statement that extra companies cost `$25/month each`; pricing should be reconciled before implementation or purchase flows are treated as authoritative.

The Payments dialog showed `Your payments to Polsia`, a `Manage in Stripe` button, and `No payments yet.` No billing portal was opened and no payment action was initiated. A public-site follow-up located the Terms of Service (`https://polsia.com/terms`, last updated June 19, 2026), Privacy Notice (`https://polsia.com/privacy`, last updated June 24, 2026), and Subprocessors page (`https://polsia.com/subprocessors`). The Terms incorporate the Acceptable Use Policy by reference; a separate `/acceptable-use` page returned 404, so the standalone policy URL remains unverified.

## 3. Exported-code quality remediation

Work was performed in a separate temporary copy of `vigilix-0y9hgo.zip`; the original archive was not overwritten. The generated setup page was corrected for import order/formatting, added titles to two decorative SVGs, and replaced the array-index React key with a coordinate-derived stable key. The lockfile was updated with `npm audit fix --package-lock-only --ignore-scripts`.

Final checks in the clean copy:

- `npm run lint` — passed (79 files).
- `npm run typecheck` — passed.
- `npm test -- --run` — passed (57 tests across 5 files).
- `npm audit --omit=dev` — 0 vulnerabilities.
- `npm run build` — passed with a local dummy `DATABASE_URL`; generated routes include `/`, `/api/example`, and `/health`.

The checked copy is packaged as `polsia-export-checked.zip` in Downloads. The original downloaded archive remains available for comparison.

## Remaining audit boundaries

- Private backend source, database schema, response payloads, authorization, CSRF, rate limiting, and production observability remain unknown.
- The generated export is a starter app, not evidence of Polsia's private control plane.
- Pricing contradiction and the missing standalone Acceptable Use URL require product-owner resolution.
