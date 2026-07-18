# Testing Foundation (ACBP-P0-014)

Shared automated-testing foundation for the monorepo. **Single runner: Vitest** — one framework
for unit / contract / integration / security / workflow tests across every app and package.
Governed by NFR-013; ADR-006 (module seams), ADR-007 (multi-tenant test pattern).

## Commands

| Command | Purpose | Scope | Exit |
|---|---|---|---|
| `pnpm test` | Run the whole suite once (CI-safe) | all `*.test.{ts,mts,mjs}` in apps/, packages/, tools/ | non-zero on any failure |
| `pnpm test:watch` | Local watch mode | same | interactive |
| `pnpm test:boundaries` | Run only the dependency-boundary regression suite | `tools/tests/check-boundaries.test.mjs` | non-zero on regression |
| `pnpm run check` | **Full project gate**: static analysis + boundary check + tests | repo-wide | non-zero if any gate fails |
| `pnpm exec vitest run <path>` | Targeted run of one package/app/file | given path | non-zero on failure |
| `pnpm exec vitest list` | List discovered tests (config/discovery check) | all | 0 |

`check` composes `check:static` (typecheck → lint → secret scan → boundary check → boundary
regression) then `pnpm test`. The boundary regression runs in both `check:static` (as
`test:boundaries`) and `pnpm test`; this small, intentional overlap keeps each command usable on
its own.

## Test-file conventions

- **Naming:** `*.test.ts` (or `.mts`/`.mjs`). Vitest discovers them automatically.
- **Placement:** co-locate unit tests beside the code they test (`packages/<x>/src/**/*.test.ts`,
  `apps/<x>/src/**/*.test.ts`). Cross-cutting/tooling tests live in `tools/tests/`.
- **Imports:** explicit — `import { test, expect } from 'vitest'` (no globals). Workspace modules
  via `@acbp/*` aliases, resolved identically to `tsconfig.base.json` by `vitest.config.ts`.

## Unit vs integration boundaries

- **Unit:** pure logic, no I/O, no network, no database — the default; fast.
- **Integration:** exercises multiple modules or a real dependency (e.g., PostgreSQL). The
  database/integration layer (ephemeral Postgres + the multi-tenant fixture pattern named in this
  ticket) is **deferred to ACBP-P0-018**, which introduces the `database` package, schema, and
  RLS; the harness is DB-integration-ready (Vitest + Node) but no DB test container is installed
  now (no database code exists yet, and P0-014's non-scope forbids DB clients/schemas).
- **Contract / security / workflow** tests attach to their owning tickets and use this same runner.

## Mocking & real-provider policy

- Prefer real code + in-memory fakes over mocking frameworks. Provider SDK mocks, browser/E2E
  tooling, React testing utilities, and DB test containers are **not** installed until their owning
  tickets require them (per TEST-AND-VERIFICATION-STRATEGY.md).
- Real providers (models, Clerk, etc.) are never called from unit/CI tests; sandbox/test-mode
  provider use is a staging concern for later tickets.

## Determinism & cleanup

- Timezone is pinned to **UTC** (`test.env.TZ` in `vitest.config.ts`); assert on fixed values.
- `isolate: true` — each test file runs isolated; no shared mutable global state.
- `testTimeout`/`hookTimeout` = 10s.
- Tests that create temp files/dirs must create them under the OS temp dir and remove them in a
  `finally`/`afterEach` — never write fixtures into the real source tree (the boundary regression
  suite is the reference implementation of this rule).

## Shared test support (`packages/test-support`)

Home for shared test helpers/fixtures/fakes. **Dev/CI only** — it must never become a runtime
production dependency or be bundled into web/worker output (enforced by
`check:boundaries`' `no-prod-to-test-support` rule; production files importing it fail the build,
while `*.test.ts` files may import it). Kept minimal today (a single `TEST_MARKER` sentinel);
real fakes (gateway, clock, vault) are added by the tickets that need them. It must contain no
credentials and no production-copied tenant data.

## Running subsets

- One package: `pnpm exec vitest run packages/contracts`
- One app: `pnpm exec vitest run apps/web`
- One file: `pnpm exec vitest run tools/tests/testing-foundation.test.ts`

## CI

`pnpm run check` is the single command CI (ACBP-P0-020) will run on every push/PR. No CI workflow
file is created by this ticket.

## Coverage — deferred (documented decision)

Coverage reporting is intentionally **not** enabled yet: the source packages are empty stubs, so a
coverage number would be meaningless (and adding a coverage provider now is a pointless dependency).
When real product code lands, add `@vitest/coverage-v8` and a `test:coverage` script; enforce a
threshold at that point.

## Current limitations

- No database/integration sample runs yet (deferred to P0-018, above).
- No browser/E2E, React, or provider-mock tooling (their owning tickets).
- Type-aware assertions grow more valuable once empty stubs are replaced by real code.
