/*
 * ACBP-FE-016 — the approvals inbox screen.
 *
 * A SERVER COMPONENT WITH NO CONTROLS, and the absence of controls is the deliverable half of the honesty
 * here. The row asks for "approve/reject/edit" and there is no route for any of them: `GET /approvals` is the
 * only approval endpoint in the application. So this screen renders what an approver needs in order to JUDGE
 * — the action, why it was asked for, what it would produce, the payload preview, the risk class, the
 * reversibility, the scope, the estimated cost and the exact tool version that would run — and ships no
 * button at all. A disabled Approve button would be the same claim with a tooltip.
 *
 * IT ALSO SAYS WHAT IT CANNOT KNOW, at the top, before the list. The read carries no status and no timestamp,
 * so a decided or revoked request is indistinguishable from a live one. An inbox that looked authoritative
 * while omitting that is the exact failure this console exists to avoid.
 */
import type { ApprovalRowView, ApprovalsView } from './approvals-view';

export function ApprovalsScreen({ view }: { view: ApprovalsView }): React.JSX.Element {
  return (
    <>
      <section className="cs-card" aria-labelledby="cs-ap-limits-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-ap-limits-h">
            What this page can and cannot tell you
          </h2>
        </div>
        {/* FIRST, NOT IN A FOOTNOTE. Both sentences are about the READ, so they are true of an empty inbox
            too and are rendered unconditionally. */}
        <p className="cs-control-outcome cs-control-outcome--unexpected" role="note">
          {view.unknowableNote}
        </p>
        <p className="cs-help">
          Deciding on an approval is not possible from this console yet: the only approval endpoint that exists is the read behind this page. Rather than show an Approve button that would do nothing, there is none —
          the detail below is everything the platform records for the decision, so it can be judged here and acted on wherever approvals are actually processed.
        </p>
        <p className="cs-help">{view.orderNote}</p>
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
            <span className="cs-badge cs-badge--muted">{String(view.items.length)} waiting</span>
            {view.irreversibleCount > 0 ? <span className="cs-badge cs-badge--danger">{String(view.irreversibleCount)} irreversible</span> : null}
            {/* Its own badge, never folded into the irreversible count — an entry whose reversibility this
                screen does not recognise is not evidence that it is safe. */}
            {view.unknownReversibilityCount > 0 ? <span className="cs-badge cs-badge--warning">{String(view.unknownReversibilityCount)} unclear</span> : null}
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
    <li className="cs-ap-item" data-risk={row.risk.tone} aria-labelledby={headingId}>
      <div className="cs-ap-item-h">
        <h3 className="cs-item-title" id={headingId}>
          {row.action}
        </h3>
        {/* The tone is advisory; the RAW WORD is what is displayed, because the column is free text and a
            value this screen has never seen must not be rendered as a severity it cannot know. */}
        <span className={`cs-badge cs-ap-risk cs-ap-risk--${row.risk.tone}`}>risk: {row.risk.label}</span>
        <span className="cs-badge cs-badge--muted">scope: {row.scope}</span>
      </div>

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
          <dt>Reversibility</dt>
          <dd>
            {row.reversibility}
            {row.irreversible === null ? ' — this page does not recognise that value, so it does not treat it as reversible' : ''}
          </dd>
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
          {/* PRE, because it is the server's own rendering and whitespace may be load-bearing. Scrolls in its
              own box so a long payload never makes the page scroll sideways. */}
          <pre className="cs-ap-preview" tabIndex={0} role="region" aria-label={`Payload preview for ${row.action}. Scrollable.`}>
            {row.preview}
          </pre>
        </>
      ) : (
        <p className="cs-help">The server recorded no payload preview for this request, so there is nothing to show here — that is an absence in the record, not an empty payload.</p>
      )}
    </li>
  );
}
