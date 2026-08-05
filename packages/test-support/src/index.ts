// @acbp/test-support — shared test helpers (dev/CI only; never a production dependency).
// Kept intentionally minimal (ACBP-P0-014); real shared fixtures/fakes are added by the
// tickets that need them. See docs/implementation/TESTING.md §"Shared test support".
export const TEST_MARKER = 'acbp-test-support' as const;

// Provider-adapter fakes (ACBP-P0-019) — deterministic, SDK-free test doubles for the contracts.
export * from './adapters/fakes.js';


// Tenant-isolation adversarial harness + threat inventory (ACBP-P1-014; CDR-020). Dev/CI only —
// `test-support` may never become a production dependency (boundary rule 9).
export * from './tenancy/two-tenant-harness.js';
export * from './tenancy/threat-inventory.js';
export * from './tenancy/slice-a-journey.js';
export * from './tenancy/slice-b-journey.js';
// ACBP-P4-007 / CDR-044 — the Slice D (planned work) journey, shared by `pnpm demo:slice-d` and the CI suite.
// ACBP-P3-007 / CDR-045 — the Slice C (strategy selection) journey, shared by `pnpm demo:slice-c` and the CI suite.
export { runSliceCJourney } from './tenancy/slice-c-journey.js';
export type { SliceCOps, SliceCJourneyDeps, SliceCFakeBehavior, SliceCGateway, SliceCValidator, FailingAuditWriter } from './tenancy/slice-c-journey.js';
export { runSliceDJourney } from './tenancy/slice-d-journey.js';
export type { SliceDOps, SliceDJourneyDeps, SliceDFakeBehavior, SliceDGateway, SliceDValidator, SliceDBoard, SliceDDetail } from './tenancy/slice-d-journey.js';
// ACBP-P5-015 / CDR-065 — the Slice E (safe internal execution) journey, shared by `pnpm demo:slice-e` and the CI suite.
export { runSliceEJourney } from './tenancy/slice-e-journey.js';
export type { SliceEOps, SliceEJourneyDeps, SliceEFakeBehavior, SliceEGateway, SliceEArtifact, SliceELineageArtifact, SliceESource } from './tenancy/slice-e-journey.js';
// ACBP-P6-012 / CDR-077 — the Slice F (safety and recovery) journey, shared by `pnpm demo:slice-f` and the CI suite.
export { runSliceFJourney } from './tenancy/slice-f-journey.js';
export type { SliceFOps, SliceFJourneyDeps, SliceFDispatchResult, SliceFGateway, SliceFLogCapture, SliceFLogRecord } from './tenancy/slice-f-journey.js';
