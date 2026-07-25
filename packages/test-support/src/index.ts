// @acbp/test-support — shared test helpers (dev/CI only; never a production dependency).
// Kept intentionally minimal (ACBP-P0-014); real shared fixtures/fakes are added by the
// tickets that need them. See docs/implementation/TESTING.md §"Shared test support".
export const TEST_MARKER = 'acbp-test-support' as const;

// Provider-adapter fakes (ACBP-P0-019) — deterministic, SDK-free test doubles for the contracts.
export * from './adapters/fakes.js';


// Tenant-isolation adversarial harness + threat inventory (ACBP-P1-014; CDR-020). Dev/CI only —
// 	est-support may never become a production dependency (boundary rule 9).
export * from './tenancy/two-tenant-harness.js';
export * from './tenancy/threat-inventory.js';
export * from './tenancy/slice-a-journey.js';
export * from './tenancy/slice-b-journey.js';
