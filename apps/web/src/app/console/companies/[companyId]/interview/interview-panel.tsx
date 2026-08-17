'use client';

/*
 * ACBP-FE-007 — the interview screen's live half: start, pause, resume, and answering.
 *
 * THE ROW'S CONSTRAINT IS THE DESIGN: "Question selection and batching are server decisions; the UI renders
 * what it is given and never invents a next question." Here that is enforced by ABSENCE rather than by
 * discipline — the answer response carries no next question, and no route exists that could produce one, so
 * there is nothing for this component to invent with. After a write it re-reads the qa payload and renders
 * whatever came back.
 *
 * EVERY MUTATION IS A SAME-ORIGIN `fetch`, NEVER A FORM POST. `proxy.ts:87-100` refuses any unsafe-method
 * request without same-origin provenance, and this app sends `Referrer-Policy: no-referrer`, so a native
 * form POST arrives with `Origin: null` and is refused with a 403 byte-identical to an authorization denial
 * — undiagnosable from the response.
 *
 * THE CONTENT-TYPE HEADER IS SENT ON THE ANSWER POST AND ONLY THERE. `readJsonObject` checks the content
 * type before reading a byte, so omitting it on the answer would 415 every submission; the three bodiless
 * POSTs never read a body, so sending one there would be noise. This is the trap `create-form.tsx:12-14`
 * already records in the other direction.
 */

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AnswerSubmission, InterviewSessionDTO, SessionQADTO } from '@acbp/contracts';
import { ANSWER_CONTENT_MAX } from '@acbp/contracts';
import { describeInterview, toInterviewView, type QuestionCardView } from './interview-view';
import { interpretAnswerResponse, type AnswerOutcome } from './answer-outcome';
import { interpretSessionResponse, type SessionAction, type SessionOutcome } from './session-outcome';

