# @acbp/adapters

**Scaffold stub (ACBP-P0-011) — no product functionality yet.**

- **Responsibility:** External provider adapters: clerk/ (identity), infisical/ (secrets), storage/ (S3-compatible)
- **Allowed dependencies:** contracts, config, observability
- **Forbidden dependencies:** domain, core, database
- **Runtime:** both
- **Governing ADRs:** 014, 016, 021, 022

Dependency-boundary enforcement (import-lint) is added by **ACBP-P0-012**, per
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (Required dependency rules).
This package currently contains only an empty entry point.
