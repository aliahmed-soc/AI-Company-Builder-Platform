'use client';

/*
 * ACBP-FE-014 — the roadmap generate control.
 *
 * THE ONLY CLIENT CODE ON THIS SCREEN, and it exists solely because a POST needs one. Everything else on the
 * plan screen stays a server component: the two reads, the roadmap, the board and every honesty signal are
 * rendered on the server, so this file is the whole client bundle rather than the page becoming one.
 *
 * IT IMPORTS THE INTERPRETER, NOT THE DOMAIN. `generate-outcome.ts` is pure — no `@acbp/core`, no server
 * import — which is what makes it safe here. Pulling `@acbp/core` into a `'use client'` module is the
 * ACBP-FE-010 BLOCKER, and `check:boundaries` did NOT catch it, so the rule is kept by knowing rather than by
 * the gate. `run-view.ts` in the sibling folder is server-only for exactly that reason and must not be
 * imported from here.
 *
 * `router.refresh()` RATHER THAN A CLIENT RE-READ. The page is a server component, so the honest way to show
 * a newly generated roadmap is to let the server render it again — a client-side fetch would need a second
 * copy of the read and of every mapper it feeds.
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { generateNetworkFailure, generateOutcomeFor, type GenerateOutcome } from '../strategy/generate-outcome';

export function RoadmapGenerateControl({ companyId, hasRoadmap }: { companyId: string; hasRoadmap: boolean }): React.JSX.Element {
  const router = useRouter();
  const [outcome, setOutcome] = useState<GenerateOutcome | null>(null);
  const [busy, setBusy] = useState<boolean>(false);

  const generate = useCallback(async (): Promise<void> => {
    setOutcome(null);
    setBusy(true);
    try {
      // NO BODY: "the domain reads the decision it plans from". A body here would be a second, forgeable
      // source for a fact the server already owns.
      const res = await fetch(`/api/companies/${encodeURIComponent(companyId)}/roadmap/generate`, { method: 'POST', headers: { accept: 'application/json' } });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* the status decides */
      }
      const result = generateOutcomeFor(res.status, body, res.headers.get('retry-after'), 'roadmap');
      setOutcome(result);
      // Refresh on success AND on unknown — a 500 can fail either side of the write, so looking is the only
      // way to learn what actually exists.
      if (result.produced === true || result.produced === null) router.refresh();
    } catch {
      setOutcome(generateNetworkFailure('roadmap'));
    } finally {
      setBusy(false);
    }
  }, [companyId, router]);

  return (
    <>
      <p className="cs-help">
        A roadmap is generated from a recorded strategy decision, and generation is metered against a per-company ceiling. If no decision is recorded, or the one on record is a REJECTION, or it is behind the current
        understanding, the server says which of those applies rather than failing vaguely.
      </p>
      <div className="cs-control-row">
        <button type="button" className="cs-btn cs-btn--primary" onClick={() => void generate()} disabled={busy}>
          {busy ? 'Generating…' : hasRoadmap ? 'Generate a new roadmap' : 'Generate the roadmap'}
        </button>
      </div>
      {/* ALWAYS MOUNTED so the live region exists before its content does — a region inserted together with
          its text is frequently not announced at all. */}
      <div aria-live="polite" className="cs-outcome-region">
        {outcome === null ? null : (
          <div className={`cs-control-outcome cs-control-outcome--${outcome.kind}`} data-kind={outcome.kind}>
            <strong>{outcome.title}</strong> <span>{outcome.detail}</span>
          </div>
        )}
      </div>
    </>
  );
}