export function InterviewPanel({
  companyId,
  initialSession,
  initialQa,
  qaRefusal,
}: {
  companyId: string;
  initialSession: InterviewSessionDTO | null;
  initialQa: SessionQADTO | null;
  qaRefusal: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const [session, setSession] = useState<InterviewSessionDTO | null>(initialSession);
  const [qa, setQa] = useState<SessionQADTO | null>(initialQa);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const [busyQuestion, setBusyQuestion] = useState<string | null>(null);
  const [answerOutcome, setAnswerOutcome] = useState<{ questionId: string; outcome: AnswerOutcome } | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionOutcome, setSessionOutcome] = useState<SessionOutcome | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const base = `/api/companies/${encodeURIComponent(companyId)}/interview`;

  /** Re-read the questions. THE loop: a write never returns the next question, so the screen goes and looks. */
  const readQa = useCallback(async (): Promise<void> => {
    try {
      // NO query string, ever — all five interview routes answer a bounded 400 to ANY query parameter, so a
      // cache-buster would turn every re-read into a failure.
      const res = await fetch(`${base}/qa`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        setReadError('The question list could not be re-read just now, so what is shown may be out of date.');
        return;
      }
      const body = (await res.json()) as { qa: SessionQADTO };
      setQa(body.qa);
      setReadError(null);
    } catch {
      setReadError('The question list could not be re-read just now, so what is shown may be out of date.');
    }
  }, [base]);

  async function runSessionAction(action: SessionAction): Promise<void> {
    if (sessionBusy) return;
    setSessionBusy(true);
    setSessionOutcome(null);
    try {
      const path = action === 'start' ? base : `${base}/${action === 'pause' ? 'suspend' : 'resume'}`;
      // Bodiless — these routes read and parse nothing, so no content-type is sent.
      const res = await fetch(path, { method: 'POST', headers: { accept: 'application/json' } });
      const text = await res.text();
      const outcome = interpretSessionResponse(action, res.status, text, res.headers.get('retry-after'));
      setSessionOutcome(outcome);
      if (outcome.kind === 'ok') {
        setSession(outcome.session);
        await readQa();
        router.refresh();
      }
    } catch {
      setSessionOutcome({ kind: 'error', detail: 'The request did not reach the server, or the reply was lost. Nothing has been assumed about whether it took effect — reload to see the current state.' });
    } finally {
      setSessionBusy(false);
    }
  }

  async function submitAnswer(questionId: string, submission: AnswerSubmission): Promise<void> {
    if (busyQuestion !== null) return;
    setBusyQuestion(questionId);
    setAnswerOutcome(null);
    try {
      // A SKIP CARRIES NO CONTENT. `validateAnswerSubmission` rejects a skip whose `content` is anything but
      // undefined or null, so attaching the textarea's current text to a skip is a guaranteed 400.
      const body = submission.status === 'skipped' ? { status: 'skipped' } : { status: 'answered', content: submission.content };
      const res = await fetch(`${base}/questions/${encodeURIComponent(questionId)}/answer`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const outcome = interpretAnswerResponse(res.status, text, res.headers.get('retry-after'), submission);
      setAnswerOutcome({ questionId, outcome });
      if (outcome.kind === 'saved' || outcome.kind === 'unchanged' || outcome.kind === 'overwritten_by_other') {
        // Re-read in all three cases, including the one where the answer was LOST: the record is the only
        // authority on what is stored, and that arm exists precisely because it is not what was submitted.
        await readQa();
        if (outcome.kind === 'saved') setDrafts((d) => ({ ...d, [questionId]: '' }));
      }
    } catch {
      setAnswerOutcome({ questionId, outcome: { kind: 'error', detail: 'The answer did not reach the server, or the reply was lost. Nothing has been assumed about whether it was saved — the list below is re-read on the next action.' } });
    } finally {
      setBusyQuestion(null);
    }
  }

  if (session === null) {
    return (
      <div className="cs-control">
        <button type="button" className="cs-btn cs-btn--primary" onClick={() => void runSessionAction('start')} disabled={sessionBusy} aria-busy={sessionBusy}>
          {sessionBusy ? 'Starting…' : 'Start the interview'}
        </button>
        {sessionOutcome === null ? null : (
          <p className={`cs-control-outcome cs-control-outcome--${sessionOutcome.kind}`} role="status">
            {sessionOutcome.detail}
          </p>
        )}
      </div>
    );
  }

  const view = toInterviewView(session, qa ?? { sessionId: session.sessionId, items: [] });
  const announcement = describeInterview(view);

  return (
    <>
      <SessionCard
        view={view}
        busy={sessionBusy}
        outcome={sessionOutcome}
        announcement={announcement}
        onAction={(a) => void runSessionAction(a)}
      />

      <section className="cs-card" aria-labelledby="cs-int-q-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-int-q-h">
            Questions
          </h2>
          {view.totalCount > 0 ? <span className="cs-badge cs-badge--muted">{view.addressedCount} of {view.totalCount} addressed</span> : null}
        </div>

        {readError === null ? null : (
          <p className="cs-control-outcome cs-control-outcome--error" role="status">
            {readError}
          </p>
        )}

        {qaRefusal !== null && qa === null ? (
          <p className="cs-control-outcome cs-control-outcome--refused" role="status">
            The question list could not be read (the server answered <strong>{qaRefusal}</strong>), so none is shown. This is NOT the same as there being no questions — nothing is known either way until the read
            succeeds.
          </p>
        ) : view.questionsState === 'none_exist' ? (
          <p className="cs-help">
            There are no questions in this interview yet. The server has not produced any for this session, and nothing on this page can request them — question generation is not exposed over HTTP on this build. When
            questions do appear, they will be listed here with the reason each was asked.
          </p>
        ) : (
          <ol className="cs-questions">
            {view.questions.map((q, index) => (
              <QuestionCard
                key={q.questionId}
                q={q}
                index={index}
                isNext={view.resumeAt?.questionId === q.questionId}
                draft={drafts[q.questionId] ?? ''}
                busy={busyQuestion === q.questionId}
                anyBusy={busyQuestion !== null}
                outcome={answerOutcome?.questionId === q.questionId ? answerOutcome.outcome : null}
                onDraft={(text) => setDrafts((d) => ({ ...d, [q.questionId]: text }))}
                onSubmit={(submission) => void submitAnswer(q.questionId, submission)}
              />
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

function SessionCard({
  view,
  busy,
  outcome,
  announcement,
  onAction,
}: {
  view: ReturnType<typeof toInterviewView>;
  busy: boolean;
  outcome: SessionOutcome | null;
  announcement: string;
  onAction: (a: SessionAction) => void;
}): React.JSX.Element {
  const lastAnnounced = useRef<string>('');
  // Announce only on CHANGE. The flag drives the test hook only — the real no-repeat behaviour comes from
  // `describeInterview` being pure over server state, so an unchanged state yields an identical string and
  // the live region has nothing new to say.
  const changed = announcement !== lastAnnounced.current;
  if (changed) lastAnnounced.current = announcement;

  return (
    <section className="cs-card" aria-labelledby="cs-int-s-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-int-s-h">
          Session
        </h2>
        {/* The server's own phase word, verbatim — this screen does not own that vocabulary. */}
        <span className="cs-badge cs-badge--muted">{view.phase}</span>
      </div>

      {/* Polite and sr-only: progress is information, not an interruption, and the counts above say the same
          thing visually. A SEPARATE node from the list, because a live region whose children re-render
          wholesale frequently announces nothing at all. */}
      <p aria-live="polite" className="cs-sr-only" data-announcement={changed ? 'changed' : 'same'}>
        {announcement}
      </p>

      <div className="cs-control">
        <div className="cs-control-row">
          <ControlButton label="Pause" busyLabel="Pausing…" action="pause" availability={view.pause} busy={busy} onAction={onAction} />
          <ControlButton label="Resume" busyLabel="Resuming…" action="resume" availability={view.resume} busy={busy} onAction={onAction} />
        </div>
        {outcome === null ? null : (
          <p className={`cs-control-outcome cs-control-outcome--${outcome.kind}`} role="status">
            {outcome.detail}
          </p>
        )}
      </div>
    </section>
  );
}

function ControlButton({
  label,
  busyLabel,
  action,
  availability,
  busy,
  onAction,
}: {
  label: string;
  busyLabel: string;
  action: SessionAction;
  availability: { kind: 'available' } | { kind: 'unavailable'; because: string; reason: string };
  busy: boolean;
  onAction: (a: SessionAction) => void;
}): React.JSX.Element {
  const whyId = `cs-int-why-${action}`;
  if (availability.kind === 'unavailable') {
    return (
      <div className="cs-control">
        {/* DISABLED because the server WILL refuse — firing it is a guaranteed 409. The reason is TEXT at
            readable size, never a tooltip: a hover-only explanation is unreachable by touch and keyboard. */}
        <button type="button" className="cs-btn" disabled aria-describedby={whyId}>
          {label}
        </button>
        <p className="cs-control-why" id={whyId} data-because={availability.because}>
          {availability.reason}
        </p>
      </div>
    );
  }
  return (
    <button type="button" className="cs-btn cs-btn--primary" onClick={() => onAction(action)} disabled={busy} aria-busy={busy}>
      {busy ? busyLabel : label}
    </button>
  );
}

function QuestionCard({
  q,
  index,
  isNext,
  draft,
  busy,
  anyBusy,
  outcome,
  onDraft,
  onSubmit,
}: {
  q: QuestionCardView;
  index: number;
  isNext: boolean;
  draft: string;
  busy: boolean;
  anyBusy: boolean;
  outcome: AnswerOutcome | null;
  onDraft: (text: string) => void;
  onSubmit: (submission: AnswerSubmission) => void;
}): React.JSX.Element {
  // Ids are derived from the RENDER INDEX rather than the question id: they only need to be unique within
  // the page, and an index is guaranteed to be a valid id fragment, whereas a server id would need
  // sanitizing to be safe in `aria-describedby`. Every id in this file is per-question for that reason —
  // the console's other screens use literals, which would collide the moment a list renders more than one.
  const fieldId = `cs-q${String(index)}`;
  const whyId = `${fieldId}-why`;
  const helpId = `${fieldId}-help`;
  const described = [q.rationale === null ? null : whyId, helpId].filter((x): x is string => x !== null).join(' ');

  // Matches the SERVER's rule exactly: content is NOT trimmed, and emptiness is checked on the raw string,
  // so a whitespace-only answer is valid here. Disabling on `trim()` would enforce a stricter rule than the
  // server has — the UI inventing a requirement.
  const canSubmit = draft.length > 0 && draft.length <= ANSWER_CONTENT_MAX;

  return (
    <li className={`cs-question${isNext ? ' cs-question--next' : ''}`} data-lifecycle={q.lifecycle} data-source={q.source}>
      <fieldset className="cs-field cs-question-set" disabled={busy}>
        <legend className="cs-label">
          {q.prompt}
          {isNext ? <span className="cs-badge cs-badge--muted cs-question-tag">next</span> : null}
        </legend>

        {/* The "why this question" the row names. Rendered ONLY when the server sent one — `rationale` is
            nullable for legacy and manually-seeded questions, and inventing a sentence here would claim the
            model explained itself when it did not. */}
        {q.rationale === null ? null : (
          <p className="cs-question-why" id={whyId}>
            <span className="cs-question-why-lead">Why this is asked:</span> {q.rationale}
          </p>
        )}

        {/* The server flagged this as coming from the static fallback bank rather than the model. Shown
            because it is the only signal a founder gets that generation degraded. */}
        {q.degraded ? <p className="cs-question-degraded">This question came from the platform’s standard set rather than being generated for your company — the server flagged it that way.</p> : null}

        {q.lifecycle === 'asked' ? (
          <>
            <textarea
              id={fieldId}
              className="cs-input cs-textarea"
              value={draft}
              onChange={(e) => onDraft(e.target.value)}
              aria-describedby={described}
              rows={4}
            />
            <p className="cs-help" id={helpId}>
              {draft.length} of {ANSWER_CONTENT_MAX} characters. The server’s own limit is measured in bytes as well as characters, so text in a non-Latin script can be refused before this count runs out.
            </p>
            <div className="cs-control-row">
              <button type="button" className="cs-btn cs-btn--primary" onClick={() => onSubmit({ status: 'answered', content: draft })} disabled={!canSubmit || anyBusy} aria-busy={busy}>
                {busy ? 'Saving…' : 'Save answer'}
              </button>
              {/* The "I don't know" path. Sends the skip token with NO content, which is what the server's
                  closed vocabulary calls this and the only shape it accepts. */}
              <button type="button" className="cs-btn" onClick={() => onSubmit({ status: 'skipped', content: null })} disabled={anyBusy}>
                I don’t know
              </button>
            </div>
          </>
        ) : (
          <div className="cs-question-answered">
            {/* ANSWERED AND SKIPPED ARE DIFFERENT SERVER STATES and are shown as different things. Collapsing
                them into one "done" would destroy the whole "I don't know" signal. */}
            {q.lifecycle === 'skipped' ? (
              <p className="cs-question-skip">Answered with “I don’t know”. The server recorded that no answer was given.</p>
            ) : (
              <p className="cs-question-text">{q.answerText}</p>
            )}
            {q.revisionCount > 1 ? <p className="cs-help">Revised {q.revisionCount} times. The server keeps every revision.</p> : null}
          </div>
        )}
      </fieldset>

      {/* Assertive and always mounted: the submission has ENDED and the founder is waiting on this sentence.
          The wrapper exists even when empty, because a live region added to the DOM at the same moment as
          its text is frequently not announced at all. */}
      <div aria-live="assertive" className="cs-outcome-region">
        {outcome === null ? null : (
          <div role="alert" className={`cs-control-outcome cs-control-outcome--${outcome.kind}`} data-outcome={outcome.kind}>
            {/* The SERVER'S sentence, verbatim — it names which field is wrong, and this screen must not
                paraphrase it. Anything below is only what the envelope does not say. */}
            {outcome.kind === 'invalid' ? <p className="cs-question-server-msg">{outcome.serverMessage}</p> : null}
            <p>{outcome.detail}</p>
            {outcome.kind === 'overwritten_by_other' ? <p className="cs-question-stored">Currently stored: {outcome.storedContent === null ? '“I don’t know”' : outcome.storedContent}</p> : null}
            {outcome.kind === 'rate_limited' && outcome.retryAfterSeconds !== null ? <p>The server asked for about {outcome.retryAfterSeconds} seconds before retrying.</p> : null}
          </div>
        )}
      </div>
    </li>
  );
}
