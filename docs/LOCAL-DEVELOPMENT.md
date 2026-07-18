# Local Development

How to get a new engineer from clone to green tests, and (optionally) to a local PostgreSQL for
integration tests. Scope: ACBP-P0-021. Governing: ADR-006, NFR-013, DEPLOYMENT-ARCHITECTURE §2.

> **The repository is a Phase-0 scaffold.** There is no product UI, API, worker loop, auth, or
> provider integration yet. Local development here means: run the checks and tests, and stand up a
> local database for the persistence integration suite. Nothing below fakes product behavior.

## Supported paths (classification)

| Path | Status |
|---|---|
| Native Node + pnpm → `pnpm install` + `pnpm run check` (unit/contract/boundary; no DB) | **Verified** (Windows) |
| WSL-hosted PostgreSQL 16 for the integration suite (`tools/local/db.ps1`) | **Verified** (Windows + WSL) |
| Externally-supplied local PostgreSQL URL (skip `db.ps1`, set the env vars yourself) | Documented |
| Docker-based PostgreSQL | **Optional / unverified here** — Docker Desktop crashes on this machine; use the WSL path instead |
| macOS / Linux host | Documented but not executed here (the Node parts are cross-platform; `db.ps1` is Windows-only) |

## Prerequisites

- **Node ≥ 22** and **pnpm 11** (pinned via `packageManager`). Install pnpm with `corepack enable`.
- **Git**.
- **Windows:** PowerShell (5.1 or PowerShell 7).
- **For the local database (optional):** **WSL 2** with a working install (`wsl --version`).
  Docker Desktop is **not** required.

Run `pnpm local:doctor` at any time to check these (read-only; never prints secrets).

## First-time setup (the green path — no database needed)

```powershell
git clone <repo> ; cd AI-Company-Builder-Platform
corepack enable
pnpm install
pnpm run check
```

`pnpm run check` runs typecheck, lint, secret scan, dependency-boundary check + regression, and the
full test suite. The persistence **integration** tests **skip** when no database URL is set — that is
expected. A new engineer reaches green here without any database.

## Local PostgreSQL (Windows primary path, via WSL)

Proven on this machine in P0-018 (Docker Desktop is not involved). One command provisions a
**dedicated, isolated** WSL distro `acbp-local-dev` running PostgreSQL 16, creates the databases, and
writes a git-ignored `.env.local`:

```powershell
pnpm local:db:setup      # creates distro 'acbp-local-dev' + PG16 + roles/DBs + .env.local (idempotent)
pnpm local:db:status     # readiness + which DBs exist (no secrets printed)
pnpm local:db:stop       # stop PostgreSQL (distro preserved, NOT unregistered)
pnpm local:db:start      # start it again
```

- **Dedicated + isolated:** only the `acbp-local-dev` distro is touched. `docker-desktop`,
  `OpenClawGateway`, and any other distro are never modified.
- **Two separate databases:** `acbp_dev` (long-lived developer database) and `acbp_test`
  (**disposable** integration-test database). They are never the same database.
- **Local-only:** reachable at `127.0.0.1:5432` (WSL localhost forwarding); not publicly exposed.
- **Credentials:** generated in memory, written only to git-ignored `.env.local`, never printed.

### Bring-your-own PostgreSQL (any OS)

If you already run PostgreSQL 16 locally, skip `db.ps1`: create two databases (`acbp_dev`, `acbp_test`)
and set `DATABASE_URL` / `ACBP_TEST_DATABASE_URL` yourself (see below). Never point these at a shared,
staging, or production server.

## Environment configuration & secrets

- **`.env.example`** — committed; **names + obviously-fake placeholders only**.
- **`.env.local`** — git-ignored (`.env.*`); holds your **real local** `DATABASE_URL` and
  `ACBP_TEST_DATABASE_URL`. Written by `pnpm local:db:setup`. **Never commit it.**
