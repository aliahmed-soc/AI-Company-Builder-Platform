# Frontend and backend inspection

Inspection date: 2026-07-18 (Africa/Cairo). Scope: authenticated dashboard DOM, loaded asset inventory, console warnings, and same-page backend request route names observed by the browser. Identifiers are normalized as `<companyId>` and `<company-slug>`. This is route-level evidence, not private source-code or database access.

## Executive result

The product is a client-rendered dashboard backed by a route-oriented HTTP API. The frontend loads a hashed module bundle (`/assets/index-*.js`), a hashed stylesheet, custom fonts, and a large image/illustration set. The dashboard is not a static marketing page: it requests session, company, task, analytics, payments, inbox, outreach, team, hosting, secrets, and ads data independently. A comparable implementation therefore needs a typed API boundary, company-scoped authorization, loading/error states per module, and an audit-safe job/side-effect model.

## Frontend observations

### Application shell

- `https://polsia.com/dashboard/<company-slug>` renders a single dashboard shell with navigation, main content, chat/activity panel, modal dialogs, and module cards.
- The DOM exposes semantic headings, buttons, links, a navigation region, a notifications region, task controls, and a chat textbox.
- The page loads a hashed JavaScript module and hashed CSS bundle, consistent with a compiled SPA (inference; first-party FAQ documents React + Vite).
- No HTML forms were present in the initial dashboard DOM; most actions are button-driven dialogs or API-backed controls.
- Frontend modules include onboarding activity, tasks, Twitter, business metrics, documents, email, teams, website/deploy, ads, menu, billing, and chat.

### Asset and telemetry surface

Observed loaded assets/services include custom font files, image/illustration assets, TikTok Pixel, Meta/Facebook Pixel, Google Ads/gtag, PostHog surveys/flags/recorder, Sentry envelopes, and OpenAI questionnaire SDK. This implies requirements for consent, vendor inventory, regional/privacy controls, event naming, and redaction of company/user identifiers.

### Runtime warnings found

1. Multiple dialogs warn that `Description`/`aria-describedby` is missing. **Requirement:** every dialog needs an accessible description or explicit `aria-describedby`, focus management, escape handling, and a visible error state.
2. Tracking attempted an unsupported `faq_clicked` event while logging the allowed event taxonomy. **Requirement:** analytics events must be schema-validated, versioned, and tested so unsupported names fail locally rather than at runtime.
3. TikTok Pixel warned that `content_id` was missing. **Requirement:** marketing events must include provider-required fields or be intentionally suppressed with a documented reason.

## Backend route inventory

The following route shapes were observed as same-page requests. They are normalized and do not assert that these are the complete API or its implementation.

### Identity, access, and company context

- `GET /api/auth/session`
- `GET /api/admin/check`
- `GET /api/team/check`
- `GET /api/companies/portfolio`
- `GET /api/dashboard`
- `GET /api/companies/<companyId>/members`
- `GET /api/companies/<companyId>/share-link`

**Requirements:** authenticated session, role checks, company-scoped membership, portfolio aggregation, share-link policy, and denial auditing. Every route must reject a foreign company ID even if the user is authenticated.

### Operating state and tasks

- `GET /api/v2/engineering-v2/live?companyId=<companyId>`
- `GET /api/v2/companies/<companyId>/terminal/logs?limit=50`
- `GET /api/v2/companies/<companyId>/mood`
- `GET /api/v2/faces`
- `GET /api/v2/companies/<companyId>/tasks?status=todo,in_progress,queued`
- `GET /api/v2/companies/<companyId>/tasks`
- `GET /api/v2/companies/<companyId>/tasks/recurring`

**Requirements:** cursor pagination, explicit status transitions, log redaction, bounded log windows, job correlation IDs, retry/failure detail, recurring schedules, and read/write separation. “Live” status must distinguish connected, running, stale, failed, and paused.

### Billing, credits, and payments

- `GET /api/subscription`
- `GET /api/subscription/quantities`
- `GET /api/v2/companies/<companyId>/payments/overview`
- `GET /api/analytics/latest`
- `GET /api/boost/active`

**Requirements:** separate subscription state, quantities, task/AI credits, customer-payment balance, ad spend, refunds, and platform fees; append-only ledger; idempotent reconciliation; no payment secrets in client responses; truthful zero-versus-unknown metrics.

### Communications and growth

- `GET /api/v2/companies/<companyId>/inbox`
- `GET /api/companies/<companyId>/outreach/status`
- `GET /api/companies/<companyId>/outreach/stats`
- `GET /api/companies/<companyId>/ads/status`

