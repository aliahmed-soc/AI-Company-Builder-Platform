// core/tasks — module public index (ACBP-P4-002; CDR-033). Cross-module imports go through this index (spec rule 10).
export {
  createTask,
  planTask,
  addTaskDependency,
  getTask,
  listTasks,
  toTaskDTO,
} from './task-management.js';
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
