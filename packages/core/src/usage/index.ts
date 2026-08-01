// core/usage — module public index (ACBP-P6-009; CDR-073). Cross-module imports go through this index
// (spec rule 10).
//
// `rebuildAccountUsageRollup` is exported for the reconciliation path and the integration suites. It is
// deliberately reachable from NO API route: whether an account owner may trigger a rebuild on demand, or whether
// it is platform-only, is an open owner decision (CDR-073 §3.2), and no `usage:rebuild` authz action exists for a
// route to authorize against.
export { rebuildAccountUsageRollup } from './usage-rollup-service.js';
export type {
  RebuildAccountUsageRollupParams,
  RebuildAccountUsageRollupOptions,
  RebuildAccountUsageRollupResult,
} from './usage-rollup-service.js';
