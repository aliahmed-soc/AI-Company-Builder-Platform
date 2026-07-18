# @acbp/database

PostgreSQL access + migration foundation (ACBP-P0-018; NFR-001, NFR-017; ADR-007, ADR-008, ADR-020).
This package establishes the **foundation only** — no product-domain tables, repositories, or RLS
policies. Those arrive with their owning tickets (see `docs/architecture/DATA-ARCHITECTURE.md`).

- **Allowed dependencies:** `@acbp/contracts`, `@acbp/config`, `@acbp/observability` (enforced by `pnpm run check:boundaries`)
- **Forbidden:** product-domain modules, provider SDKs (Clerk/Infisical/OpenAI/Anthropic/billing/Render), app entry points, test-support in prod
- **Runtime:** both (web + worker)

## Database access technology

**Kysely** (type-safe SQL query builder) over **node-postgres (`pg`)**. This is the "type-safe SQL
layer compatible with RLS session settings" the scaffold spec (`REPOSITORY-SCAFFOLD-SPEC.md`)
deferred to this ticket. Kysely was chosen over a full ORM because:

- It is a SQL layer, not a schema-DSL ORM — it composes cleanly with per-connection RLS session
  settings (`SET LOCAL`) and standard Postgres (ADR-020: no proprietary features, portable exit path).
- We keep full control of the connection/transaction, which the tenant-isolation model requires.
- Its file-based migrator gives up/down migrations with a lock table for safe concurrent runners.

No hosted/vendor database service is embedded; `pg` talks to any standard PostgreSQL (Render Postgres
in production, per ADR-020).

## Configuration

Validated by `@acbp/config` (`parseDatabaseConfig` / `loadDatabaseConfig`). The database package never
reads `process.env` directly. Fields (env var → config):

| Env var | Meaning | Default |
|---|---|---|
| `DATABASE_URL` | `postgresql://…` connection string (credentials) — **wrapped in `Secret`, always redacted** | required |
| `DATABASE_POOL_MIN` / `DATABASE_POOL_MAX` | pool sizing | `0` / `10` |
| `DATABASE_CONNECTION_TIMEOUT` | acquire timeout (duration) | `10s` |
| `DATABASE_IDLE_TIMEOUT` | idle client timeout | `30s` |
| `DATABASE_STATEMENT_TIMEOUT` | server-side statement timeout | `30s` |
| `DATABASE_APP_NAME` | `application_name` for server-side attribution | `acbp` |
| `DATABASE_SSL` | `disable` \| `require` \| `verify-full` | `require` in staging/production, `disable` in dev/test |
| `DATABASE_MIGRATE_ON_START` | allow auto-migrate at startup | `false` |

Safe-by-default: staging/production reject `DATABASE_SSL=disable`, and `migrateOnStart` defaults off.

**Where values come from.** Per ADR-021 the platform's runtime secrets (including `DATABASE_URL`)
are fetched from Infisical / injected by the managed platform at the composition root — they are
**not** committed to `.env.example`. For local development and tests, set `DATABASE_URL` /
`ACBP_TEST_DATABASE_URL` in your own gitignored `.env` or shell. No real credentials are ever committed.

## Connection lifecycle & pooling

```ts
const client = createDatabase(loadDatabaseConfig());   // validates; no I/O (pg connects lazily)
const health = await checkDatabaseHealth(client);      // SELECT 1; never throws → { ok, latencyMs, error? }
await closeDatabase(client);                            // ends the pool, releases all connections
```

`createDatabase` fails fast on invalid configuration **before** any connection attempt. The client is
not a global singleton — construct it at the composition root and inject it (tests may inject a fake
pool/kysely/logger via the `deps` argument).

## Transactions

```ts
await withTransaction(client, async (tx) => { /* tx.kysely */ });                 // commit/rollback/release
await withTenantTransaction(client, tenant, async (scope) => { /* scope.db */ }); // + RLS session settings
```

- **Commit** on resolve, **rollback** on throw, **connection released** on both paths (Kysely).
- Thrown values are normalized to a redacted `PlatformError` (see below).
- **Nested-transaction policy: explicitly unsupported.** Re-entering `withTransaction` with an
  executor already in a transaction throws `nestedTransactionError` rather than silently opening a
  savepoint — a transaction never silently remains open. Reuse the active `tx`/`scope` handle instead;
  savepoint support can be added later if a concrete need arises.

## Migrations

Committed under `packages/database/migrations/`. Commands (root scripts, run via `tsx`):

```
pnpm db:migrate          # apply all pending (forward)
pnpm db:migrate:status   # applied vs pending history
pnpm db:migrate:down     # roll back the most recent (reversible one release)
pnpm db:reset            # LOCAL ONLY: down-all then re-apply (refuses staging/production)
pnpm db:check            # health probe
```

