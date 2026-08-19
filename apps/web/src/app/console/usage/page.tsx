/*
 * ACBP-FE-018 — the usage screen. One read, one page.
 *
 * ACCOUNT-SCOPED, NOT COMPANY-SCOPED, and that is why it is the third entry in the global sidebar rather than a
 * card on a company page. A rollup spans every company in the account by design; putting it under
 * `/console/companies/{id}/…` would have implied the figures were that company's, which they are not.
 *
 * NO PERIOD SELECTOR. `getAccountUsageForRequest` takes `periodStart` and this page passes nothing, so the server
 * chooses — its default is the current period. A selector would need a list of periods the platform can report
 * on, and no route exposes one; offering a free-text month box instead would mostly produce `invalid_period`.
 * The period actually served is echoed back and displayed, so a founder always knows which month they are
 * reading rather than inferring it.
 *
 * AN UNCOMPUTED PERIOD IS NOT A REFUSAL. `not_computed` is a success (the G9 rule) and renders through the
 * ordinary screen as its own state, never through `UsageRefusal`.
 */
import { getAccountUsageForRequest } from '@/server/accounts/usage-request';
import { UsageRefusal } from './usage-refusal';
import { UsageScreen } from './usage-screen';
import { toUsageView } from './usage-view';

export const metadata = {
  title: 'Usage — AI Company Builder',
  description: 'What this account used in the current period, and why those figures are not a bill.',
};

export const dynamic = 'force-dynamic';

export default async function UsagePage(): Promise<React.JSX.Element> {
  const result = await getAccountUsageForRequest(undefined);

  if (result.status !== 'ok' && result.status !== 'not_computed') {
    return <UsageRefusal status={result.status} retryAfterSeconds={'retryAfterSeconds' in result ? result.retryAfterSeconds : undefined} />;
  }

  const view = result.status === 'ok' ? toUsageView(result.usage) : toUsageView(null, result.periodStart);

  return (
    <>
      <div>
        <h1 className="cs-h1">Usage</h1>
        <p className="cs-sub">
          What this account used in the current period, across every company in it. These are reporting figures — a
          record of what the platform did on your behalf, not a statement of anything owed.
        </p>
      </div>
      <UsageScreen view={view} />
    </>
  );
}
