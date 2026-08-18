/*
 * ACBP-FE-004 — the portfolio screen. A PURE component over `PortfolioView`: given a view it renders, and it
 * fetches nothing. That split is what makes every state — including the five refusals a browser cannot reach
 * without a real session — renderable and reviewable rather than theoretical.
 *
 * THE CARDS NOW LINK, because the destination exists. Selection is URL-only and non-authoritative by design
 * (CDR-017 §4/§5): the companyId in the href is only a SELECTOR, and @acbp/core re-validates it against an
 * active company membership on the next request — following one of these links grants nothing by itself.
 *
 * They did not link when this file shipped: ACBP-FE-006 did not exist, and the console's rule is that a link
 * to a page which does not exist looks finished and is worse than none. FE-006 built it, so the deferral is
 * closed here rather than left as a permanent apology in the copy.
 */
import type { PortfolioView, PortfolioCard } from './portfolio-view';

/** ISO-8601 is already ordered year-month-day; slicing avoids Date parsing and any timezone shift. */
function isoDay(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function Card({ card, index }: { card: PortfolioCard; index: number }): React.JSX.Element {
  return (
    <a className="cs-co" href={`/console/companies/${encodeURIComponent(card.companyId)}`} style={{ '--i': index } as React.CSSProperties}>
      <div className="cs-co-top">
        <h3 className="cs-co-name">{card.name}</h3>
        {/* The server's own status word. The tone is styling; it never replaces the term. */}
        <span className={`cs-badge cs-status cs-status--${card.statusTone}`}>{card.status}</span>
      </div>
      <dl className="cs-co-meta">
        <div>
          <dt>Your role</dt>
          <dd>{card.role}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={card.createdAt}>{isoDay(card.createdAt)}</time>
          </dd>
        </div>
      </dl>
      <p className="cs-co-id" title={card.companyId}>
        {card.companyId}
      </p>
    </a>
  );
}

function Refusal({ view }: { view: Extract<PortfolioView, { kind: 'refusal' }> }): React.JSX.Element {
  const { refusal } = view;
  return (
    <section className={`cs-card cs-refusal cs-refusal--${refusal.code}`} role="alert" aria-labelledby="cs-refusal-t">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-refusal-t">
          {refusal.title}
        </h2>
        <span className="cs-spacer" />
        {/* The machine-readable code, shown so a founder reporting a problem can quote it. */}
        <span className="cs-badge cs-badge--muted">{refusal.code}</span>
      </div>
      <p className="cs-refusal-detail">{refusal.detail}</p>
      {refusal.retryAfterSeconds !== undefined ? (
        <p className="cs-refusal-meta">
          Server-supplied wait: <strong>{refusal.retryAfterSeconds}</strong> seconds. This is the value the
          server returned, not an estimate.
        </p>
      ) : null}
    </section>
  );
}

function Empty(): React.JSX.Element {
  return (
    <section className="cs-card cs-empty" aria-labelledby="cs-empty-t">
      <h2 className="cs-card-t" id="cs-empty-t">
        No companies yet
      </h2>
      <p className="cs-refusal-detail">
        You are not a member of any company. This is the read succeeding and returning nothing — not something
        being withheld from you.
      </p>
      {/*
        LIVE AS OF ACBP-FE-005, and this replaced a disabled button that said so. It stayed disabled for
        exactly as long as the claim "not built yet" was true; the destination now exists, so the control is a
        real link rather than a promise. An anchor, not a button: this navigates, and the form on the other
        side does the mutating.
      */}
      <a className="cs-btn cs-btn--primary" href="/console/companies/new">
        Create a company
      </a>
    </section>
  );
}

export function PortfolioScreen({ view }: { view: PortfolioView }): React.JSX.Element {
  return (
    <>
      <div>
        <h1 className="cs-h1">Companies</h1>
        {/*
          PRECISE ABOUT WHAT IS REAL, because this screen shares a viewport with mock shell furniture. The list
          below is a live read. The company name and plan in the top bar are still placeholder data from the
          ACBP-FE-002 shell, and claiming "no mock data on this screen" would be false while they are on it.
        */}
        <p className="cs-sub">
          Every company you hold an active membership in, read live from the portfolio API. The company shown in
          the top bar above is still placeholder shell data and is not part of this read.
        </p>
      </div>

      {view.kind === 'refusal' ? <Refusal view={view} /> : null}
      {view.kind === 'empty' ? <Empty /> : null}
      {view.kind === 'companies' ? (
        <>
          <section className="cs-portfolio" aria-label="Companies">
            {view.items.map((card, i) => (
              <Card key={card.companyId} card={card} index={i} />
            ))}
          </section>
          <p className="cs-co-id">
            {view.hasMore
              ? 'The server reported more companies than shown. Paging is not built yet, so this is the first page only.'
              : 'This is every company you belong to.'}
          </p>
        </>
      ) : null}
    </>
  );
}
