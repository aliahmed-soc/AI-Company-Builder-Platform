# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-002** — Internal user mapping with replay-safe webhooks (status: **Planned**; owner-gated to move to Done).
- Branch: `p1-002-user-mapping-webhooks`
- PR: **#3** (draft, open, unmerged, base `main`) — https://github.com/aliahmed-soc/AI-Company-Builder-Platform/pull/3
- Base main: `a2603b62e60996a3f920154a13807f834552d77b`

## Slices
- Slice 1 (schema/migration/neutral contracts/config) — committed, hosted-green.
- Slice 2 (verifier + processor + repos, replay-safe) — committed, hosted-green (`5fe3c00`), fixture fix `8c8dd76`.
- Slice 3 (webhook route + read-through) — committed `7a2e9ac` + fix `eb6be76`, hosted-green (409/0/0).
- Nightly drift reconciliation (worker command) — committed `b8dff96`, **hosted-green** (run 29692293699; 423 passed / 0 skipped / 0 failed).
- **ALL CODE-ONLY P1-002 WORK COMPLETE + HOSTED-GREEN.**
- Owner-gated tail (BLOCKING, not started): live Clerk dev acceptance (needs credentials/dashboard/tunnel), final owner-authorized backlog→Done, PR ready-for-review, merge.

## Test baselines
- Hosted baseline before Slice 3: 336 passed / 0 skipped / 0 failed. PG integration: database 10, user-mapping 15, webhook-processing 20.
- Local after Slice 3 (PG suites skip without `ACBP_TEST_DATABASE_URL`): 351 passed / 56 skipped / 0 failed; +60 new unit/route tests; new PG suite `read-through.integration.test.ts` = 11 (skipped locally).

## Guards
- Secret scan: 0 findings. Boundaries: 0 violations. Audit high: 0 (1 pre-existing moderate, below gate).
- Local Docker/PG not available → PG integration verified only on hosted CI.

## Blockers / owner decisions
- None outstanding. Live-Clerk acceptance + backlog/ready/merge are future owner gates.

## Current HEAD
`b8dff96` (+ pending docs commit). PR #3 body updated. Hosted baseline 423/0/0.

## Next executable action
STOPPED AT OWNER GATE. All code-only P1-002 work is hosted-green. The remaining steps are all owner-gated: (1) live Clerk development acceptance — requires the owner to provide a Clerk **development** instance's config (webhook signing secret + instance id + secret key) via the runtime secret mechanism, create the webhook endpoint subscription in the Clerk dashboard, and authorize a temporary public tunnel for local delivery; (2) owner-authorized backlog ACBP-P1-002 → Done; (3) owner-authorized PR #3 ready-for-review; (4) owner-authorized merge to main. Do NOT proceed on these without explicit owner authorization (secrets/dashboard/tunnel/merge/backlog are all gates).
