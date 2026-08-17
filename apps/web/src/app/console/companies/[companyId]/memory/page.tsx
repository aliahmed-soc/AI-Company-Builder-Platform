/*
 * ACBP-FE-010 — the transparent memory browser.
 *
 * WHAT THE ROW ASKS FOR THAT THIS SCREEN CANNOT DO, stated first because it shaped the build.
 * The row's authorization cell requires "any withheld conflicting item" to come from the server. No memory
 * route surfaces conflicts or withheld items: `MemoryItemDTO` has no such field, and MEM-004's detection
 * and withholding live in `assembleContext`, which nothing under apps/web reaches. Canon agrees this was
 * deliberate — CDR-025 lists MEM-004 under deferred, and the traceability CSV maps MEM-004 to ACBP-P2-007,
 * not to this ticket. So NO conflict or withheld indicator is rendered. Computing one client-side would be
 * the UI hiding an item on its own, which the same sentence forbids.
 *
 * TWO SERVER READS, and the second is what makes the controls honest. `getCompanyForRequest` supplies the
 * caller's ROLE; `listMemoryForRequest` supplies the items. Edit and delete are owner-only while read is
 * owner+viewer, and NO memory response reveals the role — so without the company read this screen would
 * either hide controls a founder is entitled to, or offer a viewer controls the server answers with an
 * opaque 403. The two reads cost two request-ceiling tokens; a client fetch would spend the same two.
 *
 * THE LIST IS SILENTLY CAPPED AT 100 and the route allowlist makes a cursor unreachable, so the page can
 * detect a full page but never a total. That is surfaced rather than hidden — see `describeMemory`.
 */
import { getCompanyForRequest, listMemoryForRequest } from '@/server/companies/companies-request';
import { MEMORY_LIST_DEFAULT_LIMIT } from '@acbp/core';
import { MemoryRefusal } from './memory-refusal';
import { MemoryPanel } from './memory-panel';

export const metadata = {
  title: 'Memory — AI Company Builder',
  description: 'Everything the platform has stored about this company, with its provenance, versions and controls.',
};

export const dynamic = 'force-dynamic';

export default async function MemoryPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;

  const companyResult = await getCompanyForRequest(companyId);
  if (companyResult.status !== 'company') {
    return <MemoryRefusal status={companyResult.status} retryAfterSeconds={'retryAfterSeconds' in companyResult ? companyResult.retryAfterSeconds : undefined} />;
  }
  const role = companyResult.company.role;

  // The memory read can refuse independently — a ceiling can be reached between the two calls. That does
  // NOT invalidate the page, so the shell still renders and the table region says why it is missing rather
  // than showing an empty table, which would read as "there are no memory items".
  const listResult = await listMemoryForRequest(companyId, {});
  const items = listResult.status === 'memory_list' ? listResult.items : null;
  const listRefusal = listResult.status === 'memory_list' ? null : listResult.status;
  // A full page means "there may be more" and nothing stronger: the body carries no total, no cursor and
  // no truncation flag, so this comparison is the only signal available.
  const capped = items !== null && items.length >= MEMORY_LIST_DEFAULT_LIMIT;

  return (
    <>
      <div>
        <h1 className="cs-h1">Memory</h1>
        <p className="cs-sub">
          Everything the platform has stored about this company, with where each item came from. Editing keeps the previous version rather than overwriting it, so this list is the whole record and not just its
          current state.
        </p>
      </div>
      <MemoryPanel companyId={companyId} role={role} initialItems={items} listRefusal={listRefusal} capped={capped} />
    </>
  );
}
