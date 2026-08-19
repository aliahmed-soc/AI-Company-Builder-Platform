/*
 * ACBP-FE-018 — what this account used, and pointedly not what it owes.
 *
 * A SERVER COMPONENT WITH NO CLIENT CODE. This screen reads. The row's own exclusion is "No payment UI: no
 * processor is integrated", and there is a second, sharper one the code imposes: `rebuildAccountUsageRollup` is
 * deliberately reachable from no API route (CDR-073 §3.2 is an open owner decision, and no `usage:rebuild`
 * authorization action exists). So there is no refresh control, no rebuild button and no payment affordance —
 * the screen NAMES those absences rather than rendering controls that could not work.
 *
 * ⚠️ THE BILLING PLACEHOLDER IS A STATEMENT, NOT A WIDGET. The row is titled "Usage display and billing
 * placeholders", and the obvious reading — a greyed-out invoice panel, a fake balance, a "manage plan" button —
 * is the one thing the read's header forbids: *"Any surface presenting these figures as an invoice would be
 * asserting something the platform does not claim."* The placeholder here says plainly that no billing exists,
 * which is true, checkable, and cannot be mistaken for a bill.
 *
 * FIGURES CARRY UNITS IN TEXT and the layout stacks (the row's accessibility and responsive lines). The card grid
 * is `cs-stats`/`cs-stat`, reused from the overview rather than reinvented — but WITHOUT the animated `Counter`,
 * because a real money figure counting up from zero is decoration applied to a number that should be read.
 */
import type { UsageView } from './usage-view';

export function UsageScreen({ view }: { view: UsageView }): React.JSX.Element {
  return (
    <div className="cs-usage" data-state={view.state}>
      <section className="cs-card cs-usage-head">
        <div className="cs-usage-head-row">
          <h2 className="cs-h2">{view.periodLabel}</h2>
          <span className={`cs-badge cs-badge--${view.state}`} data-state={view.state}>
            {view.state === 'computed' ? (view.isMeasuredZero ? 'Measured — zero' : 'Measured') : 'Not computed'}
          </span>
        </div>
        <p className="cs-usage-headline">{view.headline}</p>
        <p className="cs-sub">{view.note}</p>
        <p className="cs-meta">{view.computedAtLabel}</p>
      </section>

      {view.figures.length > 0 && (
        <section className="cs-stats" aria-label={`Usage figures for ${view.periodLabel}`}>
          {view.figures.map((f) => (
            <article key={f.key} className="cs-stat cs-usage-stat" data-figure={f.key}>
              <div className="cs-stat-top">
                <span className="cs-stat-label">{f.label}</span>
              </div>
              {/* The VALUE carries its own unit. Nothing here depends on the label to be understood. */}
              <div className="cs-stat-value cs-usage-value">{f.value}</div>
              <div className="cs-stat-foot">{f.note}</div>
            </article>
          ))}
        </section>
      )}

      <section className="cs-card cs-usage-note" role="note">
        <h3 className="cs-h3">What these figures are</h3>
        <p className="cs-sub">
          A reporting projection, computed by the platform across every company in this account. The authoritative
          record of model spend is the credit ledger; where the two disagree, the ledger is right and this
          projection is the thing at fault. Nothing on this platform decides a limit or an entitlement from what
          you see here.
        </p>
        <p className="cs-sub">
          The projection is rebuilt by the platform, not on request — this console cannot trigger a recomputation,
          because no route exposes one. If a figure looks stale, the timestamp above says when it was last built.
        </p>
      </section>

      <section className="cs-card cs-usage-billing" role="note">
        <h3 className="cs-h3">Billing</h3>
        {/*
         * THE PLACEHOLDER, AND IT IS DELIBERATELY PROSE. A disabled "Manage plan" button or a greyed balance card
         * would imply a billing system exists and is merely switched off. None exists: no payment processor is
         * integrated, and there is no plan, price or balance anywhere in this platform to show.
         */}
        <p className="cs-sub">
          There is no billing on this platform yet. No payment processor is integrated, no plan or price exists,
          and no balance is held — so there is nothing to charge, nothing to pay and nothing to manage from here.
          The estimated cost above is the platform&rsquo;s own arithmetic against a provider&rsquo;s published
          list price, shown so that usage has a sense of scale.
        </p>
        <p className="cs-meta">When billing is built, it will appear here. Until then this section stays a statement rather than a control, because a control would not do anything.</p>
      </section>
    </div>
  );
}
