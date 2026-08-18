/*
 * ACBP-FE-014 — the plan screen: the roadmap above, the task board below.
 *
 * ENTIRELY A SERVER COMPONENT, and that is a decision rather than an omission. This slice has NO writes: the
 * roadmap read and the board read are both safe methods, `generateRoadmap` reaches no HTTP route, and the
 * versioned edit (`POST /roadmap/edit`) is a separate concern this row does not cover. With nothing to
 * mutate there is no state to hold, so there is no client bundle at all — the previous console screens are
 * client components only because they submit something.
 *
 * PURE OVER THE TWO VIEWS. Every ruling lives in `roadmap-view.ts` and `board-view.ts`, which are tested;
 * this file only arranges what they produced.
 */
import type { RoadmapView } from './roadmap-view';
import type { BoardView, BucketView } from './board-view';

export function RoadmapScreen({ roadmap, board, boardRefusalStatus, companyId }: { roadmap: RoadmapView; board: BoardView | null; boardRefusalStatus: string | null; companyId: string }): React.JSX.Element {
  return (
    <>
      <RoadmapSection view={roadmap} />
      {board === null ? <BoardUnavailable status={boardRefusalStatus} /> : <BoardSection view={board} companyId={companyId} />}
    </>
  );
}

function RoadmapSection({ view }: { view: RoadmapView }): React.JSX.Element {
  if (view.state === 'nothing_planned') {
    return (
      <section className="cs-card" aria-labelledby="cs-rm-empty-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-rm-empty-h">
            Roadmap
          </h2>
        </div>
        <p className="cs-empty">{view.headline}</p>
        <p className="cs-help">
          A roadmap is generated from a recorded strategy decision. That generation is a model-driven step this console cannot start yet — no HTTP route reaches it — so there is deliberately no button here rather than
          one that would do nothing.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="cs-card" aria-labelledby="cs-rm-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-rm-h">
            Roadmap
          </h2>
          <span className="cs-badge cs-badge--muted">version {String(view.version ?? 0)}</span>
          {view.state === 'partial' ? <span className="cs-badge cs-badge--warning">partial</span> : null}
        </div>
        <p className="cs-refusal-detail">{view.headline}</p>

        <ul className="cs-list">
          <li className="cs-item">
            <span className="cs-item-meta">{view.originNote}</span>
            {view.editReason === null ? null : <span className="cs-item-body">“{view.editReason}”</span>}
          </li>
          {view.supersedesEarlier ? (
            <li className="cs-item">
              <span className="cs-item-meta">This version replaced an earlier roadmap. The earlier one is kept but is not what the platform now plans against.</span>
            </li>
          ) : null}
          {/* The model reporting on its own output — a SEPARATE fact from the server's completeness ruling,
              so it is stated even when the roadmap is marked complete. */}
          {view.modelFlaggedPartial ? (
            <li className="cs-item cs-strat-caveat cs-strat-caveat--warning">
              The model flagged its own output as partial when this roadmap was produced. That is independent of the completeness above.
            </li>
          ) : null}
          {view.hasDanglingMilestone ? (
            <li className="cs-item cs-strat-caveat cs-strat-caveat--warning">
              At least one milestone names a goal that is not in this roadmap. Those milestones are listed below under “Not attached to a goal” rather than dropped, but the roadmap is internally inconsistent.
            </li>
          ) : null}
        </ul>

        <dl className="cs-co-meta cs-co-meta--wide">
          <div>
            <dt>Goals still active</dt>
            <dd>
              {String(view.activeGoalCount)} of {String(view.goals.length)}
            </dd>
          </div>
          <div>
            <dt>Milestones reached</dt>
            <dd>{String(view.reachedMilestoneCount)}</dd>
          </div>
          <div>
            <dt>Milestones planned</dt>
            <dd>{String(view.plannedMilestoneCount)}</dd>
          </div>
          <div>
            <dt>Milestones dropped</dt>
            <dd>{String(view.droppedMilestoneCount)}</dd>
          </div>
        </dl>
      </section>

      <section className="cs-card" aria-labelledby="cs-rm-goals-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-rm-goals-h">
            Goals and milestones
          </h2>
        </div>
        {view.goals.length === 0 ? (
          <p className="cs-empty">This roadmap records no goals.</p>
        ) : (
          <ol className="cs-list cs-plan-goals">
            {view.goals.map((g) => (
              <li key={g.goalId} className={`cs-item cs-plan-goal cs-plan-goal--${g.status}`} data-status={g.status}>
                <div className="cs-plan-goal-h">
                  <span className="cs-item-title">{g.title}</span>
                  <span className={`cs-badge ${g.status === 'achieved' ? 'cs-badge--success' : g.status === 'dropped' ? 'cs-badge--muted' : 'cs-badge--primary'}`}>{g.status}</span>
                </div>
                {g.description === null ? null : <span className="cs-item-body">{g.description}</span>}
                {g.milestones.length === 0 ? (
                  <span className="cs-item-meta">No milestones are recorded under this goal.</span>
                ) : (
                  <ul className="cs-plan-milestones">
                    {g.milestones.map((m) => (
                      <li key={m.milestoneId} className="cs-plan-milestone" data-status={m.status}>
                        <span className="cs-item-title">{m.title}</span>
                        <span className={`cs-badge ${m.status === 'reached' ? 'cs-badge--success' : m.status === 'dropped' ? 'cs-badge--muted' : 'cs-badge--primary'}`}>{m.status}</span>
                        {m.description === null ? null : <span className="cs-item-body">{m.description}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}

        {/* NEVER OMITTED. A milestone with no goal — or one naming a goal absent from this roadmap — would
            vanish entirely from a screen that renders milestones only underneath their goal. */}
        {view.unattachedMilestones.length === 0 ? null : (
          <>
            <h3 className="cs-card-t">Not attached to a goal</h3>
            <ul className="cs-plan-milestones">
              {view.unattachedMilestones.map((m) => (
                <li key={m.milestoneId} className="cs-plan-milestone" data-status={m.status}>
                  <span className="cs-item-title">{m.title}</span>
                  <span className="cs-badge cs-badge--muted">{m.status}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

function BoardUnavailable({ status }: { status: string | null }): React.JSX.Element {
  return (
    <section className="cs-card" aria-labelledby="cs-tb-refused-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-tb-refused-h">
          Task board
        </h2>
      </div>
      {/* THE ROADMAP READ SUCCEEDED AND THIS ONE DID NOT, so the page shows what it has and says what it
          lacks. Replacing the whole screen with a refusal would throw away a roadmap the founder is allowed
          to see; showing an empty board would claim there are no tasks, which the server never said. */}
      <p className="cs-refusal-detail">
        The roadmap above was read successfully, but the task board was refused{status === null ? '' : ` (${status})`}. This page is therefore incomplete: it is showing no tasks because it could not read them, not
        because there are none.
      </p>
    </section>
  );
}

function BoardSection({ view, companyId }: { view: BoardView; companyId: string }): React.JSX.Element {
  return (
    <section className="cs-card" aria-labelledby="cs-tb-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-tb-h">
          Task board
        </h2>
        <span className="cs-badge cs-badge--muted">{String(view.totalOnBoard)} on the board</span>
        {view.truncated ? <span className="cs-badge cs-badge--warning">a page, not everything</span> : null}
      </div>

      {view.integrityWarning === null ? null : (
        <p className="cs-control-outcome cs-control-outcome--error" role="note">
          {view.integrityWarning}
        </p>
      )}

      {view.isEmpty ? (
        <p className="cs-empty">{view.emptyNote}</p>
      ) : (
        <>
          {view.draftsOffBoard > 0 ? (
            <p className="cs-help">
              {String(view.draftsOffBoard)} planned {view.draftsOffBoard === 1 ? 'task is' : 'tasks are'} waiting as a draft and are deliberately not on the board until confirmed.
            </p>
          ) : null}
          <div className="cs-plan-board">
            {view.buckets.map((b) => (
              <BucketColumn key={b.bucket} bucket={b} companyId={companyId} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function BucketColumn({ bucket, companyId }: { bucket: BucketView; companyId: string }): React.JSX.Element {
  const headingId = `cs-tb-${bucket.bucket}`;
  return (
    <section className={`cs-plan-bucket cs-plan-bucket--${bucket.tone}`} data-bucket={bucket.bucket} data-tone={bucket.tone} aria-labelledby={headingId}>
      <div className="cs-plan-bucket-h">
        <h3 className="cs-plan-bucket-t" id={headingId}>
          {bucket.label}
        </h3>
        {/* An em dash where a number would go, for a bucket nothing can reach. Never a 0 — that would be an
            answer about this company, and the server gave one about the platform. */}
        <span className="cs-plan-bucket-count" aria-label={bucket.count === null ? `${bucket.label}: not available in this version` : `${bucket.label}: ${String(bucket.count)} tasks`}>
          {bucket.countLabel}
        </span>
      </div>
      {bucket.note === '' ? null : <p className="cs-plan-bucket-note">{bucket.note}</p>}
      {bucket.countMismatch ? <p className="cs-plan-bucket-note">Showing {String(bucket.shownCount)} of {String(bucket.count ?? 0)}. The rest are not listed here.</p> : null}
      {bucket.tasks.length === 0 ? null : (
        <ul className="cs-plan-tasks">
          {bucket.tasks.map((t) => (
            <li key={t.taskId} className={`cs-plan-task${t.dependencyBlocked ? ' cs-plan-task--blocked' : ''}`}>
              {/* ACBP-FE-015: every task row reaches its execution history. A real link, not a placeholder. */}
              <a className="cs-item-title" href={`/console/companies/${encodeURIComponent(companyId)}/tasks/${encodeURIComponent(t.taskId)}`}>
                {t.title}
              </a>
              <span className="cs-item-meta">
                {t.taskTypeLabel}
                {t.rankLabel === null ? '' : ` · ${t.rankLabel}`}
              </span>
              {t.dependencyBlocked ? <span className="cs-badge cs-badge--warning">blocked by {String(t.dependsOnCount)}</span> : null}
              {/* Shown even when this task is NOT blocked: the cost of a stuck task is what it holds up. */}
              {t.blocksCount > 0 ? <span className="cs-badge cs-badge--muted">blocks {String(t.blocksCount)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
