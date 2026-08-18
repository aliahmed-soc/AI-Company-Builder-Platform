/*
 * ACBP-FE-015 — one task's execution history.
 *
 * WHAT THE ROW ASKS FOR AND WHAT EXISTS. The row is "Task execution: preflight, progress, result artifact,
 * failure detail, revision lineage", and its prerequisite cell asks for four routes. Three of the four reads
 * are live — `GET /tasks/{taskId}`, `GET /tasks/{taskId}/runs`, `GET /runs/{runId}`, plus the artifact and
 * lineage reads. What has no route is the two WRITES: starting a run, and requesting a revision. Verified by
 * enumerating every `route.ts` under `apps/web/src` rather than by a glob — a bracketed segment like
 * `[taskId]` is read as a character class and silently matches nothing.
 *
 *   DELIVERED — progress (every run, its state, duration, heartbeat and attempt), failure detail, and the
 *               controls the server says are available with its reason when one is not.
 *   NOT SHIPPED — a Start button and a "request a revision" control, because neither has anywhere to post.
 *   NOT ON THIS PAGE — the artifact body. `GET /artifacts/{artifactId}` exists and returns the metadata DTO;
 *               rendering a document viewer is its own screen and is not claimed here.
 *
 * TWO READS, ISSUED TOGETHER, WITH INDEPENDENT REFUSALS — the same rule as the plan screen. The task read
 * failing means there is nothing to frame the runs with; the runs read failing while the task is readable
 * means the page shows the task and says the run history was REFUSED, not that there are no runs.
 */
import { getTaskDetailForRequest, listTaskRunsForRequest } from '@/server/companies/companies-request';
import { TaskRefusal } from './task-refusal';
import { TaskExecutionScreen } from './task-execution-screen';

export const metadata = {
  title: 'Task — AI Company Builder',
  description: 'One task, what the platform decided about it, and every attempt to run it.',
};

export const dynamic = 'force-dynamic';

export default async function TaskPage({ params }: { params: Promise<{ companyId: string; taskId: string }> }): Promise<React.JSX.Element> {
  const { companyId, taskId } = await params;
  const [taskResult, runsResult] = await Promise.all([getTaskDetailForRequest(companyId, taskId), listTaskRunsForRequest(companyId, taskId)]);

  if (taskResult.status !== 'task') {
    return <TaskRefusal status={taskResult.status} retryAfterSeconds={'retryAfterSeconds' in taskResult ? taskResult.retryAfterSeconds : undefined} />;
  }

  return (
    <>
      <div>
        <h1 className="cs-h1">{taskResult.task.title}</h1>
        <p className="cs-sub">
          <a href={`/console/companies/${encodeURIComponent(companyId)}/roadmap`}>← Back to the plan</a>
        </p>
      </div>
      {/* `Date.now()` is read HERE and passed down, so the mapper stays pure and its heartbeat and duration
          boundaries are reachable in a test — which is exactly where a founder is misled. */}
      <TaskExecutionScreen task={taskResult.task} runs={runsResult.status === 'runs' ? runsResult.runs : null} runsRefusalStatus={runsResult.status === 'runs' ? null : runsResult.status} now={Date.now()} />
    </>
  );
}
