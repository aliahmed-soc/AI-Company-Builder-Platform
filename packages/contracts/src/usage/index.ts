// contracts/usage — module public index (ACBP-P6-009; CDR-073). Cross-module imports go through this index
// (spec rule 10).
export {
  USAGE_ROLLUP_LANES,
  usagePeriodStart,
  isUsagePeriodStart,
  emptyRollupFigures,
  addRollupFigures,
  rollupFigureDrift,
  lanesExceedingThreshold,
} from './rollup.js';
export type { UsageRollupLane, RollupFigures, UsagePeriodStart } from './rollup.js';