Discipline:

- **Naming/ordering:** `NNNN_name.ts` (e.g. `0001_platform_init.ts`); lexicographic prefix = order.
- **Immutability:** once a migration is applied (recorded in `kysely_migration`), **never edit it** —
  add a new migration. Schema changes always mean new files (expand → migrate → contract across
  releases for backward-safe rollouts).
- **Locking:** the Kysely migrator serializes concurrent runners via `kysely_migration_lock`, so
  parallel deploys cannot double-apply.
- **Failure = no partial apply:** each migration runs in its own transaction; a failure rolls that
  migration back and **stops progression** — later migrations are not attempted, blocking the deploy.
- **Production:** migrations run as an explicit, separately-approved release step; startup does not
  apply them implicitly unless `DATABASE_MIGRATE_ON_START` is deliberately set.
- **History** is queryable via `pnpm db:migrate:status` / `migrationStatus()`.

`0001_platform_init.ts` is a minimal **technical** migration (a non-domain probe table) that proves
the up/down mechanism; it contains no product-domain table.

## Error normalization, logging & redaction

Driver failures never reach clients raw. `toDatabaseError` maps SQLSTATE / connection errors to a
`PlatformError` (P0-016) with a stable code + safe category, preserving the original as `cause`:

| Condition | Category | Code | Retryable |
|---|---|---|---|
| unique_violation (23505) | conflict | CONFLICT_DETECTED | no |
| serialization/deadlock (40001/40P01) | conflict | CONFLICT_DETECTED | yes |
| statement timeout (57014) | provider_unavailable | DEPENDENCY_TIMEOUT | yes |
| connection failure (08*, ECONNREFUSED…) | provider_unavailable | DEPENDENCY_UNAVAILABLE | yes |
| integrity (23502/23503/23514/22P02) | validation | VALIDATION_FAILED | no |
| insufficient_privilege / RLS (42501) | authz | AUTHORIZATION_DENIED | no |

Errors carry **no** SQL text, bound parameter values, or connection strings. Diagnostics are logged
through `@acbp/observability` (correlation-scoped; the redaction pipeline scrubs credentials and
connection strings). Logging failures never block cleanup, rollback, or user work. **Never** log raw
connection config, full query text with sensitive values, or parameter values.

## Tenant isolation (preparation — ADR-007)

Two independent layers are required. This ticket delivers the app-layer half and prepares the DB half:

- **Compile-level tenant context (invariant 2):** tenant-owned repositories extend `TenantRepository`,
  whose constructor requires a `TenantScope`. A `TenantScope` is branded and can only be produced by
  `withTenantTransaction` (which requires a `TenantContext`), so **a repository — or any query it runs
  — cannot be constructed without tenant context** (proven at compile time in `repository.type-test.ts`;
  acceptance: "repo without tenant context does not compile").
- **RLS-ready session settings (invariant 3):** `withTenantTransaction` applies transaction-local
  GUCs (`app.current_account`, `app.current_company`, `app.current_actor`) via `set_config(…, true)`.
  Future RLS policies key off these; `SET LOCAL` semantics mean a pooled connection never leaks scope.
- Tenant identifiers come from verified session membership at the composition root — **never** directly
  from client input. Background jobs must carry and set tenant context before any query (ADR-007 §2.6).

**Tenant isolation is NOT complete** until the first tenant-owned table exists with its RLS policies
and adversarial cross-tenant tests. This ticket introduces no tenant-owned table.

## Tests

- **Unit** (`*.test.ts`, no DB): config validation + redaction; error mapping; nested-transaction
  policy; tenant session plumbing; compile-level tenant enforcement (`repository.type-test.ts`, via
  `tsc`); and an "unavailable database" path (real ECONNREFUSED to a closed local port).
- **Integration** (`src/integration/*.integration.test.ts`, **real PostgreSQL, no mocks** per
  `TEST-AND-VERIFICATION-STRATEGY.md`): health, migrate apply/re-run/history/failure-stops/concurrency,
  transaction commit/rollback + release, RLS session settings, and the no-domain-tables guarantee.
  Gated on `ACBP_TEST_DATABASE_URL` (a CI ephemeral Postgres service, or a local disposable database);
  the suite **skips** when it is unset — it is never silently replaced by SQLite/in-memory/mocks.
  Run: `pnpm test:database` (unit always; integration when the URL is set).

## Known limitations

- Nested transactions are unsupported (no savepoints yet) — deliberate.
- RLS policies and tenant-owned schema are out of scope here (added with the first tenant table).
- Integration tests require a real PostgreSQL reachable via `ACBP_TEST_DATABASE_URL`; without it they
  skip (they do not pass vacuously).
