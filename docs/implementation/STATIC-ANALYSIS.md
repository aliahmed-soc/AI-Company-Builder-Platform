# Static Analysis (ACBP-P0-013)

The repository's static-analysis foundation. All gates are deterministic, exit non-zero on
violations, and are CI-ready (the CI workflow that runs them is wired later by ACBP-P0-020).
Governed by NFR-010, NFR-013, NFR-018; ADR-006, ADR-017.

## Commands

| Command | Purpose | Scans | Non-zero when |
|---|---|---|---|
| `pnpm run typecheck` | Strict TypeScript across all workspace members | each package's `src` via its `tsconfig` (`pnpm -r exec tsc --noEmit`) | any type error |
| `pnpm run lint` | Correctness-focused ESLint (type-aware for workspace TS; plain Node rules for `tools/*.mjs`) | `apps/**`, `packages/**` TS + `**/*.mjs`/`.cjs` (excludes `docs/`, `evidence/`, `tooling/`, `**/*.json`) | any lint error |
| `pnpm run check:secrets` | Committed-credential scan + `.env` prohibition | content: `apps/`, `packages/`, `tools/`, root config files; `.env` filename check: repo-wide | any finding |
| `pnpm run check:boundaries` | Dependency-direction / cycle enforcement (ACBP-P0-012) | `apps/`, `packages/` | any boundary violation |
| `pnpm run test:boundaries` | Regression suite for the boundary checker (26 cases, isolated temp workspaces) | `tools/tests/check-boundaries.test.mjs` | any case regresses |
| `pnpm run check:static` | **Aggregate gate** — runs all of the above in order | all of the above | any gate fails |

`check:static` is the single command CI (ACBP-P0-020) will invoke; it returns non-zero if any gate fails.

## TypeScript (strict settings)

Enabled in `tsconfig.base.json` (all workspace tsconfigs extend it): `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noImplicitReturns`, `useUnknownInCatchVariables`,
`noPropertyAccessFromIndexSignature`, `isolatedModules`, `verbatimModuleSyntax`,
`forceConsistentCasingInFileNames`, `skipLibCheck`, `noEmit`.

**Deliberately omitted:** none from the evaluated list — every one is enabled (all are compatible
with the current empty ESM modules; verified by a green `pnpm run typecheck`). `skipLibCheck` is on
to avoid type-checking third-party `.d.ts` (standard, keeps CI fast); `noEmit` because compilation
output is a build concern for later tickets.

## Linting

ESLint 10 flat config (`eslint.config.mjs`) with `typescript-eslint` type-aware rules for workspace
TS and plain `@eslint/js` recommended for Node tooling scripts. Focus: correctness and unsafe
TypeScript — `no-explicit-any`, `no-floating-promises`, `no-misused-promises`, `await-thenable`,
`no-unused-vars`, `consistent-type-imports`, plus `no-var`/`prefer-const`/`eqeqeq`. **No
framework-specific (React/web) plugins** — those wait until a web framework is scaffolded. Import
*direction* is owned by `check:boundaries`, not ESLint (no overlap).

## Secret scanning

`tools/check-secrets.mjs` (Node built-ins, no dependency). Detects PEM private keys, OpenAI/Clerk/
GitHub/AWS/Google/Slack key formats, bearer tokens, and generic quoted credential assignments
(≥16-char values); and forbids committed `.env` / `.env.*` files (`.env.example` allowed).
Findings are **redacted** (e.g., `sk-a…[REDACTED 35 chars]`) — full values are never printed.
**Not a replacement for a full production secret scanner.**

- **Scanned for content:** `apps/`, `packages/`, `tools/`, root config files.
- **Excluded from content scan:** `docs/`, `product-specification/`, `evidence/`, `tooling/`
  (architectural prose and redacted research use the words "secret"/"token" and example patterns;
  the precise regexes would not match them, but these paths are excluded to keep the gate noise-free).
- **Allowlist:** `tools/secret-allowlist.txt` — one reviewed exception per line as `<path>|<rule-id>`.
  Adding an entry is a reviewed decision; never silence a real credential.

## Boundary regression tests

`tools/tests/check-boundaries.test.mjs` (built-in `node:test`) proves the checker permanently:
9 forbidden cases, 5 allowed cases, 6 import-syntax forms (static / `import type` / `export … from`
/ `export * from` / dynamic `import()` / `require()`), comment-handling (commented-out imports are
ignored), and 5 bypass vectors (relative path, `@acbp/*` alias, deep subpath, filesystem traversal,
deep relative-into-another-package). Each case builds an **isolated temporary workspace** under the
OS temp dir, runs the checker against it via its scan-root argument, asserts the exit code and rule
id, and always cleans up — **no invalid fixture is ever written into the real source tree**.
(Add future test files to the `test:boundaries` script or adopt a glob.)

## How to fix failures

- **typecheck:** read the `TSxxxx` error; fix the type. **lint:** the rule id is printed; fix or,
  if genuinely wrong, discuss a narrowly scoped rule change. **check:secrets:** remove the credential
  and move it to the secret manager (ADR-021); commit only `.env.example`; add a reviewed allowlist
  entry only for a true false positive. **check:boundaries:** see `DEPENDENCY-BOUNDARIES.md`.

## Local now / CI later

All gates run locally today. ACBP-P0-020 will add the CI workflow that runs `pnpm run check:static`
on every push/PR ("red = merge blocked"). No CI workflow file is created by this ticket.

## Known limitations

- The secret scanner is pattern-based (fast pre-commit/CI gate), not a full entropy/history scanner.
- The boundary checker uses regex import extraction with comment stripping (sufficient and tested);
  if exotic import forms appear later, upgrade to a TS-AST extractor (authorized only on a
  demonstrated failing case).
- Type-aware lint rules will surface more (correctly) once real code replaces the empty stubs.