**Requirements:** consent and recipient policy, message redaction, delivery receipts, provider health, rate limits, opt-out handling, budget caps, approval gates, and audit trails for every external write.

### Hosted application and secrets

- `GET /api/v2/hosted-apps/versions?companyId=<companyId>`
- `GET /api/v2/hosted-app-secrets/<companyId>/keys`

### Additional routes observed in the loaded dashboard state

- `GET /api/v2/companies/<companyId>/ads`
- `GET /api/v2/companies/<companyId>/twitter/tweets`
- `GET /api/v2/company-documents`
- `GET /api/reports`
- `GET /api/v2/chat/companies/<companyId>/conversations?latest=true`
- `GET /api/v2/chat/companies/<companyId>/conversations`
- `GET /api/v2/chat/companies/<companyId>/proactive-greeting`
- `GET /api/v2/onboarding/live?companyId=<companyId>`
- `GET /api/v2/companies/<companyId>/integrations/twitter/status`
- `GET /api/v2/companies/<companyId>/twitter/status`
- `GET /api/stripe-connect/status`
- `GET /api/github-export`
- `GET /api/v2/chat/conversations/<conversationId>`
- `GET /api/v2/chat/conversations/<conversationId>/read`
- `GET /api/v2/companies/<companyId>/tasks/plan`
- `GET /api/track`, `/api/company/track-dashboard-visit`, and `/api/company/track-activity`

**Additional requirements:** document/version reads need provenance and company scope; chat needs conversation authorization, unread/read state, prompt-injection isolation, and retention controls; GitHub export needs secret exclusion and signed artifact handling; onboarding live state needs resumable checkpoints; tracking endpoints need consent, schema validation, and PII minimization.

**Requirements:** immutable versions, deployment health, rollback metadata, environment separation, masked secret names/values, secret revision tracking, and deploy-only activation of changes. A key-list endpoint must never return secret values.

## Backend architecture requirements inferred from the route shape

1. **API gateway:** one auth/policy layer before every company route; validate tenant, membership, role, and resource state.
2. **Read models:** dashboard aggregation should tolerate partial module failure and expose per-card freshness/error state.
3. **Durable jobs:** engineering live state, terminal logs, task runs, recurring tasks, outreach, ads, and deployments need resumable jobs with idempotency keys.
4. **Audit/event stream:** record request, policy decision, tool call, approval, provider receipt, task transition, billing entry, and failure cause.
5. **Privacy boundary:** redact message bodies, tokens, personal emails, and command output in logs; telemetry must use consent and stable pseudonyms.
6. **API contracts:** define typed schemas, pagination, error codes, correlation IDs, optimistic concurrency, and versioning (`/api/v2` already signals versioned evolution).
7. **Failure semantics:** every module needs loading, stale, unauthorized, rate-limited, provider-down, and retryable states; a failed task must expose actionable reason rather than only `Failed`.

## Frontend requirements derived from the inspection

- Preserve the dashboard’s modular card layout but make each module independently resilient.
- Use accessible dialog primitives with descriptions, focus restoration, keyboard navigation, and announcement of async state.
- Make task actions explicit: preview cost, side effects, approval requirement, and resulting receipt.
- Never render a secret, raw token, or unredacted personal identifier in DOM, error text, telemetry, or downloadable artifacts.
- Add a consistent evidence badge (`observed`, `documented`, `partial`, `inferred`, `unknown`) wherever the UI presents generated claims or operational status.
- Keep analytics event names in a shared typed registry; test every event against provider-specific required fields.
- Add module-level error boundaries so a failed inbox or ads request does not blank the entire dashboard.

## What remains unknown

- HTTP methods and request/response schemas for mutating operations.
- CSRF, CORS, cookie/session configuration, rate limits, and authorization implementation.
- Private service topology, database schema, queue/workflow engine, model providers, and deployment controls.
- Whether route names are stable public contracts or internal implementation details.
- Provider scopes, webhook verification, retention, backup/restore, and incident response.

## Verification boundary

The browser’s loaded-resource inventory confirms these route shapes were requested by the authenticated frontend. Direct navigation to an API URL was blocked by the in-app browser client, and the page evaluation sandbox does not expose network `fetch`; therefore response bodies, HTTP methods for mutations, status/error schemas, cookies, CSRF, and authorization behavior remain unverified. No bypass or credential extraction was attempted.

## Build priority

**P0:** auth/company isolation, task/deployment idempotency, secret redaction, approval gateway, audit events, typed error states.

**P1:** dashboard aggregation, recurring tasks, inbox/outreach, connector health, credits/billing reconciliation, accessible dialogs.

**P2:** ads, share links, advanced analytics, telemetry optimization, and broader integration catalog.
