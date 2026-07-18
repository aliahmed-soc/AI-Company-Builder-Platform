# @acbp/adapters

**Concrete provider implementations — none exist yet.** The provider-neutral **contracts** these will
implement were defined in ACBP-P0-019 and live in `@acbp/contracts` (`src/adapters/`); see that
package's README for the full contract, neutrality rules, and conventions.

- **Responsibility:** External provider adapters (future): clerk/ (identity), infisical/ (secrets), storage/ (S3-compatible), model/ (gateway provider adapters)
- **Allowed dependencies:** contracts, config, observability
- **Forbidden dependencies:** domain, core, database
- **Runtime:** both
- **Governing ADRs:** 011, 014, 016, 021, 022

## Status (ACBP-P0-019)

- **Contracts:** defined in `@acbp/contracts` (secrets, identity, storage, model). No SDK, no network.
- **Implementations:** deferred to later tickets (model → ADR-019; identity → Clerk/ADR-022; secrets
  → Infisical/ADR-021; storage → **pending the P0-005 owner decision**). No provider SDK is installed.
- **Contract/conformance tests** live here: `src/adapter-contracts.test.ts` (behavioral, via
  `@acbp/test-support` fakes) and `src/provider-neutrality.test.ts` (static no-SDK / no-leak /
  P0-005-still-Blocked proofs). These import test-only fakes; `@acbp/test-support` is never a
  production dependency (P0-012).

A future implementation `implements` the contract, keeps all provider SDK types inside itself, maps
provider errors to `PlatformError`, and returns only neutral types — so a provider swap is an
implementation + config change with no product-code impact.

Dependency-boundary enforcement (import-lint): `pnpm run check:boundaries` (ACBP-P0-012).
