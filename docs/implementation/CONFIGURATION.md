# Configuration (ACBP-P0-015)

Provider-neutral, validated configuration for the web and worker processes, in `@acbp/config`.
Governed by NFR-018 and ADR-021 (bootstrap-only env; secrets in Infisical, not in code).

## Environments

`APP_ENV` selects the environment and is validated as an enum: **development · test · staging ·
production**. Configuration is selected explicitly by `APP_ENV` (not implicitly by `NODE_ENV`).
No strict regional data-residency is claimed (ADR-005).

## Configuration categories & contracts

| Category | Loader / parser | Contents |
|---|---|---|
| **Public (client-safe)** | `loadPublicConfig()` / `parsePublicConfig(env)` | Explicit allowlist only: `appEnv`, `publicUrl`. Nothing is public unless listed here — never because a provider labels it "publishable". |
| **Web server (server-only)** | `loadWebServerConfig()` / `parseWebServerConfig(env)` | `appEnv`, `publicUrl`, `port`, `telemetryEnabled`, `requestTimeoutMs`, `bootstrap` |
| **Worker (server-only)** | `loadWorkerConfig()` / `parseWorkerConfig(env)` | `appEnv`, `concurrency`, `requestTimeoutMs`, `bootstrap` |
| **Test** | `loadTestConfig()` | Deterministic, credential-free config for tests |
| **Bootstrap** | `loadBootstrapConfig()` / `parseBootstrapConfig(env)` | `appEnv`, `infisicalSiteUrl`, `infisicalClientId`, `infisicalClientSecret` (Secret), `infisicalEnvironment` — the minimum to authenticate to Infisical and locate the environment (ADR-021 §8). **No Infisical client is implemented in this ticket.** |

`parse*(env)` are pure and take an explicit environment record (fully unit-testable).
`load*()` read `process.env` at the composition boundary and **fail fast** (throw
`ConfigValidationError`) so a process refuses to start on invalid required config. Unknown env
vars are stripped, never auto-exposed.

## Required vs optional / public vs server-only

- **Required:** `APP_ENV`; `APP_PUBLIC_URL` (web/public); bootstrap `INFISICAL_CLIENT_ID` and
  `INFISICAL_CLIENT_SECRET`. Empty and absent are both rejected for required values.
- **Optional with safe defaults:** `PORT` (3000), `APP_TELEMETRY_ENABLED` (false),
  `REQUEST_TIMEOUT` (30s), `WORKER_CONCURRENCY` (2), `INFISICAL_SITE_URL`
  (https://app.infisical.com), `INFISICAL_ENVIRONMENT` (defaults to `APP_ENV`).
- **Public** = `APP_ENV`, `APP_PUBLIC_URL` only. Everything else is **server-only**.
- **Validation types:** enum, URL, integer + range, boolean (`true|false|1|0`), duration
  (`500ms|30s|5m`), required-non-empty, and cross-field (e.g., production requires an https
  `APP_PUBLIC_URL`).
- **No provider credentials are required** to validate the current scaffold — OpenAI, Anthropic,
  Clerk, Render, billing, object storage, and database values are **not** required here (they are
  fetched from Infisical at runtime by later tickets). The one secret in env is the Infisical
  machine-identity client secret (bootstrap).

## Failure behavior & redaction

- Invalid required configuration throws `ConfigValidationError`; a process entry point catches it
  and exits non-zero (the entry point arrives with the app tickets — no server exists yet).
- Error messages list `field: message` and **never contain values**; secret fields are
  hard-redacted (`invalid (redacted)`).
- Server secrets are wrapped in `Secret`, which redacts on `String()`, `JSON.stringify`, and
  `util.inspect`; the raw value is available only via `.reveal()` at the point of use. Public
  config never contains a secret.

## How values are provided

- **Local dev:** copy `.env.example` → `.env` (gitignored) and fill placeholders. `.env.example`
  contains names + clearly fake placeholders only; it is the one committed env file.
- **Tests:** pass an explicit env object to `parse*`, or use `loadTestConfig()`. Tests must not
  read real credentials.
- **Staging/production:** the process receives only the bootstrap env vars; all other secrets are
  fetched from **Infisical** at runtime via the vault boundary (ADR-021) — wired by a later ticket.

## Adding a new variable safely

1. Add it to the appropriate schema in `packages/config/src/index.ts` (required vs optional; pick
   the right validator). 2. Classify it: if client-safe, add to the **public** allowlist; otherwise
   keep it server-only. 3. If it is a secret, wrap it in `Secret` and add its env name to
   `SECRET_FIELDS`. 4. Add positive + negative tests. 5. Document it in `.env.example` (placeholder,
   marked public/server-only). Never commit a real value.

## Commands

- `pnpm run test:config` — configuration tests only.
- Covered by `pnpm test` and `pnpm run check` (full gate).

## Boundaries

`@acbp/config` may import only `@acbp/contracts` (workspace) plus the external `zod`; it must not
import product-domain modules, database, provider SDKs, apps, or test-support from production code
(enforced by `check:boundaries`).
