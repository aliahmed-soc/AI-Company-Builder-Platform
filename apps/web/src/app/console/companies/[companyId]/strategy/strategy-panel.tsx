'use client';

/*
 * ACBP-FE-013 — the strategy screen's live half: the comparison, the recommendation and the decision.
 *
 * THE DECISION LOGIC IS NOT IN HERE. `strategy-view.ts` maps the read, `decision-request.ts` builds the body
 * each mode is allowed to send, and `decision-outcome.ts` interprets the answer — all three model-free and
 * tested, for the same reason FE-012 split its state machine out of its transport: the interesting rulings
 * are only testable if they are not tangled up with a form.
 *
 * THE FORM HOLDS ONE DRAFT ACROSS FOUR MODES, WHICH IS WHY THE BUILDER EXISTS. Switching from "select" to
 * "reject" leaves an ordinal and a phase scope in state, and `validateStrategyDecision` FORBIDS both on a
 * rejection — so submitting whatever the form holds produces a bounded 400 naming no field, and a founder
 * would have no way to learn that an invisible leftover caused it. `buildDecisionRequest` drops what each
 * mode forbids and its suite proves the drop by running every built body through the real validator.
 *
 * NO GENERATE AND NO RECOMMEND CONTROL. Neither use case has an HTTP route — see the page's header. The
 * empty state says so in words rather than offering a button that cannot act.
 *
 * WHAT IS SENT: `content-type: application/json` on both POSTs, because both routes call `request.json()`.
 * The CSRF origin gate in `proxy.ts` covers unsafe methods before the session is established, so nothing here
 * carries CSRF logic of its own.
 */

import { useCallback, useMemo, useState } from 'react';
import { PHASE_SCOPES, SELECTION_MODES, STRATEGY_OPTION_FIELDS } from '@acbp/contracts';
import type { StrategyGenerationDTO, StrategyPhaseScope, StrategySelectionMode } from '@acbp/contracts';
import { toStrategyView, type OptionView, type StrategyView } from './strategy-view';
import { buildDecisionRequest } from './decision-request';
import { networkFailure, outcomeFor, type Outcome } from './decision-outcome';

const MODE_LABEL: Readonly<Record<StrategySelectionMode, string>> = {
  select: 'Choose one option as it stands',
  edit: 'Start from one option and change it',
  combine: 'Combine parts of several into a new one',
  reject: 'Reject all of them and say why',
};

const PHASE_LABEL: Readonly<Record<StrategyPhaseScope, string>> = {
  first_phase: 'Approve the first phase only',
  whole_plan: 'Approve the whole plan',
};

function blankFields(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) out[f] = '';
  return out;
}

