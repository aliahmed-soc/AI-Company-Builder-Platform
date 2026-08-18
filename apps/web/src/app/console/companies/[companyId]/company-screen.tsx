/*
 * ACBP-FE-006 — the company profile screen. A single page, per the owner's ruling, with the pause control on
 * the page and nowhere else.
 *
 * Pure over `CompanyPageView`; the only client code is the control, which needs to fetch.
 */
import type { CompanyPageView } from './company-view';
import { PauseControl } from './pause-control';

export function CompanyScreen({ view }: { view: CompanyPageView }): React.JSX.Element {
  if (view.kind === 'refusal') {
    const { refusal } = view;
    return (
      <>
        <div>
          <h1 className="cs-h1">Company</h1>
          <p className="cs-sub">
            <a href="/console/companies">← Back to your companies</a>
          </p>
        </div>
        <section className={`cs-card cs-refusal cs-refusal--${refusal.code}`} role="alert" aria-labelledby="cs-refusal-t">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-refusal-t">
              {refusal.title}
            </h2>
            <span className="cs-spacer" />
            <span className="cs-badge cs-badge--muted">{refusal.code}</span>
          </div>
          <p className="cs-refusal-detail">{refusal.detail}</p>
        </section>
      </>
    );
  }

  const { company, control } = view;
  return (
    <>
      <div>
        <h1 className="cs-h1">{company.name ?? 'Unnamed company'}</h1>
        <p className="cs-sub">
          <a href="/console/companies">← Back to your companies</a>
        </p>
      </div>

      <section className="cs-card cs-rise" aria-labelledby="cs-profile-t">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-profile-t">
            Profile
          </h2>
          <span className="cs-spacer" />
          {/* displayStatus is the founder-facing value; the raw lifecycle word appears below as detail. */}
          <span className="cs-badge cs-status cs-status--tone">{company.displayStatus}</span>
        </div>

        {company.description !== null ? (
          <p className="cs-refusal-detail">{company.description}</p>
        ) : (
          <p className="cs-refusal-detail">No description has been set for this company.</p>
        )}

        <dl className="cs-co-meta cs-co-meta--wide">
          <div>
            <dt>Your role</dt>
            <dd>{company.role}</dd>
          </div>
          <div>
            <dt>Lifecycle state</dt>
            {/* Shown because the transition rules are written against it — a founder told "you cannot pause
                while provisioning" should be able to see the word the rule actually tested. */}
            <dd>{company.internalStatus}</dd>
          </div>
          <div>
            <dt>Profile version</dt>
            <dd>{company.profileVersion ?? '—'}</dd>
          </div>
        </dl>
        <p className="cs-co-id">{company.companyId}</p>
      </section>

      {/* ACBP-FE-007. A real link, not a disabled placeholder — the interview screen exists. It is reached
          from here rather than from the sidebar for the same reason the provisioning screen is: the
          destination is company-scoped, and a global nav entry would have no companyId to resolve.

          The copy promises a session and its questions, and deliberately does NOT promise questions will be
          there: no route on this build can generate one, and the interview screen says so itself. */}
      <section className="cs-card cs-rise" style={{ '--i': 1 } as React.CSSProperties} aria-labelledby="cs-interview-t">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-interview-t">
            Interview
          </h2>
        </div>
        <p className="cs-refusal-detail">The discovery interview builds the platform’s understanding of this company. Its questions, the reason each was asked, and your answers live on their own screen.</p>
        <p className="cs-control">
          <a className="cs-btn" href={`/console/companies/${encodeURIComponent(company.companyId)}/interview`}>
            Open the interview
          </a>
        </p>
      </section>

      {/* ACBP-FE-010. Company-scoped, so it is reached from here rather than the sidebar, for the same
          reason the interview and provisioning screens are. */}
      <section className="cs-card cs-rise" style={{ '--i': 2 } as React.CSSProperties} aria-labelledby="cs-memory-t">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-memory-t">
            Memory
          </h2>
        </div>
        <p className="cs-refusal-detail">The memory items stored for this company, with where each came from and the versions the server still lists.</p>
        <p className="cs-control">
          <a className="cs-btn" href={`/console/companies/${encodeURIComponent(company.companyId)}/memory`}>
            Open the memory browser
          </a>
        </p>
      </section>

      {/* ACBP-FE-012. Company-scoped like the others. */}
      <section className="cs-card cs-rise" style={{ '--i': 3 } as React.CSSProperties} aria-labelledby="cs-dr-t">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-dr-t">
            Decision Room
          </h2>
        </div>
        <p className="cs-refusal-detail">The queues waiting on a decision for this company, with an update channel that says plainly when it is not connected.</p>
        <p className="cs-control">
          <a className="cs-btn" href={`/console/companies/${encodeURIComponent(company.companyId)}/decision-room`}>
            Open the Decision Room
          </a>
        </p>
      </section>

      {/* ACBP-FE-013. Company-scoped like the others.

          The copy promises the options and the decision, and deliberately does NOT promise you can generate
          them: `generateStrategyOptions` and `recommendStrategy` reach no HTTP route on this build, so the
          strategy screen ships no button for either and says why in its empty state. Promising generation
          here would move that lie one screen earlier. */}
      <section className="cs-card cs-rise" style={{ '--i': 4 } as React.CSSProperties} aria-labelledby="cs-strategy-t">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-strategy-t">
            Strategy
          </h2>
        </div>
        <p className="cs-refusal-detail">The strategy options generated for this company compared field by field, the advisory recommendation over them, and the decision you record.</p>
        <p className="cs-control">
          <a className="cs-btn" href={`/console/companies/${encodeURIComponent(company.companyId)}/strategy`}>
            Open the strategy
          </a>
        </p>
      </section>

      {/* ACBP-FE-014. Company-scoped like the others.

          The copy promises the roadmap and the board, and deliberately does NOT promise you can generate a
          roadmap: `generateRoadmap` reaches no HTTP route on this build. `POST /roadmap/edit` does exist, but
          it is the versioned EDIT rather than generation, and it is outside this row's scope. */}
      <section className="cs-card cs-rise" style={{ '--i': 5 } as React.CSSProperties} aria-labelledby="cs-plan-t">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-plan-t">
            Plan
          </h2>
        </div>
        <p className="cs-refusal-detail">The roadmap this company is working to — its goals and milestones — and the tasks currently on its board, including the parts of the board this version cannot yet fill.</p>
        <p className="cs-control">
          <a className="cs-btn" href={`/console/companies/${encodeURIComponent(company.companyId)}/roadmap`}>
            Open the plan
          </a>
        </p>
      </section>

      <section className="cs-card cs-rise" style={{ '--i': 6 } as React.CSSProperties} aria-labelledby="cs-lifecycle-t">        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-lifecycle-t">
            Pause and resume
          </h2>
        </div>
        <PauseControl companyId={company.companyId} control={control} />
      </section>
    </>
  );
}
