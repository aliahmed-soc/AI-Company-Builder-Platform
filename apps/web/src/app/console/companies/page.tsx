/*
 * ACBP-FE-004 — the portfolio page. THE FIRST CONSOLE SCREEN THAT READS REAL DATA.
 *
 * It calls `getPortfolioForRequest` DIRECTLY rather than fetching its own `/api/companies` over HTTP. That is
 * the same function the route handler calls, so this page travels the identical path: server-verified identity
 * → internal user → the caller's own account → the membership-filtered portfolio, with the account request
 * ceiling applied at the earliest point the account id exists. Going through HTTP would add a second network
 * hop, a second rate-limit charge and a JSON round-trip to reach exactly the same result.
 *
 * NOTHING IS AUTHORIZED HERE. Authorization lives in @acbp/core and the identity resolution behind that call;
 * this file chooses no rows and hides no rows. Whatever the server refuses, the screen reports.
 *
 * The rendering is in `PortfolioScreen` and the mapping in `toPortfolioView`, both pure and unit-tested, so the
 * states a browser cannot reach without a real session are still reachable in tests.
 */
import { getPortfolioForRequest } from '@/server/companies/companies-request';
import { toPortfolioView } from './portfolio-view';
import { PortfolioScreen } from './portfolio-screen';

export const metadata = {
  title: 'Companies — AI Company Builder',
  description: 'The companies you hold an active membership in.',
};

/*
 * This page reads a per-user session and must never be prerendered or shared between users. The root layout
 * already forces dynamic rendering app-wide (an interim hold recorded in CDR-083 §8 item 9), but that hold is
 * explicitly a decision still open — so this page states its own requirement rather than depending on a line
 * whose future is undecided. If the app-wide hold is ever lifted, this screen must not silently become static.
 */
export const dynamic = 'force-dynamic';

export default async function CompaniesPage(): Promise<React.JSX.Element> {
  // No cursor or limit is passed: paging is not built in this slice, so the server's own default page is used
  // and `invalid_cursor` / `invalid_limit` are unreachable from this screen.
  const result = await getPortfolioForRequest({});
  return <PortfolioScreen view={toPortfolioView(result)} />;
}
