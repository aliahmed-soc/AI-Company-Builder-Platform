/*
 * ACBP-FE-005 — the provisioning progress screen.
 *
 * The FIRST read follows the console's server-component precedent: it calls `getProvisioningForRequest`
 * directly, travelling the identical authorization path the `/api/companies/{id}/provisioning` route travels.
 * The companyId in the URL is only a SELECTOR — @acbp/core validates it against an active company membership
 * (CDR-017 §4/§5) — so an unguessable-looking id in the address bar grants nothing.
 *
 * The LIVE half (polling and resume) is a client component, because both need to run after first paint. It
 * receives this first read as its starting state so the page is already truthful before any fetch happens,
 * rather than flashing an empty stepper it will immediately replace.
 *
 * WHY A SEPARATE SCREEN AT ALL, when the create POST already ran provisioning inline: because the run can be
 * advanced by another request — a second tab, an operator — and because a stalled run needs somewhere to be
 * resumed from. It is a state screen, not a progress animation.
 */
import { getProvisioningForRequest } from '@/server/companies/companies-request';
import { toProvisioningView } from './provisioning-view';
import { ProvisioningRefusal } from './provisioning-refusal';
import { ProvisioningProgress } from './provisioning-progress';

export const metadata = {
  title: 'Setting up — AI Company Builder',
  description: 'Provisioning progress for a company, with resume when a run has stopped.',
};

export const dynamic = 'force-dynamic';

export default async function ProvisioningPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;
  const result = await getProvisioningForRequest(companyId);

  // Anything that is not the provisioning payload is a refusal, and each gets its own words — the same rule
  // the portfolio follows. Rendering an empty stepper for a forbidden read would tell a founder their setup
  // had no steps rather than that they were not permitted to see it.
  if (result.status !== 'provisioning') {
    return <ProvisioningRefusal status={result.status} retryAfterSeconds={'retryAfterSeconds' in result ? result.retryAfterSeconds : undefined} />;
  }

  const view = toProvisioningView(result.provisioning);

  return (
    <>
      <div>
        <h1 className="cs-h1">Setting up</h1>
        <p className="cs-sub">
          {view.kind === 'complete'
            ? 'All six setup steps are complete.'
            : view.kind === 'exhausted'
              ? 'Setup stopped before it finished, and the server will not retry the step that stopped it.'
              : view.kind === 'inconsistent'
                ? 'The setup record for this company cannot be read consistently.'
                : 'Setup has not finished. You can ask the server to continue it.'}
        </p>
      </div>

      <section className="cs-card" aria-labelledby="cs-prov-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-prov-h">
            Setup steps
          </h2>
          {/* The company's own lifecycle word, verbatim — this screen does not own that vocabulary. */}
          <span className="cs-badge cs-badge--muted">{view.companyStatus}</span>
        </div>
        <ProvisioningProgress companyId={companyId} initial={result.provisioning} />
      </section>
    </>
  );
}
