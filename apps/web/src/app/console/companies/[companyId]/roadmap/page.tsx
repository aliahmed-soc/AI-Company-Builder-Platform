/*
 * ACBP-FE-014 — the plan screen. Two reads, one page.
 *
 * THE ROADMAP AND THE BOARD ARE SEPARATE READS THAT CAN DISAGREE, and this page does not pretend otherwise.
 * They go through the same membership check today, so in practice they refuse together — but "in practice"
 * is not an enforcer, and building a page that would silently show an empty board if the board read alone
 * were refused is exactly the shape of lie this console spends its length removing. So:
 *
 *   roadmap refused → the whole page is a refusal. Without the plan there is nothing to frame the board with.
 *   board refused, roadmap fine → the roadmap renders and the board section says it was REFUSED, not empty.
 *
 * NEITHER ABSENCE IS AN ERROR. The roadmap read carries null on success and the board read is not nullable at
 * all ("AN EMPTY BOARD IS STILL A BOARD" — the route's own header), so a company that has planned nothing
 * gets an ordinary empty screen rather than a 404.
 *
 * WHAT THIS SCREEN CANNOT DO: `generateRoadmap` reaches no HTTP route — verified by enumerating all 36
 * `route.ts` files, not by a glob, since a bracketed segment like `[companyId]` is read as a character class
 * and silently matches nothing. So there is no "generate the roadmap" button. `POST /roadmap/edit` DOES
 * exist, but it is the versioned edit rather than generation and is out of this row's scope; shipping a
 * half-wired editor would be worse than shipping none.
 */
import { getRoadmapForRequest, getTaskBoardForRequest } from '@/server/companies/companies-request';
import { RoadmapRefusal } from './roadmap-refusal';
import { RoadmapScreen } from './roadmap-screen';
import { toRoadmapView } from './roadmap-view';
import { toBoardView } from './board-view';

export const metadata = {
  title: 'Plan — AI Company Builder',
  description: 'The roadmap planned for this company and the tasks on its board.',
};

export const dynamic = 'force-dynamic';

export default async function RoadmapPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;
  // Both reads are issued together: they are independent, and awaiting them in sequence would double the
  // latency of a page that needs both to be complete.
  const [roadmapResult, boardResult] = await Promise.all([getRoadmapForRequest(companyId), getTaskBoardForRequest(companyId)]);

  if (roadmapResult.status !== 'roadmap') {
    return <RoadmapRefusal status={roadmapResult.status} retryAfterSeconds={'retryAfterSeconds' in roadmapResult ? roadmapResult.retryAfterSeconds : undefined} />;
  }

  const board = boardResult.status === 'tasks' ? toBoardView(boardResult.board) : null;
  const boardRefusalStatus = boardResult.status === 'tasks' ? null : boardResult.status;

  return (
    <>
      <div>
        <h1 className="cs-h1">Plan</h1>
        <p className="cs-sub">
          The roadmap this company is working to, and the tasks currently on its board. A part of the board that shows no number is one this version of the platform cannot fill — that is not the same as it being
          empty, and this page never guesses which.
        </p>
      </div>
      <RoadmapScreen roadmap={toRoadmapView(roadmapResult.roadmap)} board={board} boardRefusalStatus={boardRefusalStatus} companyId={companyId} />
    </>
  );
}
