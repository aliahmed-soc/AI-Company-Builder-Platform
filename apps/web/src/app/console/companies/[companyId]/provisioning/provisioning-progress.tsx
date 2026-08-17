'use client';

/*
 * ACBP-FE-005 — the provisioning progress screen's live half: polling and the resume control.
 *
 * THE ROW'S CONSTRAINT IS THE DESIGN: "Provisioning is server-driven and resumable; the UI polls and offers
 * resume, never re-running steps itself." Nothing here executes a step. The only mutation is
 * `POST .../provisioning/resume`, which asks the SERVER to continue its own sequence.
 *
 * THERE IS NO "IN PROGRESS" STEP, AND THIS COMPONENT MUST NOT IMPLY ONE. `PROVISIONING_STEP_STATUSES` is
 * `pending | completed | failed`; `running` is deliberately never committed (contracts provisioning.ts:22-27).
 * A spinner pinned to the "current" step would draw a state the database refuses to hold. What is shown is the
 * truthful set: done, waiting, failed — plus whether the run as a whole is resumable.
 *
 * POLLING IS BOUNDED, AND STOPS FOR A REASON IT CAN NAME. The payload carries no poll hint and no ETA, so the
 * cadence is this screen's choice; leaving a page polling forever is the "spinning forever" the row forbids.
 * It polls only while the run could still change on its own, and after the bound it says so and offers a
 * manual re-check rather than pretending to still be watching.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProvisioningStatusDTO } from '@acbp/contracts';
import { toProvisioningView, type ProvisioningView } from './provisioning-view';
import { interpretResumeResponse, type ResumeOutcome } from './resume-outcome';

/**
 * WHY POLL AT ALL, when the create POST already ran provisioning inline.
 *
 * A run can be advanced by ANOTHER request — a second tab, or an operator — so the state can change without
 * this page doing anything. Polling exists for that, not to watch work this page started.
 */
const POLL_INTERVAL_MS = 3000;
/** Bounded: ~2 minutes. After this the screen stops and says it stopped. */
const MAX_POLLS = 40;

