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

      <section className="cs-card cs-rise" style={{ '--i': 1 } as React.CSSProperties} aria-labelledby="cs-lifecycle-t">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-lifecycle-t">
            Pause and resume
          </h2>
        </div>
        <PauseControl companyId={company.companyId} control={control} />
      </section>
    </>
  );
}
