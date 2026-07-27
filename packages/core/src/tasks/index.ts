// core/tasks — module public index (ACBP-P4-002; CDR-033). Cross-module imports go through this index (spec rule 10).
export {
  createTask,
  planTask,
  addTaskDependency,
  getTask,
  listTasks,
  toTaskDTO,
} from './task-management.js';
export { getTaskBoard, buildTaskBoard } from './task-board.js';
export type { GetTaskBoardParams, GetTaskBoardResult, TaskBoardOptions } from './task-board.js';
// Task detail + repeat/delete controls (ACBP-P4-005; CDR-043; TASK-002/TASK-008).
export { getTaskDetail, repeatTask, deleteTask, TASK_DELETE_REASON_MAX } from './task-controls.js';
export type {
  GetTaskDetailParams,
  GetTaskDetailResult,
  RepeatTaskParams,
  RepeatTaskResult,
  DeleteTaskParams,
  DeleteTaskResult,
} from './task-controls.js';
export type {
  TaskOptions,
  CreateTaskParams,
  CreateTaskResult,
  PlanTaskParams,
  PlanTaskResult,
  AddDependencyParams,
  AddDependencyResult,
  GetTaskParams,
  GetTaskResult,
  ListTasksParams,
  ListTasksResult,
} from './task-management.js';