- Configuration is validated by `@acbp/config` (`parseDatabaseConfig`), which reads `process.env`.
  There is no dotenv auto-loader; load `.env.local` into your shell when you want the DB:

  ```powershell
  # PowerShell: load .env.local into the current process, then run the integration suite
  (Get-Content .env.local) | ForEach-Object { if ($_ -match '^\s*([^#][^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process') } }
  pnpm test:database
  ```

- **Never** commit real secrets; **never** print database URLs, passwords, or tokens. Diagnostics
  show presence and validity, not values (`redactDbUrl` in `tools/local/lib.mjs`).
- Local model/identity/secret providers are the **deterministic fakes** from `@acbp/test-support`
  (DEPLOYMENT-ARCHITECTURE §2: "Mock gateway adapter", "Local dev secrets, never real"). No real
  Clerk/Infisical/OpenAI/Anthropic and no network calls in local development.

## Database workflow

With `.env.local` loaded (above):

```powershell
pnpm db:check            # health probe (SELECT 1)
pnpm db:migrate:status   # applied vs pending migrations
pnpm db:migrate          # apply pending migrations (dev)
pnpm db:migrate:down     # roll back the most recent migration
pnpm test:database       # unit + REAL-PostgreSQL integration suite (10 tests) — 0 skipped when the URL is set
```

Migration discipline (from P0-018) still applies locally: applied migrations are immutable (add new
ones; never edit applied files), local failures stop progression, database URLs are never logged, and
there is no uncontrolled migrate-on-start. Production migrations remain an explicit release step.

### Reset (destructive — test DB only)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/local/db.ps1 -Action reset -Force
```

`reset` refuses to run without `-Force`, and only drops+recreates the **test** database (`acbp_test`);
the long-lived `acbp_dev` is never dropped by reset. The safety guard also refuses any
production/staging-looking or Halo target and any non-local host.

## Running the apps (scaffold)

```powershell
pnpm dev:web       # prints an honest "no web server yet" notice and exits (Phase-0 scaffold)
pnpm dev:worker    # prints an honest "no worker loop yet" notice and exits (Phase-0 scaffold)
```

These do **not** fake a running server/worker. When `apps/web` / `apps/worker` gain real entry points
in later tickets, these commands will start them.

## Stopping & cleanup

- `pnpm local:db:stop` — stops PostgreSQL and terminates the distro (kept for next time; not removed).
- Integration tests clean up their own temporary tables; the disposable `acbp_test` DB can be
  recreated any time with `reset -Force`.
- To remove the local database entirely (rare): `wsl --unregister acbp-local-dev`. This is **manual
  and destructive** — never run automatically; it does not touch other distros.

## Troubleshooting

- **`pnpm run check` fails immediately** → run `pnpm local:doctor`; fix Node/pnpm versions or run
  `pnpm install`.
- **Docker Desktop won't start / crashes** → do **not** try to repair it for this project. Use the
  **WSL PostgreSQL path** above; Docker is not required for local development here.
- **Integration tests skip** → `ACBP_TEST_DATABASE_URL` is not loaded into the process; load
  `.env.local` (see above) or run `pnpm local:db:setup` first.
- **`db:check` fails to connect** → `pnpm local:db:status`; if the distro is stopped, `pnpm local:db:start`.
- **IPv6 refusal (`::1`)** → the generated URLs use `127.0.0.1` to avoid WSL's lack of IPv6 forwarding.

## Future: Infisical

Local development uses `.env.local` + fakes today. When Infisical (ADR-021) is integrated in a later
ticket, **staging/production** secrets move to Infisical (bootstrap identity only in env); local
development will continue to use `.env.local` for developer-owned values, with an option to pull from a
personal Infisical environment. This ticket does **not** implement the Infisical client.

## Known limitations & prohibitions

- Scaffold-only: no product features, routes, auth, workers, or provider integrations exist yet.
- Local setup does **not** provide complete tenant isolation (no tenant-owned schema/RLS yet — P0-018
  established the RLS-ready plumbing only).
- **Never** use a Halo database, or any staging/production database, for local development or
  destructive tests. The scripts reject non-local, prod/staging-looking, and Halo targets.
- The Docker path is unverified on this machine; object-storage provider selection (P0-005) remains
  Blocked and no storage emulator is configured.
