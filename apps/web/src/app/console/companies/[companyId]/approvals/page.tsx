/*
 * ACBP-FE-016 — the approvals inbox.
 *
 * WHAT THIS ROW ASKS FOR AND WHAT EXISTS ARE DIFFERENT THINGS, so the split is recorded here rather than
 * discovered later. The row is "Approvals inbox, payload preview, approve/reject/edit, expiry and
 * revocation". `GET /api/companies/{companyId}/approvals` is the ONLY approval endpoint in this application —
 * verified by enumerating all 37 `route.ts` files rather than by a glob, since a bracketed segment like
 * `[companyId]` is read as a character class and silently matches nothing.
 *
 *   DELIVERED — the inbox and the payload preview, plus everything the platform records for judging one:
 *               the action, the reason, the expected result, risk class, reversibility, scope, the estimated
 *               cost and the exact tool version that would run.
 *   NOT BUILT — approve / reject / edit. No route accepts a decision, so this screen ships NO control. A
 *               disabled Approve button would make the same false promise with a tooltip on it.
 *   NOT ON THE WIRE AT ALL — expiry and revocation. `ApprovalInboxItem` is an allowlist and carries no status
 *               and no timestamp of any kind, so nothing here can say whether a listed request is still
 *               live. That is stated on the screen, first, above the list.
 *
 * The refusal component is shared with nothing: like the other company-scoped reads, `listApprovalInbox`
 * answers `ok` or `forbidden`, and every other status arrives from actor resolution before the read runs.
 */
import { listApprovalInboxForRequest } from '@/server/companies/companies-request';
import { ApprovalsRefusal } from './approvals-refusal';
import { ApprovalsScreen } from './approvals-screen';
import { toApprovalsView } from './approvals-view';

export const metadata = {
  title: 'Approvals — AI Company Builder',
  description: 'The actions waiting on a human decision for this company.',
};

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;
  const result = await listApprovalInboxForRequest(companyId);

  if (result.status !== 'approvals') {
    return <ApprovalsRefusal status={result.status} retryAfterSeconds={'retryAfterSeconds' in result ? result.retryAfterSeconds : undefined} />;
  }

  return (
    <>
      <div>
        <h1 className="cs-h1">Approvals</h1>
        <p className="cs-sub">Actions the platform has prepared and will not take without a human decision. Everything recorded for judging one is shown here.</p>
      </div>
      <ApprovalsScreen view={toApprovalsView(result.approvals)} />
    </>
  );
}
