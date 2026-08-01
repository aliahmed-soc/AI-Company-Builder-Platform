// core/usage — module public index (ACBP-P6-009; CDR-073). Cross-module imports go through this index
// (spec rule 10).
//
// `rebuildAccountUsageRollup` is exported for the reconciliation path and the integration suites. It is
// deliberately reachable from NO API route: whether an account owner may trigger a rebuild on demand, or whether
// it is platform-only, is an open owner decision (CDR-073 §3.2), and no `usage:rebuild` authz action exists for a
// route to authorize against.
export { rebuildAccountUsageRollup, reconcileAccountUsageRollup, readAccountUsageRollup } from './usage-rollup-service.js';
export type {
  RebuildAccountUsageRollupParams,
  RebuildAccountUsageRollupOptions,
  RebuildAccountUsageRollupResult,
  ReconcileAccountUsageRollupParams,
  ReconcileAccountUsageRollupResult,
  ReadAccountUsageRollupParams,
  ReadAccountUsageRollupResult,
} from './usage-rollup-service.js';

// Compensating corrections (trust-critical #13). `usage:correct` is owner-only and, unlike the rebuild above,
// this one HAS an authorization action: canon rules who may adjust recorded usage, whereas who may trigger a
// maintenance rebuild is still an open owner question (CDR-073 §3.2).
export { recordUsageCorrection } from './usage-correction-service.js';
export type {
  RecordUsageCorrectionParams,
  RecordUsageCorrectionOptions,
  RecordUsageCorrectionResult,
} from './usage-correction-service.js';
