/*
 * ACBP-FE-016 — the approvals inbox screen.
 *
 * A SERVER COMPONENT WITH NO DECISION CONTROLS. `decideApproval` and `revokeApproval` are exported from
 * `@acbp/core` and no route reaches either, so the capability exists and is unreachable over HTTP. This
 * screen therefore renders everything an approver needs to JUDGE and ships no button — a disabled Approve
 * would be the same false promise with a tooltip on it.
 *
 * WHAT THIS SCREEN SAYS ABOUT ITS OWN LIMITS IS NOW CHECKED AGAINST THE SERVER, which the first version was
 * not. It led with a warning that a listed request might already be decided or revoked; `listPending` filters
 * `status = 'pending'` and a CHECK constraint guarantees such a row has no `decided_at`, `revoked_at`,
 * `superseded_at` or `consumed_at`. Everything listed IS live, and the page now says that instead.
 *
 * THE RISK CLASS IS THE CONTRACT'S, and its four values are rendered as four visibly different things. The
 * first version invented `low`/`medium`/`high`/`critical`, so every real row — including
 * `sensitive_irreversible` — rendered as a single indistinguishable "unknown".
 */
import type { ApprovalRowView, ApprovalsView } from './approvals-view';

export function ApprovalsScreen({ view }: { view: ApprovalsView }): React.JSX.Element {
  return (
    <>
      <section className="cs-card" aria-labelledby="cs-ap-scope-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-ap-scope-h">
            What this page is
          </h2>
        </div>
        <p className="cs-help">{view.livenessNote}</p>
        <p className="cs-help">{view.orderNote}</p>
        <p className="cs-help">
          Deciding on an approval is not possible from this console: the capability exists in the platform but no HTTP route reaches it, so rather than show an Approve button that would do nothing, there is none.
          Everything the platform records for the decision is below, so it can be judged here and acted on wherever approvals are actually processed.
        </p>
        {/* CONDITIONAL, because it is only true when the page came back full. */}
        {view.truncationNote === null ? null : (
          <p className="cs-control-outcome cs-control-outcome--unexpected" role="note">
            {view.truncationNote}
          </p>
        )}
      </section>

      {view.isEmpty ? (
        <section className="cs-card" aria-labelledby="cs-ap-empty-h">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-ap-empty-h">
              Inbox
            </h2>
          </div>
          <p className="cs-empty">{view.emptyNote}</p>
        </section>
      ) : (
        <section className="cs-card" aria-labelledby="cs-ap-h">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-ap-h">
              Waiting on you
            </h2>
            <span className="cs-badge cs-badge--muted">
              {String(view.items.length)}
              {view.possiblyTruncated ? '+' : ''} waiting
            </span>
            {view.irreversibleCount > 0 ? <span className="cs-badge cs-badge--danger">{String(view.irreversibleCount)} irreversible</span> : null}
            {view.expiredCount > 0 ? <span className="cs-badge cs-badge--warning">{String(view.expiredCount)} expired</span> : null}
          </div>
          <p className="cs-help">
            {String(view.totalEstimatedCredits)} credits estimated across everything listed. {view.costNote}
          </p>
          <ul className="cs-list cs-ap-list">
            {view.items.map((row) => (
              <ApprovalCard key={row.approvalRequestId} row={row} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ApprovalCard({ row }: { row: ApprovalRowView }): React.JSX.Element {
  const headingId = `cs-ap-${row.approvalRequestId}`;
  return (
    <li className="cs-ap-item" data-risk={row.riskClass} data-expiry={row.expiry} aria-labelledby={headingId}>
      <div className="cs-ap-item-h">
        <h3 className="cs-item-title" id={headingId}>
          {row.action}
        </h3>
        {/* The contract's class, not an invented severity. The tint reinforces the WORD; it never carries the
            meaning on its own, and the four classes are four visibly distinct states. */}
        <span className={`cs-badge cs-ap-risk cs-ap-risk--${row.riskClass}`}>{row.riskLabel}</span>
        {row.irreversible ? <span className="cs-badge cs-badge--danger">irreversible</span> : null}
        <span className="cs-badge cs-badge--muted">{row.scopeLabel}</span>
      </div>

      {row.expiryNote === '' ? null : (
        <p className={`cs-ap-expiry cs-ap-expiry--${row.expiry}`} role="note">
          {row.expiryNote}
        </p>
      )}

      <dl className="cs-co-meta cs-co-meta--wide">
        <div>
          <dt>Why it was asked for</dt>
          <dd>{row.reason}</dd>
        </div>
        <div>
          <dt>What it would produce</dt>
          <dd>{row.expectedResult}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{row.expiresAt}</dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd>{String(row.estimatedCostCredits)} credits</dd>
        </div>
        <div>
          <dt>Tool that would run</dt>
          <dd>{row.toolLabel}</dd>
        </div>
      </dl>

      {row.hasPreview ? (
        <>
          <h4 className="cs-label">Payload preview</h4>
          {/* PRE, because it is the server's own rendering and whitespace may be load-bearing. `role="group"`
              rather than `region`: a region is a LANDMARK, and fifty approvals would produce fifty landmarks
              in the document outline. It is focusable so a keyboard can reach the scroll. */}
          <pre className="cs-ap-preview" tabIndex={0} role="group" aria-label={`Payload preview for ${row.action}. Scrollable.`}>
            {row.preview}
          </pre>
        </>
      ) : (
        <p className="cs-help">The server recorded no payload preview for this request, so there is nothing to show — that is an absence in the record, not an empty payload.</p>
      )}
    </li>
  );
}
