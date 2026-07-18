# @acbp/test-support

**Scaffold stub (ACBP-P0-011) — no product functionality yet.**

- **Responsibility:** Fakes (gateway, clock, vault), fixtures, adversarial harnesses
- **Allowed dependencies:** all (dev-only)
- **Forbidden dependencies:** NEVER imported by production code (lint-enforced in ACBP-P0-012)
- **Runtime:** dev/CI only
- **Governing ADRs:** -

Dependency-boundary enforcement (import-lint) is added by **ACBP-P0-012**, per
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (Required dependency rules).
This package currently contains only an empty entry point.
