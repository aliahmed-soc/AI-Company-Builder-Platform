# @acbp/web

**Scaffold stub (ACBP-P0-011) — no product functionality yet.**

- **Responsibility:** HTTP host, routing, SSE, UI; composes core modules
- **Allowed dependencies:** core, contracts, config, observability
- **Forbidden dependencies:** database directly (must go through core), adapters directly, test-support
- **Runtime:** api process
- **Governing ADRs:** 006, 018

Dependency-boundary enforcement (import-lint) is added by **ACBP-P0-012**, per
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (Required dependency rules).
This package currently contains only an empty entry point.
