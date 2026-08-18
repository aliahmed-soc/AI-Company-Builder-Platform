/*
 * ACBP-FE Slice 1 — the company overview screen.
 *
 * Anchored to ACBP-FE-001 (tokens/primitives), ACBP-FE-002 (shell) and ACBP-FE-011 (activity feed).
 * The stat cards and the approvals list are VISUALS ONLY — FE-016/017/018 remain Blocked-API and are not
 * advanced by this slice; nothing here fetches, mutates, authorizes or persists.
 *
 * Server component. The client code in this console is the counter and the sidebar nav links, each for the
 * reason given in its own file; this page adds none.
 *
 * THIS SCREEN IS STILL ENTIRELY MOCK. `/console/companies` (ACBP-FE-004) is the first console screen that reads
 * real data — the figures below remain invented, which is why the banner stays.
 */
import { MOCK_STATS, MOCK_APPROVALS, MOCK_ACTIVITY } from './mock-data';
import { Counter } from './counter';

export default function ConsoleOverviewPage() {
  return (
    <>
      {/* Said on screen, not only in the source: whoever is looking at this is looking at invented numbers. */}
      <div className="cs-mock" role="note">
        <strong>Mock data.</strong> Every figure on this screen is invented for design review — nothing is read
        from the database, and no control here performs an action.
      </div>

      <div>
        <h1 className="cs-h1">Company overview</h1>
        <p className="cs-sub">Northwind Coffee · a snapshot of what the platform is doing right now.</p>
      </div>

      <section className="cs-stats" aria-label="Key figures">
        {MOCK_STATS.map((s, i) => (
          <article
            key={s.id}
            className="cs-stat"
            style={
              {
                '--i': i,
                '--tint': s.tint,
                '--ico-bg': s.iconBg,
                '--ico-fg': s.iconFg,
              } as React.CSSProperties
            }
          >
            <div className="cs-stat-top">
              <span className="cs-stat-label">{s.label}</span>
              <span className="cs-stat-ico" aria-hidden="true">
                {s.icon}
              </span>
            </div>
            <div className="cs-stat-value">
              <Counter value={s.value} {...(s.display === undefined ? {} : { display: s.display })} />
            </div>
            <div className="cs-stat-foot">{s.foot}</div>
          </article>
        ))}
      </section>

      <div className="cs-cols">
        <section className="cs-card cs-rise" style={{ '--i': 4 } as React.CSSProperties} aria-labelledby="cs-appr">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-appr">
              Awaiting your approval
            </h2>
            <span className="cs-badge cs-badge--warning">{MOCK_APPROVALS.length}</span>
            <span className="cs-spacer" />
            <span className="cs-badge cs-badge--muted">Placeholder</span>
          </div>
          <ul className="cs-list">
            {MOCK_APPROVALS.map((a) => (
              <li key={a.id} className="cs-item">
                <div className="cs-item-body">
                  <p className="cs-item-title">{a.title}</p>
                  <p className="cs-item-meta">{a.meta}</p>
                </div>
                <span className={`cs-badge cs-badge--${a.kind}`}>{a.kindLabel}</span>
                {/* Disabled for the same reason as the emergency stop: FE-016 is Blocked-API. */}
                <button type="button" className="cs-btn cs-btn--ghost" disabled title="Visual placeholder (ACBP-FE-016)">
                  Review
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="cs-card cs-rise" style={{ '--i': 5 } as React.CSSProperties} aria-labelledby="cs-act">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-act">
              Recent activity
            </h2>
            <span className="cs-spacer" />
            <span className="cs-badge cs-badge--muted">Today</span>
          </div>
          {/* FE-011 accessibility criterion: a list, with real <time> elements. */}
          <ul className="cs-feed">
            {MOCK_ACTIVITY.map((e) => (
              <li key={e.id}>
                <span className={`cs-dot cs-dot--${e.tone}`} aria-hidden="true" />
                <p className="cs-feed-text">{e.text}</p>
                <time className="cs-feed-time" dateTime={`2026-08-15T${e.time}:00`}>
                  {e.time}
                </time>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
