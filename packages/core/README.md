# @acbp/core

**Scaffold stub (ACBP-P0-011) — no product functionality yet.**

- **Responsibility:** Application modules; orchestrates domain + database + gateway/adapters via contracts
- **Allowed dependencies:** domain, contracts, database, gateway (via interface), adapters (via interface), observability
- **Forbidden dependencies:** provider SDKs directly; UI
- **Runtime:** both
- **Governing ADRs:** 006-017

Dependency-boundary enforcement (import-lint) is added by **ACBP-P0-012**, per
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (Required dependency rules).
This package currently contains only an empty entry point.
