'use client';

/*
 * ACBP-FE-005 — the company creation form. The console's FIRST request that carries a body.
 *
 * TRANSPORT, and why it cannot be a plain form. This app sends `Referrer-Policy: no-referrer`
 * (server/http/security-headers.ts), so a native `<form method="post">` arrives with `Origin: null` and the
 * CSRF origin gate refuses it (CDR-081/083). `fetch` carries a real origin. The `<form>` element below exists
 * for keyboard and screen-reader semantics only — its submit is intercepted, exactly as ACBP-FE-006's control
 * uses a real `<button>` rather than a link.
 *
 * `content-type: application/json` IS MANDATORY, not decoration: the route checks it BEFORE reading the body
 * (companies-http.ts:38-39) and answers 415 without ever reaching the domain. Copying the pause control's
 * header set verbatim (which sends no content-type, because it sends no body) would 415 every submission.
 *
 * THE SUBMIT CAN TAKE A LONG TIME, AND THAT IS THE DESIGN. `POST /api/companies` runs the whole six-step
 * provisioning sequence inline and awaited before it answers (core company-service.ts:192-211). So this is not
 * a fire-and-forget create with a progress page after it: the 201 already carries the verdict. The button
 * therefore shows a real busy state and is NOT aborted on a timer — aborting the fetch would not cancel the
 * server's work, it would only destroy our knowledge of what happened, which is the worst of both.
 *
 * VALIDATION HERE IS A COURTESY, NEVER A GATE. The server validates every field again
 * (company-service.ts:90-107) and is the only authority; these limits exist so a founder is told before a
 * round trip, not because the client is trusted.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { COMPANY_CREATION_MODES } from '@acbp/contracts';
import { interpretCreateResponse, type CreateOutcome } from './create-outcome';

/** Mirrors the server's limits (company-service.ts:73-74) so the courtesy check cannot drift from them. */
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;

/** The founder-facing wording for each mode. The VALUE sent is always the contract's token, never this text. */
const MODE_LABELS: Readonly<Record<string, string>> = {
  own_idea: 'I have my own idea',
  platform_suggested: 'Suggest one for me',
  existing_business: 'I already run this business',
};

export function CreateCompanyForm(): React.JSX.Element {
  const router = useRouter();
  // No default mode: the server requires one and has no default (company-service.ts:91), so pre-selecting one
  // would be this screen inventing a choice on the founder's behalf.
  const [mode, setMode] = useState<string>('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameTooLong = trimmedName.length > NAME_MAX;
  const descriptionTooLong = trimmedDescription.length > DESCRIPTION_MAX;
  const ready = mode !== '' && trimmedName.length >= 1 && !nameTooLong && !descriptionTooLong;

  async function submit(): Promise<void> {
    if (!ready || busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      const response = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        // Only the three fields the parser keeps (companies-http.ts:59-63). `description` is omitted rather
        // than sent empty: the domain normalizes blank to null anyway, and sending less is easier to defend.
        body: JSON.stringify(trimmedDescription === '' ? { creationMode: mode, name: trimmedName } : { creationMode: mode, name: trimmedName, description: trimmedDescription }),
      });
      const text = await response.text();
      const result = interpretCreateResponse(response.status, text, response.headers.get('retry-after'));
      setOutcome(result);
      if (result.kind === 'created') {
        // Straight to the provisioning screen, which reads the run itself. The 201 carries no step data
        // (companies-http.ts:117), so there is nothing to hand forward — and that screen is also where a
        // stalled run is resumed.
        router.push(`/console/companies/${encodeURIComponent(result.companyId)}/provisioning`);
      }
    } catch {
      setOutcome({
        kind: 'error',
        detail: 'The request did not reach the server, or the reply was lost. Nothing has been assumed about whether a company was created — open the companies list to check before submitting again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="cs-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <fieldset className="cs-field" disabled={busy}>
        <legend className="cs-label">Where does this company start?</legend>
        <p className="cs-help" id="cs-mode-help">
          The server requires one of these and has no default, so nothing is pre-selected for you.
        </p>
        <div className="cs-choices" role="radiogroup" aria-describedby="cs-mode-help">
          {COMPANY_CREATION_MODES.map((m) => (
            <label key={m} className="cs-choice">
              <input type="radio" name="creationMode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              <span>{MODE_LABELS[m] ?? m}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="cs-field">
        <label className="cs-label" htmlFor="cs-name">
          Company name
        </label>
        <input
          id="cs-name"
          className="cs-input"
          type="text"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          aria-describedby="cs-name-help"
          aria-invalid={nameTooLong}
        />
        <p className="cs-help" id="cs-name-help">
          {trimmedName.length}/{NAME_MAX} characters. Required.
        </p>
      </div>

      <div className="cs-field">
        <label className="cs-label" htmlFor="cs-description">
          Description <span className="cs-help">(optional)</span>
        </label>
        <textarea
          id="cs-description"
          className="cs-input cs-textarea"
          rows={4}
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
          aria-describedby="cs-description-help"
          aria-invalid={descriptionTooLong}
        />
        <p className="cs-help" id="cs-description-help">
          {trimmedDescription.length}/{DESCRIPTION_MAX} characters.
        </p>
      </div>

      <div className="cs-control">
        <button type="submit" className="cs-btn cs-btn--primary" disabled={!ready || busy} aria-busy={busy}>
          {busy ? 'Creating…' : 'Create company'}
        </button>
        <p className="cs-control-why">
          {busy
            ? 'The server sets the company up during this request, so this can take a while. Leaving the page will not stop it.'
            : 'Creating a company also runs its six setup steps. The next screen shows how that went.'}
        </p>
      </div>

      {/*
        THE OUTCOME REGION IS A LIVE REGION. A refusal that only appeared visually would be silent to a screen
        reader, and this form's whole failure surface is text. `role="alert"` (assertive) is right here rather
        than `status`: the submission has ended and the founder is waiting on this sentence.
      */}
      <div aria-live="assertive" className="cs-outcome-region">
        {outcome !== null && outcome.kind !== 'created' ? (
          <div className={`cs-refusal cs-refusal--${outcome.kind}`} role="alert" data-outcome={outcome.kind}>
            {outcome.kind === 'invalid' ? (
              <>
                {/* The SERVER'S sentence, verbatim — it names which field, and this screen must not paraphrase it. */}
                <p className="cs-refusal-title">{outcome.serverMessage}</p>
                <p className="cs-refusal-detail">{outcome.detail}</p>
                {outcome.code === '' ? null : <span className="cs-badge cs-badge--muted">{outcome.code}</span>}
              </>
            ) : (
              <p className="cs-refusal-detail">
                {outcome.detail}
                {outcome.kind === 'rate_limited' && outcome.retryAfterSeconds !== null ? ` It should be accepted again in about ${String(outcome.retryAfterSeconds)} seconds.` : ''}
                {outcome.kind === 'rate_limited' && outcome.retryAfterSeconds === null ? ' The server did not say how long to wait.' : ''}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </form>
  );
}
