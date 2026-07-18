# AI Company Builder Platform

**Temporary product name** — used until an official name is selected.

## Status

- **Current phase:** engineering foundation (Phase 0). The **repository scaffold only**
  exists (ticket ACBP-P0-011) — an empty modular-monorepo skeleton with no product
  functionality: no frontend behavior, backend logic, database schema, provider integration,
  infrastructure, or deployment code.
- Product implementation proceeds ticket-by-ticket per
  `docs/implementation/IMPLEMENTATION-ROADMAP-v1.md` and the Phase 0 execution order.

## Repository structure (developer)

TypeScript monorepo (pnpm workspaces), per `docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md`:

```text
apps/       web (api host), worker (background process)          # ADR-006 two processes
packages/   contracts, domain, core (module folders),           # domain/application layers
            database, gateway, adapters (clerk/infisical/storage),
            observability, config, test-support
```

- **Install:** `pnpm install` (Node ≥ 22, pnpm ≥ 11; pinned via `packageManager`).
- **Type-check the workspace:** `pnpm run typecheck`.
- **Run the (empty) test runner:** `pnpm test` — the real test harness arrives in **ACBP-P0-014**.
- **Dependency-boundary enforcement** (import-lint) is added next by **ACBP-P0-012**; each
  package README states its allowed/forbidden dependencies in the meantime.
- **No product functionality exists yet** — every `src/index.ts` is an empty stub.

## Independence

This repository is **independent from Halo Suite and Systevo**. Nothing from those projects
(names, requirements, architecture, data models, branding, or assumptions) may be reused here
unless the owner explicitly imports it. See `.cursor/rules/model-routing.mdc` §0.

## Source material

- `docs/research/polsia/` — the Polsia audit package and its corrected review.
  **The Polsia audit is research, not the authoritative specification.** See
  `docs/research/polsia/SOURCE-NOTES.md` for evidentiary caveats.
- `product-specification/SOURCE-CLASSIFICATION.md` — classification of all inspected source
  material and the approved/rejected import list.

## Next authoritative artifact

`product-specification/MASTER-PRD-v1.md` — to be created from the verified Polsia research
and the corrected audit review, then approved by the owner. After approval it becomes the
authoritative product source (below only the owner's latest explicit instruction).

## Operating protocol

`.cursor/rules/model-routing.mdc` (authoritative) governs model routing, scope control,
verification, and task handoffs. `tooling/cursor-rules/model-routing.mdc` is its synchronized
portability copy.
