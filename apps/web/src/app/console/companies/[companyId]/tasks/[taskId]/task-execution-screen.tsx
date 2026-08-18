/*
 * ACBP-FE-015 — one task and every attempt to run it. A server component: this slice has no writes.
 *
 * THE CONTROLS COME FROM THE SERVER AND ARE RENDERED AS VERDICTS, NOT AS BUTTONS. `TaskDetailDTO.controls` is
 * total over `TASK_CONTROLS` and carries `available` plus a `reason` whenever it is false — derived from the
 * task's own state at read time, never stored, "because a persisted availability set goes stale the moment the
 * task changes state, which is precisely when the owner is most likely to be looking at it". Every control it
 * names is also one with NO ROUTE behind it, so this page prints the verdict and its reason and offers
 * nothing to click. Showing an enabled button for an available control would be the lie; showing a disabled
 * one for an unavailable control would imply the enabled case works.
 *
 * `latestFailure` NULL MEANS "HAS NOT FAILED", NOT "NO DETAIL". The DTO says so explicitly: an empty object
 * "would render as a failure with every field blank, which is precisely what TASK-006's no blank failures
 * forbids — so the two states are distinguishable by construction". This screen keeps them distinguishable.
 */
import type { TaskDetailDTO } from '@acbp/contracts';
import { toRunView, type RunLike, type RunView } from '../run-view';

export function TaskExecutionScreen({
  task,
  runs,
  runsRefusalStatus,
  now,
}: {
  task: TaskDetailDTO;
  runs: readonly RunLike[] | null;
  runsRefusalStatus: string | null;
  now: number;
}): React.JSX.Element {
  return (
    <>
      <section className="cs-card" aria-labelledby="cs-tk-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-tk-h">
            The task
          </h2>
          <span className="cs-badge cs-badge--muted">{task.state}</span>
          <span className="cs-badge cs-badge--muted">{task.phase}</span>
        </div>
        {task.description === null ? <p className="cs-help">No description was recorded for this task.</p> : <p className="cs-item-body">{task.description}</p>}
        <dl className="cs-co-meta cs-co-meta--wide">
          <div>
            <dt>Why planning chose it</dt>
            {/* "Not recorded", never invented — the DTO's own words. */}
            <dd>{task.rationale ?? 'Not recorded. The model gave no rationale for this task.'}</dd>
          </div>
          <div>
            <dt>Type</dt>
            <dd>{task.taskType ?? 'Not stated'}</dd>
          </div>
          <div>
            <dt>Repeated from</dt>
            <dd>{task.repeatedFromTaskId ?? 'Not a repeat'}</dd>
          </div>
        </dl>
      </section>

      {/* THE FAILURE, WHEN THERE IS ONE. `null` is "has not failed" and renders nothing at all — never an
          empty failure card, which is the shape TASK-006 forbids. */}
      {task.latestFailure === null ? null : (
        <section className="cs-card cs-tk-failure" aria-labelledby="cs-tk-fail-h">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-tk-fail-h">
              The latest failure
            </h2>
            <span className="cs-badge cs-badge--danger">{task.latestFailure.category}</span>
          </div>
          <p className="cs-item-body">{task.latestFailure.summary}</p>
          <dl className="cs-co-meta cs-co-meta--wide">
            <div>
              <dt>Attempts</dt>
              <dd>
                {String(task.latestFailure.attemptsUsed)} of {String(task.latestFailure.attemptsAllowed)}
              </dd>
            </div>
            <div>
              <dt>Safe to retry?</dt>
              {/* NOT A HINT. `unsafe` means a retry may repeat an effect that already happened outside the
                  platform, so it is stated in those terms rather than as a status word. */}
              <dd>
                {task.latestFailure.retrySafety === 'safe'
                  ? 'Yes — the server judged a retry safe.'
                  : 'No — the server judged a retry UNSAFE, which means running it again may repeat an effect that already happened.'}
              </dd>
            </div>
          </dl>
        </section>
      )}

      <section className="cs-card" aria-labelledby="cs-tk-controls-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-tk-controls-h">
            What the server says can be done
          </h2>
        </div>
        <p className="cs-help">
          These are the server’s verdicts for this task in its current state, not buttons. None of them has an HTTP route in this build, so this page reports what would be permitted rather than offering to do it.
        </p>
        <ul className="cs-list">
          {task.controls.map((c) => (
            <li key={c.control} className="cs-item cs-stack" data-available={c.available ? 'yes' : 'no'}>
              <span className="cs-item-title">
                {c.control}: {c.available ? 'available' : 'not available'}
              </span>
              {/* A reason accompanies every unavailable verdict — the contract makes it total. */}
              {c.reason === null ? null : <span className="cs-help">{c.reason}</span>}
            </li>
          ))}
        </ul>
      </section>

      {runs === null ? (
        <section className="cs-card" aria-labelledby="cs-tk-runs-refused-h">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-tk-runs-refused-h">
              Runs
            </h2>
          </div>
          {/* REFUSED, NOT EMPTY. The task above was readable; showing an empty run list here would claim the
              task has never been attempted, which the server did not say. */}
          <p className="cs-refusal-detail">
            The task above was read successfully, but its run history was refused{runsRefusalStatus === null ? '' : ` (${runsRefusalStatus})`}. No runs are shown because they could not be read, not because there are
            none.
          </p>
        </section>
      ) : (
        <section className="cs-card" aria-labelledby="cs-tk-runs-h">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-tk-runs-h">
              Runs
            </h2>
            <span className="cs-badge cs-badge--muted">{String(runs.length)}</span>
          </div>
          {runs.length === 0 ? (
            <p className="cs-empty">This task has never been run. The server returned an empty history, which is different from a history it could not read.</p>
          ) : (
            <ul className="cs-list cs-tk-runs">
              {runs.map((r) => (
                <RunCard key={r.runId} run={toRunView(r, now)} />
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function RunCard({ run }: { run: RunView }): React.JSX.Element {
  return (
    <li className="cs-tk-run" data-phase={run.phase}>
      <div className="cs-tk-run-h">
        <span className="cs-item-title">Attempt {String(run.attempt)}</span>
        <span className={`cs-badge cs-tk-phase cs-tk-phase--${run.phase}`}>{run.stateLabel}</span>
        {run.durationSeconds === null ? null : <span className="cs-help">{String(run.durationSeconds)}s</span>}
      </div>
      {/* Each of these renders ONLY when it means something — see the mapper. A finished run says nothing
          about heartbeats, and a run that did not fail says nothing about failure. */}
      {run.stopNote === '' ? null : <p className="cs-help cs-tk-stop">{run.stopNote}</p>}
      {run.heartbeatNote === '' ? null : <p className={run.heartbeatStale ? 'cs-help cs-tk-stale' : 'cs-help'}>{run.heartbeatNote}</p>}
      {run.failureLabel === '' ? null : <p className="cs-help cs-tk-failed">{run.failureLabel}</p>}
    </li>
  );
}
