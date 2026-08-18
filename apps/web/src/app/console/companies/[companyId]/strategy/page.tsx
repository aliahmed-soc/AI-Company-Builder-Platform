/*
 * ACBP-FE-013 — the strategy screen.
 *
 * The company's latest generation, its options side by side, the advisory recommendation, and the owner's
 * decision. The first read happens here so the page is truthful before any client code runs.
 *
 * WHAT THIS SCREEN CANNOT DO, STATED HERE RATHER THAN DISCOVERED LATER: there is no HTTP route for
 * `generateStrategyOptions` or for `recommendStrategy`. Both use cases exist in `@acbp/core` and are reachable
 * from no route file — verified by enumerating all 36 `route.ts` files rather than by a glob, since a
 * bracketed segment like `[companyId]` is read as a character class and silently matches nothing. So this
 * screen ships NO "generate options" button and NO "ask for a recommendation" button. A control that cannot
 * act is the thing this console refuses to ship, and a permanently disabled one is the same lie with a
 * tooltip. The empty state says so in words instead.
 *
 * THE DECISION CONTROLS ARE RENDERED FOR EVERYONE AND AUTHORIZED BY THE SERVER. Recording a decision is
 * owner-only (`strategy:select`, `decision:record`), and this page is not told the caller's role — the read
 * returns the generation, not a permission set. Hiding the form on a guess would be a browser-side
 * authorization decision, which this platform does not do; the server refuses and the refusal is rendered
 * honestly. That is deliberate, not an oversight.
 */
import { getStrategyForRequest } from '@/server/companies/companies-request';
import { StrategyRefusal } from './strategy-refusal';
import { StrategyPanel } from './strategy-panel';

export const metadata = {
  title: 'Strategy — AI Company Builder',
  description: 'The strategy options generated for this company, and the decision recorded over them.',
};

export const dynamic = 'force-dynamic';

export default async function StrategyPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;
  const result = await getStrategyForRequest(companyId);

  if (result.status !== 'strategy') {
    return <StrategyRefusal status={result.status} retryAfterSeconds={'retryAfterSeconds' in result ? result.retryAfterSeconds : undefined} />;
  }

  return (
    <>
      <div>
        <h1 className="cs-h1">Strategy</h1>
        <p className="cs-sub">
          The options generated for this company, compared field by field. Nothing here selects anything on your behalf — the recommendation is advisory, and the decision below is yours.
        </p>
      </div>
      {/* `generation` may be null, and that is a SUCCESS: the company exists, you may read it, and nothing has
          been generated yet. The panel renders it as the ordinary first-visit empty state. */}
      <StrategyPanel companyId={companyId} initialGeneration={result.generation} />
    </>
  );
}
