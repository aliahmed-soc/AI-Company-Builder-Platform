// @acbp/core ? the workflow coordinator (ACBP-P5-002; CDR-053).
export { startRun, heartbeatRun, succeedRun, failRun, cancelRun, reclaimLostRuns } from './coordinator.js';
export type { StartRunParams, StartRunResult, HeartbeatRunParams, HeartbeatRunResult, FinishRunParams, FinishRunResult, CancelRunParams, CancelRunResult, ReclaimLostRunsParams, ReclaimLostRunsResult, RunDTO, CoordinatorOptions } from './coordinator.js';

// The run READ (ACBP-API-003; CDR-089). Everything above is the coordinator's WRITE surface — this barrel had no
// read to export until now, which is the same absence CDR-089 §0.2 recorded when it made this its own ticket.
//
// NAMED exports, matching the line above rather than `export *`. That is deliberate here: a barrel that re-exports
// everything makes a new module visible by accident, and slice 2 hit the inverse failure — `export *` HID the
// artifact use cases from a symbol search and produced a wrong claim that they did not exist. Naming costs a line
// and makes the export surface a decision.
export { getTaskRun, listTaskRuns, toTaskRunDTO } from './run-read.js';
export type { GetTaskRunParams, GetTaskRunResult, ListTaskRunsParams, ListTaskRunsResult, TaskRunDTO, RunReadOptions } from './run-read.js';