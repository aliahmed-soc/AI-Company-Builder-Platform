// core/tools — module public index. The dispatcher is THE chokepoint (ACBP-P5-003b; CDR-054): nothing outside this
// module executes a tool, and nothing imports `dispatcher.js` directly (spec rule 10).
export { dispatchToolCall, reportToolCallOutcome, digestToolArguments } from './dispatcher.js';
export type {
  ToolGates,
  DispatcherOptions,
  DispatchToolCallParams,
  DispatchToolCallResult,
  ReportToolCallOutcomeParams,
  ReportToolCallOutcomeResult,
  ToolCallDTO,
} from './dispatcher.js';
