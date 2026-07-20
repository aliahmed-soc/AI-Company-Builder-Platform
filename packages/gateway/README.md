# @acbp/gateway

**Scaffold stub (ACBP-P0-011) — no product functionality yet.**

- **Responsibility:** Model gateway: ADR-011 contract + provider adapters; usage/cost recording hooks; redaction
- **Allowed dependencies:** contracts, config, observability, adapters/infisical (key resolution via interface)
- **Forbidden dependencies:** domain, core, database
- **Runtime:** worker (and api for interview)
- **Governing ADRs:** 004, 011, 019

Dependency-boundary enforcement (import-lint) is added by **ACBP-P0-012**, per
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (Required dependency rules).
This package currently contains only an empty entry point.
