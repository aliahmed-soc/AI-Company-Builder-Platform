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
- **Slice 3** (webhook route + read-through) — implemented locally; being committed/verified now.
- Remaining code-only: nightly drift reconciliation (worker command) — not started.
- Owner-gated tail: live Clerk dev acceptance, final audit, backlog→Done, PR ready, merge.

## Test baselines
- Hosted baseline before Slice 3: 336 passed / 0 skipped / 0 failed. PG integration: database 10, user-mapping 15, webhook-processing 20.
- Local after Slice 3 (PG suites skip without `ACBP_TEST_DATABASE_URL`): 351 passed / 56 skipped / 0 failed; +60 new unit/route tests; new PG suite `read-through.integration.test.ts` = 11 (skipped locally).

## Guards
- Secret scan: 0 findings. Boundaries: 0 violations. Audit high: 0 (1 pre-existing moderate, below gate).
- Local Docker/PG not available → PG integration verified only on hosted CI.

## Blockers / owner decisions
- None outstanding. Live-Clerk acceptance + backlog/ready/merge are future owner gates.

## Next executable action
Commit Slice 3 (`feat(auth): add Clerk webhook route and identity read-through`), push to `p1-002-user-mapping-webhooks`, update PR #3 body, monitor hosted CI to green, then implement the nightly drift-reconciliation slice.
