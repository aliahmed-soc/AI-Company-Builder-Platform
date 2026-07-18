# Continuous Integration

Scope: ACBP-P0-020. Governing: ADR-006; NFR-010, NFR-013; ENGINEERING-STANDARDS.md. This document
describes the CI **checks** workflow. **CI runs checks only — it never deploys, publishes, or changes
any environment, and requires no paid service or provider account.**

## Workflow file and triggers

- File: `.github/workflows/ci.yml`
- Triggers: `pull_request` (any branch) and `push` to `main`. No `pull_request_target`, no scheduled,
  release, or deployment triggers.
- Concurrency: superseded runs for the same ref are cancelled (`cancel-in-progress: true`).
- Job/required-check name: **`verify`** — recommend configuring this as the required status check in
  branch protection after the first green hosted run (owner action; this ticket does not modify
  branch protection).
- Runner: `ubuntu-latest`. Job timeout: 20 minutes.

## Permissions (least privilege)

`permissions: contents: read` only. No write, packages, deployments, PR/issue mutation, or
id-token scopes. No repository secrets are referenced (`${{ secrets.* }}` is not used).

## Toolchain

- Node `22` (repository `engines` require `>=22`).
- pnpm is activated by **Corepack** from `package.json` → `packageManager` (`pnpm@11.5.2`) — the
  version is not duplicated in the workflow.
- Dependencies install with **`pnpm install --frozen-lockfile`** — a lockfile mismatch fails CI.
  `--no-frozen-lockfile` is never used.
- Package-manager caching via `actions/setup-node` (`cache: pnpm`).

## PostgreSQL service

- An **isolated `postgres:16` service container** (GitHub-hosted Linux runners; no Docker Desktop
  required, no Render resources).
- Run-scoped, **obviously non-production** credentials derived from non-secret run metadata
  (`ci-${{ github.run_id }}-${{ github.run_attempt }}`) — not a repository secret. User `acbp_ci`,
  database `acbp_ci_test`.
- Health-gated (`pg_isready`, bounded retries) before tests run; torn down with the runner.
- `ACBP_TEST_DATABASE_URL` is set to the service on `127.0.0.1` for the job only and is never printed.

## Commands executed (in order)

1. `pnpm install --frozen-lockfile`
2. `pnpm run ci:preflight` — CI database preflight guard (below).
3. `pnpm run check` — the aggregate gate: typecheck, lint, secret scan, dependency-boundary check +
   regression, provider-contract tests, unit tests, and **real-PostgreSQL integration + migration
   tests** (which run — not skip — because the DB URL is set).
4. `pnpm audit --audit-level high` — dependency advisories: **High and above block** the run.

`pnpm run check` is the single canonical aggregate; CI adds only the narrow preflight guard and the
advisory gate around it (no expensive work is duplicated).

## Why integration tests cannot silently skip in CI

Locally the persistence integration suite skips when `ACBP_TEST_DATABASE_URL` is unset (documented in
`docs/LOCAL-DEVELOPMENT.md`). In CI that would hide failures, so **`tools/ci/preflight.mjs`** runs
first: when `CI=true`, it exits non-zero if `ACBP_TEST_DATABASE_URL` is absent or malformed (value
never printed). The workflow sets that URL from the Postgres service, so the integration tests always
execute; if the DB config were missing/broken, CI fails at preflight rather than skipping. This is a
deterministic guard — it does not parse test output. Locally (`CI` unset) the guard is a no-op.

## Failure interpretation

The steps run in order and fail fast on the first meaningful failure:
- preflight fail → the CI DB config is missing/malformed (fix the service/env, not the tests).
- typecheck/lint/secret/boundary/contract/unit failures → fix the code.
- integration/migration failures → real database behavior regressed.
- `pnpm audit` fail → a High+ dependency advisory must be resolved (upgrade/patch the dependency).

## Local reproduction

```powershell
pnpm local:db:setup          # WSL PostgreSQL (see docs/LOCAL-DEVELOPMENT.md)
# load .env.local into the process, then:
$env:CI='true'
pnpm run ci:preflight
pnpm run check
pnpm audit --audit-level high
```

This runs the identical gate sequence locally against a real PostgreSQL. The core `pnpm run check`
(without a DB) reproduces everything except the integration suite, which skips locally by design.

## Fork pull-request behavior

Fork PRs run with `contents: read` only, use **no repository secrets**, and use the ephemeral,
run-scoped Postgres credentials — so they are safe. Because `pull_request_target` is not used, forked
code never runs with elevated permissions or write-capable tokens. Limitation: features that would
require secrets (none today) will not be available to fork PRs.

## Third-party actions (pinned to immutable commit SHAs)

Both official actions are pinned to a **full 40-character commit SHA**, with the release tag retained
in an inline comment for auditability (enforced by `tools/ci/ci-workflow.test.mjs`):

- `actions/checkout` → SHA of **v4.3.1**
- `actions/setup-node` → SHA of **v4.4.0**

Each SHA was resolved from the action's official repository via the GitHub API
(`GET /repos/<owner>/<repo>/commits/<tag>`); none were guessed. **To update:** re-resolve the desired
release tag to its commit SHA from the official repo, then replace both the SHA and the `# vX.Y.Z`
comment. Never use a mutable ref (`@v4`, `@latest`, `@main`, a branch, or a short SHA) — the CI test
rejects them.

## PostgreSQL image-tag policy

The service uses `postgres:16` — pinned to the **major** version (PostgreSQL 16), deliberately
allowing any 16.x minor/patch. Rationale:

- The container is an **ephemeral CI test database**, created and destroyed within each run — not a
  deployed or persisted artifact, so patch drift carries little risk.
- Our code targets **standard PostgreSQL** (no proprietary features; ADR-020), so any 16.x is
  compatible; floating within 16.x means the runner automatically picks up 16.x security patches.
- Trade-off accepted: full byte-for-byte reproducibility would require pinning an exact patch
  (`postgres:16.x`) or a digest (`postgres:16@sha256:…`) and manually bumping it. For a throwaway
  test service the major pin is the maintainable choice; a digest pin can be adopted later if
  exact reproducibility of the DB engine becomes a requirement.

The image is **not** `latest` and is never a mutable rolling tag outside the 16 line.

## Branch protection (owner action, after first green run)

After the first successful hosted run, configure the **`verify`** check as a required status check on
`main` (and require PRs). This ticket does not modify branch protection or repository settings.

## What remains outside CI

- Deployment, releases, publishing, preview environments (never in this workflow).
- Hosted execution proof: no hosted run has occurred yet (commit/push not authorized in this ticket).
- Object-storage provider selection (**ACBP-P0-005 remains Blocked** and is unrelated to CI).
- Windows/macOS runner matrices (one Node + one Postgres major suffice for Phase 0).
