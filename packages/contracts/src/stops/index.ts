// contracts/stops — module public index (ACBP-P6-007a; CDR-072). Cross-module imports go through this index
// (spec rule 10).
export { STOP_SCOPES, isStopScope, evaluateStops } from './scope.js';
export type { StopScope, StopRecord, StoppableCall, StopEvaluation } from './scope.js';
