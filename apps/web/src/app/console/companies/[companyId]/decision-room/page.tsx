/*
 * ACBP-FE-012 — the Decision Room.
 *
 * Ten queues of things waiting on a founder, with a live-ish update channel. The first read happens here so
 * the page is already truthful before any connection is attempted; the channel only ever tells the screen
 * that something MOVED, never what it moved to.
 *
 * THE CHANNEL IS NOT PUSH, AND THIS SCREEN NEVER SAYS IT IS. Every server message carries
 * `deliveryMode: 'poll_backed'` because there is no outbox and no LISTEN/NOTIFY behind it — the contract
 * promises only that a change is learned within one interval. "Live" and "real-time" are therefore absent
 * from the copy on purpose.
 *
 * NO INLINE DECISION ACTIONS. The row excludes them until FE-013's APIs exist, and they do not: the routes
 * that would act on a queue item are the ones FE-013 is blocked on. Every queue here is read-only, and a
 * button that could not act would be exactly the control this console refuses to ship.
 */
import { getDecisionRoomForRequest } from '@/server/companies/companies-request';
import { DecisionRoomRefusal } from './decision-room-refusal';
import { DecisionRoomPanel } from './decision-room-panel';

export const metadata = {
  title: 'Decision Room — AI Company Builder',
  description: 'The queues waiting on a decision for this company.',
};

export const dynamic = 'force-dynamic';

export default async function DecisionRoomPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;
  const result = await getDecisionRoomForRequest(companyId);

  if (result.status !== 'decision_room') {
    return <DecisionRoomRefusal status={result.status} retryAfterSeconds={'retryAfterSeconds' in result ? result.retryAfterSeconds : undefined} />;
  }

  return (
    <>
      <div>
        <h1 className="cs-h1">Decision Room</h1>
        <p className="cs-sub">
          Everything waiting on you, grouped by queue. A queue that shows no number is one the server did not report on — that is not the same as it being empty, and this page never guesses which.
        </p>
      </div>
      <DecisionRoomPanel companyId={companyId} initialRoom={result.room} />
    </>
  );
}
