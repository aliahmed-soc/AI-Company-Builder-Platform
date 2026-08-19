/*
 * ACBP-FE-009 — the understanding screen. One read, one page.
 *
 * THE READ DID NOT EXIST UNTIL ACBP-API-013. This row sat as `Blocked-API` because the understanding module
 * shipped four writes and the strategy-unlock gate and nothing that returned the document. The core read was a
 * DOMAIN ADDITION the owner authorized on 2026-08-19, which is why it is worth saying here rather than leaving
 * a reader to wonder why a read this obvious arrived so late.
 *
 * AN ABSENT UNDERSTANDING IS NOT A REFUSAL. `getUnderstandingForRequest` answers `understanding` with a NULL
 * document before the interview has produced one, so the empty state renders through the ordinary screen and
 * never through `UnderstandingRefusal`.
 */
import { getUnderstandingForRequest } from '@/server/companies/companies-request';
import { UnderstandingRefusal } from './understanding-refusal';
import { UnderstandingScreen } from './understanding-screen';
import { toUnderstandingView } from './understanding-view';

export const metadata = {
  title: 'Understanding — AI Company Builder',
  description: 'What the platform understands about this company, how sure it is, and whether you have confirmed it.',
};

export const dynamic = 'force-dynamic';

export default async function UnderstandingPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;
  const result = await getUnderstandingForRequest(companyId);

  if (result.status !== 'understanding') {
    return <UnderstandingRefusal status={result.status} retryAfterSeconds={'retryAfterSeconds' in result ? result.retryAfterSeconds : undefined} />;
  }

  const view = toUnderstandingView(result.understanding.document, result.understanding.confirmed, result.understanding.superseded);

  return (
    <>
      <div>
        <h1 className="cs-h1">Understanding</h1>
        <p className="cs-sub">
          What the platform has concluded about this company from the interview, split by the kind of claim each item is and how well supported it is. Sections with nothing in them are shown too — a gap in what
          the platform understands is part of what you are checking.
        </p>
      </div>
      <UnderstandingScreen view={view} />
    </>
  );
}
