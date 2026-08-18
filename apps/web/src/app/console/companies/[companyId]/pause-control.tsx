'use client';

/*
 * ACBP-FE-006 — the pause / resume control. The repository's FIRST state-changing page control.
 *
 * TRANSPORT: a same-origin `fetch` to the EXISTING `POST /api/companies/{id}/pause|resume` routes, by owner
 * ruling. The alternative — a Server Action calling the request function directly — would save a hop and a
 * rate-limit charge, but a Server Action is a state-changing entry point that NO static guard in this repo can
 * see: `tools/check-csrf-origin-gate.mjs` enumerates `route.*` under `api/`, and `check-rate-limit-coverage.mjs`
 * is scoped to `app/api/**`. Both would have stayed green while their promises quietly stopped covering this
 * control. Keeping the mutation on a real route keeps both guards honest.
 *
 * NOT A `<form method="post">`, and that is not a style preference: this app sends `Referrer-Policy: no-referrer`,
 * which makes a native form POST arrive with `Origin: null` (CDR-083 §6.4). `fetch` defaults to mode 'cors' and
 * carries a real origin, so it satisfies the CSRF gate without anyone loosening the gate to accept null — "a
 * check written to accept null is not a check".
 *
 * THIS CONTROL ENFORCES NOTHING. `company:pause` / `company:resume` are owner-only in the authz matrix and
 * checked inside @acbp/core on every call. Disabling the button changes what the interface CLAIMS, never what
 * the server accepts (AGENTS.md §18).
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ControlState } from './company-view';
import { interpretTransitionResponse, type TransitionOutcome } from './transition-outcome';

export function PauseControl({ companyId, control }: { companyId: string; control: ControlState }): React.JSX.Element {
  const router = useRouter();
  const [outcome, setOutcome] = useState<TransitionOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  const [inFlight, setInFlight] = useState(false);

  if (control.kind === 'unavailable') {
    return (
      <div className="cs-control">
        {/*
          DISABLED, WITH THE REASON RENDERED NEXT TO IT — not hidden. A missing control leaves a viewer
          wondering whether the feature exists; a disabled one with a sentence tells them the truth, and the
          server refuses regardless.
        */}
        <button type="button" className="cs-btn cs-btn--danger" disabled aria-describedby="cs-control-why">
          Pause this company
        </button>
        <p className="cs-control-why" id="cs-control-why" data-because={control.because}>
          {control.reason}
        </p>
      </div>
    );
  }

  const busy = pending || inFlight;

  async function run(): Promise<void> {
    setInFlight(true);
    setOutcome(null);
    try {
      const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/${control.kind === 'available' ? control.action : ''}`, {
        method: 'POST',
        // Same-origin by construction. No body: the transition fact is the whole payload — these routes accept
        // none, and no caller-supplied reason is persisted.
        headers: { accept: 'application/json' },
      });
      const body: unknown = await response.json().catch(() => null);
      const result = interpretTransitionResponse(response.status, body, response.headers.get('retry-after'));
      setOutcome(result);
      // RE-READ RATHER THAN PATCH LOCAL STATE. The server is the only authority on the company's status, and a
      // 409 exists precisely because it can change underneath us. Refreshing shows what is actually true.
      if (result.kind === 'done' || result.kind === 'stale') startTransition(() => router.refresh());
    } catch {
      // A failed fetch says nothing about whether the server applied the change — say exactly that.
      setOutcome({ kind: 'error', message: 'The request did not reach the server, or the reply was lost. Nothing has been assumed about whether the change was applied — reload to see the current state.' });
    } finally {
      setInFlight(false);
    }
  }

  return (
    <div className="cs-control">
      <button type="button" className="cs-btn cs-btn--danger" onClick={() => void run()} disabled={busy} aria-busy={busy}>
        {busy ? 'Working…' : control.label}
      </button>
      {outcome !== null ? (
        <p className={`cs-control-outcome cs-control-outcome--${outcome.kind}`} role="status">
          {outcome.message}
        </p>
      ) : (
        <p className="cs-control-why">
          Pausing halts this company&rsquo;s autonomous work at the next safe boundary. It is not the emergency
          stop — that mechanism records held work and has no interface yet.
        </p>
      )}
    </div>
  );
}