export function ProvisioningProgress({ companyId, initial }: { companyId: string; initial: ProvisioningStatusDTO }): React.JSX.Element {
  const router = useRouter();
  const [dto, setDto] = useState<ProvisioningStatusDTO>(initial);
  const [pollsLeft, setPollsLeft] = useState(MAX_POLLS);
  const [watchStopped, setWatchStopped] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeOutcome, setResumeOutcome] = useState<ResumeOutcome | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const view = toProvisioningView(dto);

  /** The announcement a screen reader hears. Recomputed from the view so it can never drift from the visuals. */
  const announcement = describe(view);
  const lastAnnounced = useRef<string>('');

  const readOnce = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/provisioning`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        // A failed READ is not evidence about the run — only about our view of it.
        setReadError('The latest state could not be read just now. What is shown below may be out of date.');
        return;
      }
      const body = (await res.json()) as ProvisioningStatusDTO;
      setDto(body);
      setReadError(null);
    } catch {
      setReadError('The latest state could not be read just now. What is shown below may be out of date.');
    }
  }, [companyId]);

  useEffect(() => {
    // Poll ONLY while the run could still move on its own. A completed, exhausted or inconsistent run is
    // terminal until someone acts, so continuing to poll would burn requests to watch nothing change.
    if (view.kind !== 'resumable') return;
    if (pollsLeft <= 0) {
      setWatchStopped(true);
      return;
    }
    const t = setTimeout(() => {
      setPollsLeft((n) => n - 1);
      void readOnce();
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [view.kind, pollsLeft, readOnce]);

  async function resume(): Promise<void> {
    if (resuming) return;
    setResuming(true);
    setResumeOutcome(null);
    try {
      const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/provisioning/resume`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      const text = await res.text();
      const result = interpretResumeResponse(res.status, text, res.headers.get('retry-after'));
      setResumeOutcome(result);
      if (result.kind === 'ok') {
        // The 200 CARRIES the current state, so this is the server's own answer rather than a second read that
        // could race with it. Note it is not evidence that a step ran — an already-complete run answers 200
        // too — which is why nothing here announces progress; the re-rendered steps say what is true.
        setDto(result.provisioning);
        setPollsLeft(MAX_POLLS);
        setWatchStopped(false);
        router.refresh();
      } else {
        // A refusal tells us nothing about the run's state, so go and look.
        await readOnce();
      }
    } catch {
      setResumeOutcome({ kind: 'error', detail: 'The resume request did not reach the server, or the reply was lost. Nothing has been assumed about whether it ran — the state below is re-read on the next check.' });
    } finally {
      setResuming(false);
    }
  }

  // Announce only on CHANGE, so a screen reader is not re-told the same sentence on every poll.
  const shouldAnnounce = announcement !== lastAnnounced.current;
  if (shouldAnnounce) lastAnnounced.current = announcement;

  return (
    <>
      {/*
        THE LIVE REGION the backlog row requires ("Live region announces step transitions"). `polite`, because
        a step completing is information rather than an interruption. It is a SEPARATE node from the visual
        stepper: an aria-live container whose children are re-rendered wholesale often announces nothing at
        all, so this holds one short sentence and changes only when the state really changes.
      */}
      <p aria-live="polite" className="cs-sr-only" data-announcement={shouldAnnounce ? 'changed' : 'same'}>
        {announcement}
      </p>

      <ol className="cs-steps">
        {view.steps.map((s) => (
          <li key={s.step} className={`cs-step cs-step--${s.tone}`} data-step={s.step} data-status={s.status}>
            <span className="cs-step-order" aria-hidden="true">
              {s.order}
            </span>
            <span className="cs-step-name">{s.label}</span>
            {/* The server's word, verbatim — the tone above is decoration only. */}
            <span className="cs-step-status">{s.status}</span>
            {s.failureCode === null ? null : <span className="cs-badge cs-badge--warning">{s.failureCode}</span>}
            {s.attempt > 0 ? (
              <span className="cs-step-attempt">
                attempt {s.attempt}
                {s.atAttemptCap ? ' (limit reached)' : ''}
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {readError === null ? null : (
        <p className="cs-control-outcome cs-control-outcome--error" role="status">
          {readError}
        </p>
      )}

      <div className="cs-control">{renderControl()}</div>
    </>
  );

  function renderControl(): React.JSX.Element {
    if (view.kind === 'complete') {
      return (
        <>
          <a className="cs-btn cs-btn--primary" href={`/console/companies/${encodeURIComponent(companyId)}`}>
            Open the company
          </a>
          <p className="cs-control-why">All six steps are complete. There is nothing left to resume.</p>
        </>
      );
    }

    if (view.kind === 'exhausted') {
      return (
        <>
          {/* DISABLED, because the server WILL refuse: a step at the attempt cap makes resume a no-op that
              returns 409. Offering an enabled button here would be a control that lies. */}
          <button type="button" className="cs-btn" disabled aria-describedby="cs-resume-why">
            Resume provisioning
          </button>
          <p className="cs-control-why" id="cs-resume-why" data-because="exhausted">
            Setup stopped at <strong>{view.blockedStepLabel === '' ? 'a step the server did not name' : view.blockedStepLabel}</strong> after {view.attempts} of {view.maxAttempts} permitted attempts
            {view.failureCode === null ? '' : `, reporting ${view.failureCode}`}. The server will not attempt it again, so resuming is not offered. An operator has to take it from here.
          </p>
        </>
      );
    }

    if (view.kind === 'inconsistent') {
      return (
        <>
          <button type="button" className="cs-btn" disabled aria-describedby="cs-resume-why">
            Resume provisioning
          </button>
          <p className="cs-control-why" id="cs-resume-why" data-because="inconsistent">
            {view.detail}
          </p>
        </>
      );
    }

    return (
      <>
        <button type="button" className="cs-btn cs-btn--primary" onClick={() => void resume()} disabled={resuming} aria-busy={resuming}>
          {resuming ? 'Resuming…' : 'Resume provisioning'}
        </button>
        {resumeOutcome === null ? (
          <p className="cs-control-why">
            {watchStopped
              ? 'This page has stopped checking for updates. Resume asks the server to continue from ' + view.nextStepLabel + '.'
              : `${view.completedCount} of ${view.totalCount} steps are complete. The next is ${view.nextStepLabel}. This page re-checks every few seconds; resuming asks the server to continue now.`}
          </p>
        ) : (
          <p className={`cs-control-outcome cs-control-outcome--${resumeOutcome.kind}`} role="status">
            {resumeOutcome.detail}
          </p>
        )}
      </>
    );
  }
}

/** One short sentence per state — the thing a screen reader is told when the run changes. */
function describe(view: ProvisioningView): string {
  switch (view.kind) {
    case 'complete':
      return 'Setup complete. All six steps finished.';
    case 'resumable':
      return `Setup in progress: ${view.completedCount} of ${view.totalCount} steps complete. Next step ${view.nextStepLabel}, not yet started.`;
    case 'exhausted':
      return `Setup stopped at ${view.blockedStepLabel === '' ? 'a step the server did not name' : view.blockedStepLabel} after reaching the attempt limit. Resuming is not available.`;
    case 'inconsistent':
      return 'Setup state cannot be read reliably. Resuming is not available.';
  }
}
