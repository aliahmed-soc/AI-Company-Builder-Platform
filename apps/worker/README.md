# @acbp/worker

**Scaffold stub (ACBP-P0-011) — no product functionality yet.**

- **Responsibility:** Job pickup, worker runtime host
- **Allowed dependencies:** core, contracts, config, observability
- **Forbidden dependencies:** UI code; adapters directly
- **Runtime:** worker process
- **Governing ADRs:** 006, 008, 012

Dependency-boundary enforcement (import-lint) is added by **ACBP-P0-012**, per
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (Required dependency rules).
This package currently contains only an empty entry point.
