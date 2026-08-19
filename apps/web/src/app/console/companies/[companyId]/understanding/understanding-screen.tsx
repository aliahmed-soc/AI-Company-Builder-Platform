/*
 * ACBP-FE-009 — the understanding document: what the platform believes about this company, and how sure it is.
 *
 * A SERVER COMPONENT WITH NO CLIENT CODE. This screen READS. The five per-item review controls (approve, edit,
 * reject, request evidence, request research) and the owner-only confirm are WRITES that the console does not
 * yet route — `recordUnderstandingReview`, `confirmUnderstanding` and `correctUnderstanding` exist in
 * `@acbp/core` and no HTTP route reaches them. The row's accessibility line asks that "edit, reject and
 * request-evidence controls have accessible names"; a control that cannot reach the server has no accessible
 * name to give, so this screen NAMES THE GAP instead of rendering buttons that would do nothing. Shipping
 * inert controls to satisfy the wording would be the lie the sentence exists to prevent.
 *
 * CONFIDENCE IS NEVER COLOUR ALONE. Every confidence appears as a percentage and a sentence; the bar is
 * decorative and marked `aria-hidden`, so nothing is carried by the palette that is not also carried by text.
 *
 * DOCUMENT WIDTH IS CAPPED FOR READING (`cs-doc`), per the row's responsive line.
 */
import type { UnderstandingView, SectionView } from './understanding-view';

/** The lifecycle badge. Text first — the class only tints what the words already say. */
function StateBadge({ view }: { view: UnderstandingView }): React.JSX.Element {
  const label =
    view.state === 'confirmed' ? 'Confirmed' : view.state === 'superseded' ? 'Corrected — needs a new version' : view.state === 'awaiting_confirmation' ? 'Awaiting your confirmation' : 'Not generated yet';
  return (
    <span className={`cs-badge cs-badge--${view.state}`} data-state={view.state}>
      {label}
    </span>
  );
}

function Section({ section }: { section: SectionView }): React.JSX.Element {
  return (
    <section className="cs-card cs-understanding-section" data-class={section.class} data-gap={section.isGap ? 'true' : 'false'}>
      <header className="cs-understanding-section-head">
        <h3 className="cs-h3">{section.label}</h3>
        <p className="cs-meta">
          {/* The count and the status as WORDS. `data-status` is for styling only. */}
          <span data-status={section.status}>
            {String(section.count)} {section.count === 1 ? 'item' : 'items'} · {section.status === 'present' ? 'well supported' : section.status === 'assumed' ? 'assumed' : 'nothing established'}
          </span>
        </p>
      </header>
      <p className="cs-confidence-label">{section.confidenceLabel}</p>

      {section.isGap ? (
        <p className="cs-empty">
          The interview has not established anything in this section yet. It is shown because a gap in what the platform understands is part of what you are checking.
        </p>
      ) : (
        <ul className="cs-understanding-items">
          {section.items.map((item, index) => (
            <li key={`${section.class}-${String(index)}`} className="cs-understanding-item">
              <p className="cs-understanding-item-content">{item.content}</p>
              {/* The number and its meaning are both text. The bar repeats them; it never replaces them. */}
              <p className="cs-confidence-label">{item.confidenceLabel}</p>
              <div className="cs-confidence-bar" aria-hidden="true">
                <div className="cs-confidence-bar-fill" style={{ width: `${String(item.confidencePercent)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function UnderstandingScreen({ view }: { view: UnderstandingView }): React.JSX.Element {
  if (view.state === 'none') {
    return (
      <section className="cs-card cs-doc" data-state="none">
        <p className="cs-empty-title">{view.headline}</p>
        <p className="cs-empty">{view.statusNote}</p>
      </section>
    );
  }

  return (
    <div className="cs-doc" data-state={view.state}>
      <section className="cs-card cs-understanding-head">
        <div className="cs-understanding-head-row">
          <h2 className="cs-h2">{view.headline}</h2>
          <StateBadge view={view} />
        </div>
        <p className="cs-sub">{view.statusNote}</p>
        <p className="cs-confidence-label">{view.overallConfidenceLabel}</p>
        <p className="cs-meta">
          Version {String(view.version)}
          {view.createdAt === null ? '' : ` · generated ${view.createdAt}`}
        </p>

        {view.unclassifiedItemCount > 0 && (
          /*
           * NOT DECORATION. The DTO types an item's class as `string`, and the view counts anything outside the
           * closed set rather than inventing a section for it. Saying so is the difference between a document
           * that is short and a document that is short AND does not admit it.
           */
          <p className="cs-warning" role="note">
            {String(view.unclassifiedItemCount)} {view.unclassifiedItemCount === 1 ? 'item was' : 'items were'} returned with a category this screen does not recognise, so {view.unclassifiedItemCount === 1 ? 'it is' : 'they are'} not shown
            below. The count is reported rather than dropped so the document does not appear shorter than it is.
          </p>
        )}
      </section>

      {view.sections.map((section) => (
        <Section key={section.class} section={section} />
      ))}

      <section className="cs-card cs-understanding-actions" role="note">
        <h3 className="cs-h3">Reviewing and confirming</h3>
        {view.canConfirm ? (
          <p className="cs-empty">
            Planning stays blocked until this understanding is confirmed. Confirming is owner-only and is not yet reachable from this console — the platform records the decision, but no HTTP route exposes it, so no
            control is offered here rather than a button that would do nothing.
          </p>
        ) : view.state === 'superseded' ? (
          <p className="cs-empty">
            Your correction superseded the confirmation on this version, so planning is blocked until a new version is generated and confirmed. Neither generating nor confirming is reachable from this console yet.
          </p>
        ) : (
          <p className="cs-empty">This understanding is confirmed, so planning can proceed from it. Correcting it later is recorded by the platform but is not yet reachable from this console.</p>
        )}
        <p className="cs-meta">
          The five per-item controls this screen will carry — approve, edit, reject, request evidence, request research — exist in the platform and have no HTTP route. They appear here when that route lands.
        </p>
      </section>
    </div>
  );
}
