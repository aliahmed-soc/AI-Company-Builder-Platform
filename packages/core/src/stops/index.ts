// core/stops — module public index (ACBP-P6-007; CDR-072). Cross-module imports go through this index
// (spec rule 10).
//
// ENUMERATED, not `export *`: a use case missing from here compiles, tests fine in place, and is reachable by
// nobody — which is exactly how ACBP-P6-003 shipped an approval service with no consumers.
export { activateStop, clearStop, reviewHeldWork, readStopState, STOP_REFUSAL_REASONS } from './stop-service.js';
export type {
  StopServiceOptions,
  StopRefusalReason,
  ActivateStopParams,
  ActivateStopResult,
  ClearStopParams,
  ClearStopResult,
  ReviewHeldWorkParams,
  ReviewHeldWorkResult,
  StopScopeAvailability,
  ReadStopStateResult,
} from './stop-service.js';
