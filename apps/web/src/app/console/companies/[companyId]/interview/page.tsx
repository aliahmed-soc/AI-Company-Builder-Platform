/*
 * ACBP-FE-007 — the interview session screen.
 *
 * WHAT THIS SCREEN CANNOT DO, STATED FIRST, BECAUSE IT SHAPED EVERYTHING ELSE.
 * No HTTP route in this repository can cause an interview question to exist. The five interview routes are
 * the session read, the session start, the qa read, the answer write, and suspend/resume — verified by
 * enumerating all 37 route files, not by a glob (a bracket path segment is read as a character class and
 * silently matches nothing). `generateAdaptiveBatch`, `evaluateAnswer` and `suggestAssumptionForSkip` exist
 * as core use cases with ZERO references anywhere under apps/web; INTERVIEW.md:141-143 records the
 * orchestration routes as deliberately deferred behind the live-provider owner gate.
 *
 * So a founder who starts an interview here sees a real session and an empty question list, and nothing on
 * this page can change that. The consequences are all absences, and each is deliberate:
 *   - NO "get next questions" or "next batch" control — it would be a control that cannot act.
 *   - NO "finish interview" control — nothing in the repository writes `ready_for_review`, so there is no
 *     completion for it to reach.
 *   - NO batch chrome and NO "question 3 of 12" — the wire carries no batch id, no batch size and no total.
 *   - The empty state says there are no questions YET. It never says the interview is finished; those are
 *     different facts and this build only ever produces the first one.
 *
 * TWO SERVER READS, AND THE USUAL OBJECTION DOES NOT APPLY. `GET /interview` and `GET /interview/qa` share
 * only `sessionId`; neither is derivable from the other. Each `*ForRequest` call spends one per-account
 * request-ceiling token, so this page costs two — but moving the qa read to the client would spend exactly
 * the same two, because a client fetch travels the same route and the same resolver. Given the cost is
 * identical either way, both reads happen here, so the page is already truthful on first paint rather than
 * flashing a question list it is about to replace.
 */
import { getInterviewForRequest, getQaForRequest } from '@/server/companies/companies-request';
import { InterviewRefusal } from './interview-refusal';
import { InterviewPanel } from './interview-panel';

export const metadata = {
  title: 'Interview — AI Company Builder',
  description: 'The discovery interview for a company: its questions, why each was asked, and pause and resume.',
};

// Declared here rather than inherited, for the same reason the other console pages declare it: this page
// reads per-request authorization state, and a statically-rendered copy of it would be a different founder's.
export const dynamic = 'force-dynamic';

export default async function InterviewPage({ params }: { params: Promise<{ companyId: string }> }): Promise<React.JSX.Element> {
  const { companyId } = await params;
  const sessionResult = await getInterviewForRequest(companyId);

  // A 404 here is the NORMAL FIRST VISIT, not a failure. A session row only appears on POST, so any company
  // that has never started an interview reads as not_found. Rendering that as an error page would make the
  // ordinary first visit look broken; it is the state whose only action is the start control.
  if (sessionResult.status === 'not_found') {
    return (
      <>
        <Heading />
        <section className="cs-card" aria-labelledby="cs-int-start-h">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-int-start-h">
              No interview yet
            </h2>
          </div>
          <p className="cs-help">
            No interview session exists for this company. Starting one creates the session the discovery questions attach to. Note that a 404 here can also mean this sign-in has no internal user record yet — the
            response does not distinguish the two, so if starting fails for that reason it will say so.
          </p>
          <InterviewPanel companyId={companyId} initialSession={null} initialQa={null} qaRefusal={null} />
        </section>
      </>
    );
  }

  if (sessionResult.status !== 'interview') {
    return <InterviewRefusal status={sessionResult.status} retryAfterSeconds={'retryAfterSeconds' in sessionResult ? sessionResult.retryAfterSeconds : undefined} />;
  }

  // The qa read can refuse independently of the session read — a ceiling can be reached between the two. A
  // refusal there does NOT invalidate the session panel, so the session still renders and the question list
  // says why it is missing rather than showing an empty list that would read as "no questions exist".
  const qaResult = await getQaForRequest(companyId);
  const qa = qaResult.status === 'qa' ? qaResult.qa : null;
  const qaRefusal = qaResult.status === 'qa' ? null : qaResult.status;

  return (
    <>
      <Heading />
      <InterviewPanel companyId={companyId} initialSession={sessionResult.session} initialQa={qa} qaRefusal={qaRefusal} />
    </>
  );
}

function Heading(): React.JSX.Element {
  return (
    <div>
      <h1 className="cs-h1">Interview</h1>
      <p className="cs-sub">The discovery interview builds the platform’s understanding of your company. The server decides which questions are asked and in what order; this page shows them and records your answers.</p>
    </div>
  );
}
