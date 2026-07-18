# Staging verification sprint

Prepared: 2026-07-18 (Africa/Cairo)

## Objective

Close the highest-risk unknowns before extending the generated app: pricing truth, legal disclosures, backend contract/security, and task reliability. This is a verification plan; it does not claim private backend access or production changes.

## Priority gates

### P0 — resolve before billing or launch

- Choose one authoritative extra-company price. The audit found `$25/month` in the FAQ and `+$20/month each` in the Upgrade sheet.
- Make the same price appear in the plan UI, FAQ, checkout/Stripe portal, invoices, and cancellation flow.
- Confirm the public Terms of Service (`https://polsia.com/terms`, updated June 19, 2026), Privacy Notice (`https://polsia.com/privacy`, updated June 24, 2026), and Subprocessors page are linked and current. The Terms incorporate Acceptable Use by reference, but a standalone `/acceptable-use` URL returned 404; decide whether that is intentional and expose the policy if required.

### P0 — verify in a private staging environment

- Capture read-only responses for auth/session, company membership, task creation/run, task status, documents, billing status, and webhook reconciliation.
- Prove tenant isolation with two test users and two test companies; a user must never read or mutate another tenant's records.
- Verify authorization on every mutating route, CSRF/origin protections where cookie auth is used, rate limits, idempotency keys, audit logging, and secret redaction.
- Exercise queued, running, completed, failed, cancelled, and retried task states. Capture a user-visible failure reason and correlation ID for each failure.
- Verify Stripe webhook signature checks, replay protection, plan/credit reconciliation, cancellation timing, and proration.

## Evidence to collect

For each route, retain method, redacted request shape, status code, response schema, authorization result, idempotency behavior, and a timestamp. Do not retain tokens, cookies, payment data, or unredacted personal content.

## MVP implementation order after gates pass

1. Account-connection hub with encrypted credentials and explicit disconnect/revoke states.
2. Follower-change and performance-drop event detection with deduplication and replayable event records.
3. Narrative report generation with source evidence, confidence, and a human-readable activity trail.
4. Scheduled delivery to inbox/Slack with retry, pause, and notification preferences.
5. Acceptance tests for tenant isolation, billing reconciliation, task retries, and irreversible-action approvals.

## Current status

- UI task execution: verified end-to-end for a low-risk research task.
- Generated export quality: verified clean in a separate copy.
- Billing surface: observed; no payment action taken.
- Private backend/security evidence: blocked until read-only staging access or a test API environment is provided.
- Legal pages: public Terms, Privacy, and Subprocessors pages located; standalone Acceptable Use URL remains unresolved.

## Stop conditions

Pause implementation if pricing remains inconsistent, legal disclosures are missing, a cross-tenant read/write is possible, webhook reconciliation is non-idempotent, or an irreversible action lacks an approval gate.
