# Dependency Boundaries (ACBP-P0-012)

Automated, build-failing enforcement of the workspace dependency rules from
`REPOSITORY-SCAFFOLD-SPEC.md §"Required dependency rules"`. Governed by NFR-013 and ADR-006.

## How to run

```bash
pnpm run check:boundaries      # exits non-zero on any violation (local + CI)
```

Enforced by `tools/check-boundaries.mjs` — a small custom static checker (Node built-ins only,
no runtime dependencies). It scans every `.ts/.tsx` under `apps/` and `packages/`, resolves each
import (relative paths and `@acbp/*` aliases) deterministically, classifies the target layer, and
applies the matrix below plus package-level cycle detection.

### Why a custom checker (not dependency-cruiser / eslint-plugin-boundaries)

dependency-cruiser was evaluated and installed first, but its bundled resolver could not resolve
workspace modules in this environment (it reported `couldNotResolve` for even same-directory
relative imports), so it could not enforce anything. Per the ticket's guidance ("a small custom
validation script is acceptable where existing tools cannot enforce a required workspace rule
clearly"), it was removed and replaced with `tools/check-boundaries.mjs`, which does its own
resolution and is fully deterministic. ESLint-based boundary rules were not used because ESLint
configuration is the next ticket's scope (ACBP-P0-013) and would overlap.

## Enforced dependency matrix (structural, now)

| Source layer | Allowed workspace destinations | Forbidden (examples) |
|---|---|---|
| `contracts` | (leaf — none) | every other package, apps |
| `domain` | `contracts` | any other package, apps, **any npm/SDK** (pure) |
| `core` | `domain, contracts, database, gateway, adapters, observability, config` | apps, `test-support`, **provider SDKs directly** |
| `database` | `contracts, config, observability` | `domain, core, gateway, adapters`, apps |
| `gateway` | `contracts, config, observability, adapters` | `domain, core, database`, apps |
| `adapters` | `contracts, config, observability` | `domain, core, database, gateway`, apps |
| `observability` | `contracts, config` | everything else |
| `config` | `contracts` | everything else |
| `test-support` | all (dev-only) | — (but no production file may import it) |
| `apps/web` | `core, contracts, config, observability` | `database, adapters, gateway, domain, test-support`, `apps/worker` |
| `apps/worker` | `core, contracts, config, observability` | `database, adapters, gateway, domain, test-support`, `apps/web` |

Global rules also enforced: **no circular** package dependencies; **no package may import an app**
entry point; **no production file may import `test-support`** (test files `*.test.ts` / `*.spec.ts`
/ `__tests__/` may); **no cross-package deep import** — packages must be imported via their public
index (`@acbp/x`, resolving to `packages/x/src/index.ts`), never a deep subpath or relative
traversal into another package's internals.

Bypass vectors are all covered (verified): relative-path traversal, `@acbp/*` path aliases, and
deep subpath imports all resolve to the same real `packages/*` targets and are subject to the same
rules. `tsconfig.base.json` defines `@acbp/*` aliases; no other path aliases exist, so there is no
un-checked alias surface. Each package also declares `exports: { ".": "./src/index.ts" }` as a
build-time runtime guard against deep subpath imports.

## Interpreting a failure

```
✖ dependency-boundary check FAILED — 1 violation(s):
  [domain-no-outward] packages/domain/src/foo.ts:3  import "@acbp/adapters"
      domain may not import adapters (allowed: contracts)
```

Each line gives the rule, the offending `file:line`, the import specifier, and why. Fix by removing
the forbidden import or routing through an allowed layer (e.g., product logic goes in `core`, which
may use `adapters`; `domain` stays pure).

## Adding a new package without bypassing the rules

1. Create it under `packages/<name>/` with `src/index.ts`, a `package.json` (`@acbp/<name>`,
   `exports: {".": "./src/index.ts"}`), and a `tsconfig.json` extending `../../tsconfig.base.json`.
2. Add its allowed destinations to the `ALLOWED` map in `tools/check-boundaries.mjs` (default: no
   outward edges — deny by default).
3. Add its `@acbp/<name>` alias to `tsconfig.base.json` `paths`.
4. Run `pnpm run check:boundaries` and `pnpm run typecheck`.

## Proposing an exception

Exceptions are code review + planning changes, not silent edits: state the rule, the specific
edge, and the justification in the PR; if accepted, amend the `ALLOWED` map (or add a narrowly
scoped rule) in `tools/check-boundaries.mjs` with a comment referencing the decision. Do not weaken
a rule to make a single import pass — reconsider the layering first.

## Deferred to later tickets (runtime invariants — NOT enforced here)

These rules from the spec are behavioural and have no code to enforce at the scaffold stage; they
are structural placeholders now and become enforceable with their owning tickets:

- **Rule 3 (tool execution only via the dispatcher):** structural part enforced (worker/core cannot
  import `adapters` directly); the runtime dispatch-routing invariant lands with the tools/dispatcher
  ticket (ACBP-P5-003).
- **Rule 4 (authorization not from browser state):** runtime invariant — Phase 1 auth (ACBP-P1-007).
- **Rule 5 (tenant context before repository access, compile-level):** the `database` repository
  constructor guard lands with ACBP-P0-018.
- **Rule 6 (audit + usage bundled transactionally with mutations):** runtime — ACBP-P1-008 / P6.
- **Module-index discipline *within* `core`** (cross-core-module imports via each module's public
  index) is currently a convention (intra-package imports are allowed by the package-level checker);
  finer per-module enforcement can be added when core modules gain real cross-references.