function labelForField(field: string): string {
  return field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function StrategyPanel({ companyId, initialGeneration }: { companyId: string; initialGeneration: StrategyGenerationDTO | null }): React.JSX.Element {
  const [generation, setGeneration] = useState<StrategyGenerationDTO | null>(initialGeneration);
  const [mode, setMode] = useState<StrategySelectionMode>('select');
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(null);
  const [chosenFields, setChosenFields] = useState<Record<string, string>>(blankFields);
  const [phaseScope, setPhaseScope] = useState<StrategyPhaseScope | null>(null);
  const [reasons, setReasons] = useState<string>('');
  const [rationale, setRationale] = useState<string>('');
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [readError, setReadError] = useState<string | null>(null);

  const view: StrategyView = useMemo(() => toStrategyView(generation), [generation]);
  const base = `/api/companies/${encodeURIComponent(companyId)}`;

  const reread = useCallback(async (): Promise<void> => {
    try {
      // No query string: `GET /strategy` allows NO parameters and refuses an unknown one with a bounded 400,
      // so a cache-buster would turn every refresh into a failure.
      const res = await fetch(`${base}/strategy`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        setReadError('The strategy could not be re-read just now, so what is shown may be out of date.');
        return;
      }
      const body = (await res.json()) as { generation: StrategyGenerationDTO | null };
      setGeneration(body.generation);
      setReadError(null);
    } catch {
      setReadError('The strategy could not be re-read just now, so what is shown may be out of date.');
    }
  }, [base]);

  const submitDecision = useCallback(async (): Promise<void> => {
    if (view.generationId === null) return;
    setProblem(null);
    setOutcome(null);
    const built = buildDecisionRequest({ mode, selectedOrdinal, chosenFields, phaseScope, reasons });
    if (!built.ok) {
      // REFUSED LOCALLY AND NOT SENT. The server's 400 is bounded and names no field; this side can name it.
      setProblem(built.problem);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${base}/strategy/selection`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ generationId: view.generationId, request: built.request }),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        // A body this screen cannot parse is not a reason to guess: the interpreter decides from the status.
      }
      const result = outcomeFor(res.status, body, res.headers.get('retry-after'), 'selection');
      setOutcome(result);
      if (result.persisted === true || result.persisted === null) await reread();
    } catch {
      setOutcome(networkFailure('selection'));
    } finally {
      setBusy(false);
    }
  }, [base, view.generationId, mode, selectedOrdinal, chosenFields, phaseScope, reasons, reread]);

  const hardenDecision = useCallback(async (): Promise<void> => {
    const selectionId = view.selection?.selectionId;
    if (view.generationId === null || selectionId === undefined) return;
    setProblem(null);
    setOutcome(null);
    setBusy(true);
    try {
      const res = await fetch(`${base}/decisions`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        // `rationale` is OPTIONAL and a missing one must never block the record (CDR-038 §6-G2), so a blank
        // box sends the key at all rather than an empty string the domain would have to interpret.
        body: JSON.stringify(rationale.trim() === '' ? { generationId: view.generationId, selectionId } : { generationId: view.generationId, selectionId, rationale: rationale.trim() }),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* status decides */
      }
      const result = outcomeFor(res.status, body, res.headers.get('retry-after'), 'decision');
      setOutcome(result);
      if (result.persisted === true || result.persisted === null) await reread();
    } catch {
      setOutcome(networkFailure('decision'));
    } finally {
      setBusy(false);
    }
  }, [base, view.generationId, view.selection?.selectionId, rationale, reread]);

  if (view.state === 'nothing_generated') {
    return (
      <section className="cs-card" aria-labelledby="cs-st-empty-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-st-empty-h">
            No options yet
          </h2>
        </div>
        <p className="cs-empty">{view.headline}</p>
        <p className="cs-help">
          Generating them is a model-driven step that this console cannot start yet: no HTTP route reaches it, so there is deliberately no button here rather than one that would do nothing. Generation runs from the
          server side for now, and this page will show the options as soon as a generation exists.
        </p>
      </section>
    );
  }

  return (
    <>
      <StrategyCaveats view={view} />
      <RecommendationCard view={view} />
      <ComparisonCard view={view} />
      <DecisionRecordCard view={view} />

      <section className="cs-card" aria-labelledby="cs-st-decide-h">
        <div className="cs-card-h">
          <h2 className="cs-card-t" id="cs-st-decide-h">
            Record your decision
          </h2>
        </div>
        <p className="cs-help">
          Recording a decision is restricted to a company owner. This page is not told your role — the read returns the generation, not a permission set — so the controls are shown to everyone and the server decides.
          A refusal below means exactly that, and nothing is written.
        </p>

        <div className="cs-form">
          <fieldset className="cs-field">
            <legend className="cs-label">What do you want to do?</legend>
            <div className="cs-choices">
              {SELECTION_MODES.map((m) => (
                <label key={m} className="cs-choice">
                  <input type="radio" name="cs-st-mode" value={m} checked={mode === m} onChange={() => { setMode(m); setProblem(null); }} disabled={busy} />
                  <span>{MODE_LABEL[m]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {mode === 'select' || mode === 'edit' ? (
            <fieldset className="cs-field">
              <legend className="cs-label">{mode === 'select' ? 'Which option?' : 'Which option do you want to start from? (optional)'}</legend>
              <div className="cs-choices">
                {mode === 'edit' ? (
                  <label className="cs-choice">
                    <input type="radio" name="cs-st-option" checked={selectedOrdinal === null} onChange={() => setSelectedOrdinal(null)} disabled={busy} />
                    <span>Start from nothing</span>
                  </label>
                ) : null}
                {view.options.map((o) => (
                  <label key={o.optionId} className="cs-choice">
                    <input
                      type="radio"
                      name="cs-st-option"
                      checked={selectedOrdinal === o.ordinal}
                      onChange={() => {
                        setSelectedOrdinal(o.ordinal);
                        // PREFILL FROM THE BASE, for an edit only. An edit that started from a blank grid
                        // would make "change one thing" mean retyping sixteen.
                        if (mode === 'edit') {
                          const next: Record<string, string> = {};
                          for (const c of o.cells) next[c.field] = c.determined ? c.text : 'unknown';
                          setChosenFields(next);
                        }
                      }}
                      disabled={busy}
                    />
                    <span>
                      Option {o.ordinal + 1}
                      {o.recommended ? ' · recommended' : ''}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {mode === 'edit' || mode === 'combine' ? (
            <fieldset className="cs-field">
              <legend className="cs-label">The option you are recording</legend>
              <p className="cs-help">
                All {STRATEGY_OPTION_FIELDS.length} fields are required. Write “unknown” where you genuinely do not know — that is recorded as undetermined rather than as a guess, and it is the same marker the model
                uses.
              </p>
              <div className="cs-strat-grid">
                {STRATEGY_OPTION_FIELDS.map((f) => (
                  <label key={f} className="cs-field">
                    <span className="cs-label">{labelForField(f)}</span>
                    <textarea className="cs-textarea" rows={2} value={chosenFields[f] ?? ''} onChange={(e) => setChosenFields((prev) => ({ ...prev, [f]: e.target.value }))} disabled={busy} />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {mode === 'reject' ? (
            <label className="cs-field">
              <span className="cs-label">Why does none of these fit?</span>
              <textarea className="cs-textarea" rows={4} value={reasons} onChange={(e) => setReasons(e.target.value)} disabled={busy} />
              <span className="cs-help">A rejection is recorded with its reasons, and those reasons are what a later generation is steered by.</span>
            </label>
          ) : (
            /* PHASE SCOPE IS NOT OFFERED ON A REJECTION, because the validator refuses a reject that carries
               one — "phase scope is meaningless for reject". The builder drops it as well, so a stale value
               cannot leak through this control being unmounted. */
            <fieldset className="cs-field">
              <legend className="cs-label">How much are you approving? (optional)</legend>
              <div className="cs-choices">
                <label className="cs-choice">
                  <input type="radio" name="cs-st-phase" checked={phaseScope === null} onChange={() => setPhaseScope(null)} disabled={busy} />
                  <span>Do not say</span>
                </label>
                {PHASE_SCOPES.map((p) => (
                  <label key={p} className="cs-choice">
                    <input type="radio" name="cs-st-phase" checked={phaseScope === p} onChange={() => setPhaseScope(p)} disabled={busy} />
                    <span>{PHASE_LABEL[p]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div className="cs-control-row">
            <button type="button" className="cs-btn cs-btn--primary" onClick={() => void submitDecision()} disabled={busy}>
              {busy ? 'Recording…' : 'Record this decision'}
            </button>
          </div>

          {problem === null ? null : (
            <p className="cs-control-outcome cs-control-outcome--invalid" role="alert">
              {problem}
            </p>
          )}
        </div>

        <div aria-live="polite" className="cs-outcome-region">
          {outcome === null ? null : (
            <div className={`cs-control-outcome cs-control-outcome--${outcome.kind}`} role="status" data-kind={outcome.kind}>
              <strong>{outcome.title}</strong> <span>{outcome.detail}</span>
            </div>
          )}
          {readError === null ? null : (
            <p className="cs-control-outcome cs-control-outcome--error" role="status">
              {readError}
            </p>
          )}
        </div>
      </section>

      {view.decisionState === 'selected_not_recorded' ? (
        <section className="cs-card" aria-labelledby="cs-st-harden-h">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-st-harden-h">
              Harden this choice into a decision
            </h2>
          </div>
          <p className="cs-help">
            A choice is recorded; the immutable DECISION over it is a second, separate step, and it is the one the planning gate reads. Until it exists, planning stays locked.
          </p>
          <label className="cs-field">
            <span className="cs-label">Why? (optional)</span>
            <textarea className="cs-textarea" rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} disabled={busy} />
            <span className="cs-help">Leaving this blank never blocks the record.</span>
          </label>
          <div className="cs-control-row">
            <button type="button" className="cs-btn cs-btn--primary" onClick={() => void hardenDecision()} disabled={busy}>
              {busy ? 'Recording…' : 'Record the decision'}
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
}

/** The four independent signals that a generation produced less than it was asked for. */
function StrategyCaveats({ view }: { view: StrategyView }): React.JSX.Element | null {
  const rows: { key: string; tone: string; text: string }[] = [];
  if (view.state === 'fewer_than_three') {
    rows.push({ key: 'shortfall', tone: 'warning', text: `${view.shortfallNote ?? ''}${view.shortfallReason === null ? '' : ` “${view.shortfallReason}”`}` });
  }
  if (view.distinctness.tone !== 'distinct') rows.push({ key: 'distinctness', tone: view.distinctness.tone === 'insufficient' ? 'warning' : 'muted', text: view.distinctness.note });
  if (view.modelFlaggedPartial) {
    rows.push({ key: 'partial', tone: 'warning', text: 'The model flagged its own output as partial. That is separate from the number of options: a complete-looking set can still be reported incomplete by the thing that produced it.' });
  }
  if (view.countMismatch) {
    rows.push({ key: 'count', tone: 'warning', text: `The server counted ${String(view.optionCount)} options but sent ${String(view.options.length)}. What is shown below is not the whole set.` });
  }
  if (rows.length === 0) return null;
  return (
    <section className="cs-card" aria-labelledby="cs-st-caveat-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-st-caveat-h">
          What the server said about this generation
        </h2>
      </div>
      <ul className="cs-list">
        {rows.map((r) => (
          <li key={r.key} className={`cs-item cs-strat-caveat cs-strat-caveat--${r.tone}`} data-caveat={r.key}>
            {r.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecommendationCard({ view }: { view: StrategyView }): React.JSX.Element {
  const rec = view.recommendation;
  return (
    <section className="cs-card" aria-labelledby="cs-st-rec-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-st-rec-h">
          Advisory recommendation
        </h2>
        {rec === null ? <span className="cs-badge cs-badge--muted">none recorded</span> : <span className="cs-badge cs-badge--primary">option {rec.recommendedOrdinal + 1}</span>}
      </div>
      <p className="cs-help">{view.recommendationNote}</p>
      {rec === null ? null : (
        <>
          <p className="cs-item-body">{rec.rationale}</p>
          {/* SENSITIVITIES ARE SHOWN, NOT COLLAPSED. They are the half that says what would change the
              recommendation, and a recommendation without them reads as more certain than it is. */}
          <p className="cs-item-meta">What would change this: {rec.sensitivities}</p>
        </>
      )}
    </section>
  );
}

function ComparisonCard({ view }: { view: StrategyView }): React.JSX.Element {
  const selectedId = view.selection?.selectedOptionId ?? null;
  return (
    <section className="cs-card" aria-labelledby="cs-st-cmp-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-st-cmp-h">
          The options, compared
        </h2>
        <span className="cs-badge cs-badge--muted">
          generated from understanding v{String(view.understandingVersion ?? 0)}
        </span>
      </div>
      {/* Horizontal scroll lives on the wrapper, so a wide table never makes the PAGE scroll sideways. */}
      <div className="cs-table-scroll">
        <table className="cs-table cs-strat-table">
          <caption className="cs-sr-only">Each of the {STRATEGY_OPTION_FIELDS.length} fields of the strategy option standard, across every option in this generation.</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              {view.options.map((o) => (
                <th key={o.optionId} scope="col" data-recommended={o.recommended ? 'yes' : 'no'} data-selected={selectedId === o.optionId ? 'yes' : 'no'}>
                  Option {o.ordinal + 1}
                  {o.recommended ? <span className="cs-badge cs-badge--primary">recommended</span> : null}
                  {selectedId === o.optionId ? <span className="cs-badge cs-badge--success">your choice</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STRATEGY_OPTION_FIELDS.map((field, row) => (
              <tr key={field}>
                <th scope="row">{labelForField(field)}</th>
                {view.options.map((o) => (
                  <OptionCell key={o.optionId} option={o} row={row} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OptionCell({ option, row }: { option: OptionView; row: number }): React.JSX.Element {
  const cell = option.cells[row];
  if (cell === undefined) return <td />;
  // AN UNDETERMINED FIELD IS MARKED, NOT PRINTED AS CONTENT. The contract requires the model to write a
  // labelled sentinel where it cannot determine a field precisely so this can be shown as a gap rather than
  // as an answer; rendering the raw token would put the word "unknown" in front of a founder as though the
  // model had asserted it.
  return (
    <td data-determined={cell.determined ? 'yes' : 'no'} className={cell.determined ? undefined : 'cs-strat-undetermined'}>
      {cell.determined ? cell.text : <em>Not determined</em>}
    </td>
  );
}

function DecisionRecordCard({ view }: { view: StrategyView }): React.JSX.Element {
  const { selection, decision } = view;
  return (
    <section className="cs-card" aria-labelledby="cs-st-dec-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-st-dec-h">
          Where this stands
        </h2>
        <span className={`cs-badge ${view.planningUnlocked ? 'cs-badge--success' : 'cs-badge--muted'}`}>{view.planningUnlocked ? 'planning unlocked' : 'planning locked'}</span>
      </div>

      {view.decisionState === 'none' ? (
        <p className="cs-empty">No choice has been recorded over this generation yet.</p>
      ) : (
        <ul className="cs-list">
          {selection === null ? null : (
            <li className="cs-item">
              <span className="cs-item-title">Latest choice: {selection.mode}</span>
              <span className="cs-item-meta">
                {selection.phaseScope === null ? 'No phase scope was stated.' : PHASE_LABEL[selection.phaseScope]} · recorded {selection.createdAt}
              </span>
              {selection.reasons === null ? null : <span className="cs-item-body">{selection.reasons}</span>}
            </li>
          )}
          {decision === null ? (
            <li className="cs-item">
              <span className="cs-item-title">Not yet hardened into a decision</span>
              <span className="cs-item-meta">A choice on its own does not unlock planning; the immutable decision record is what the gate reads.</span>
            </li>
          ) : (
            <li className="cs-item">
              {/* THE MODE COMES FROM THE DECISION, NEVER FROM THE LATEST SELECTION. The DTO carries it
                  snapshot at record time precisely because the two can differ, and reading it off the
                  selection would report a rejection as a selection, or the reverse. */}
              <span className="cs-item-title">Decision recorded: {decision.mode}</span>
              <span className="cs-item-meta">
                Over {String(decision.optionsConsideredCount)} options, at understanding v{String(decision.understandingVersion)} · {decision.createdAt}
              </span>
              {decision.rationale === null ? null : <span className="cs-item-body">{decision.rationale}</span>}
              {decision.mode === 'reject' ? <span className="cs-item-meta">A rejection is a real decision, and it deliberately does not unlock planning.</span> : null}
            </li>
          )}
          {view.decisionCoversLatestSelection ? null : (
            <li className="cs-item cs-strat-caveat cs-strat-caveat--warning">
              The recorded decision hardened an EARLIER choice than the latest one shown above. The newer choice is not what the planning gate reads.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
