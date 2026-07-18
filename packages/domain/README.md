# @acbp/domain

**Scaffold stub (ACBP-P0-011) — no product functionality yet.**

- **Responsibility:** Pure domain logic: entities, state machines, invariants (no I/O)
- **Allowed dependencies:** contracts
- **Forbidden dependencies:** any SDK, database, adapters, gateway
- **Runtime:** both
- **Governing ADRs:** 006, 008, 009

Dependency-boundary enforcement (import-lint) is added by **ACBP-P0-012**, per
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (Required dependency rules).
This package currently contains only an empty entry point.
