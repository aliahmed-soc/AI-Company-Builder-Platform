/*
 * ACBP-FE-006 — the company profile page.
 *
 * Same pattern as the portfolio: it calls `getCompanyForRequest` directly as a server component, so it travels
 * the identical authorization path the `/api/companies/{id}` route travels. The companyId in the URL is only a
 * SELECTOR — @acbp/core validates it against an active company membership and never trusts it on its own
 * (CDR-017 §4/§5), which is why an unguessable-looking id in the address bar grants nothing.
 *
 * The MUTATION does not follow that pattern: it goes over HTTP to the existing pause/resume routes, by owner
 * ruling, so the repository's static guards keep seeing every state-changing entry point. The reasoning is in
 * pause-control.tsx.
 */
import { getCompanyForRequest } from '@/server/companies/companies-request';
import { toCompanyPageView } from './company-view';
import { CompanyScreen } from './company-screen';

export const metadata = {
  title: 'Company — AI Company Builder',
  description: 'A single company: profile, lifecycle state, pause and resume.',
};

/*
 * Per-user, per-company data that must never be prerendered or shared between callers. The root layout forces
 * dynamic rendering app-wide today, but that is an INTERIM hold whose future is explicitly undecided
 * (CDR-083 §8 item 9), so this page states its own requirement rather than inheriting one that may be lifted.
 */
export const dynamic = 'force-dynamic';

export default async function CompanyPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;
  const result = await getCompanyForRequest(companyId);
  return <CompanyScreen view={toCompanyPageView(result)} />;
}
