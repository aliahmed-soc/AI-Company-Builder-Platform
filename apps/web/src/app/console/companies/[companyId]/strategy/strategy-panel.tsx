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
 * rejection, so submitting whatever the form holds produces a bounded 400 naming no field.
 *
 * TWO WRITES, TWO STEPS, AND THE SECOND ONE MUST STAY REACHABLE. A selection is not a decision: the
 * immutable decision record is what hardens it. An earlier version of this file showed the harden control
 * only while `decisionState === 'selected_not_recorded'` — i.e. only while NO decision existed at all — so
 * the moment any decision was recorded the control vanished. A founder who then recorded a NEWER selection
 * was shown "the recorded decision hardened an EARLIER choice" by this very screen and given no way to act
 * on it, while the server would have accepted the hardening happily. That was a control that could not act
 * on a state the page itself named, which is the exact thing this console refuses to ship. It is now driven
 * by `decisionCoversLatestSelection`.
 *
 * NO GENERATE AND NO RECOMMEND CONTROL. Neither use case has an HTTP route — see the page's header.
 *
 * WHAT IS SENT: `content-type: application/json` on both POSTs, because both routes call `request.json()`.
 * The CSRF origin gate in `proxy.ts` covers unsafe methods before the session is established.
 */

import { useCallback, useMemo, useState } from 'react';
import { PHASE_SCOPES, RATIONALE_MAX_DECISION, SELECTION_MODES, STRATEGY_OPTION_FIELDS, UNKNOWN_FIELD } from '@acbp/contracts';
import type { StrategyGenerationDTO, StrategyOptionFields, StrategyPhaseScope, StrategySelectionMode } from '@acbp/contracts';
import { fieldCellsFor, toStrategyView, type OptionView, type StrategyView } from './strategy-view';
import { buildDecisionRequest } from './decision-request';
import { networkFailure, outcomeFor, type Outcome } from './decision-outcome';
import { generateNetworkFailure, generateOutcomeFor, type GenerateOutcome, type GenerateVerb } from './generate-outcome';

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

/** Which control produced the outcome currently on screen, so it renders beside the button that caused it. */
type OutcomeSource = 'selection' | 'decision';

function blankFields(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) out[f] = '';
  return out;
}

function labelForField(field: string): string {
  return field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** The 16 fields of one option as an editable draft. The sentinel is carried through as the CONSTANT. */
function fieldsFromOption(option: OptionView): Record<string, string> {
  const next: Record<string, string> = {};
  for (const c of option.cells) next[c.field] = c.determined ? c.text : UNKNOWN_FIELD;
  return next;
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
  const [outcome, setOutcome] = useState<{ source: OutcomeSource; result: Outcome } | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [genOutcome, setGenOutcome] = useState<GenerateOutcome | null>(null);

  const view: StrategyView = useMemo(() => toStrategyView(generation), [generation]);
  const base = `/api/companies/${encodeURIComponent(companyId)}`;
  const options = view.options;

  const reread = useCallback(async (): Promise<boolean> => {
    try {
      // No query string: `GET /strategy` allows NO parameters and refuses an unknown one with a bounded 400.
      const res = await fetch(`${base}/strategy`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        setReadError('The strategy could not be re-read just now, so what is shown may be out of date.');
        return false;
      }
      const body = (await res.json()) as { generation: StrategyGenerationDTO | null };
      setGeneration(body.generation);
      setReadError(null);
      return true;
    } catch {
      setReadError('The strategy could not be re-read just now, so what is shown may be out of date.');
      return false;
    }
  }, [base]);

  /** Prefill the 16-field grid from an option. Called from BOTH the radio and the mode switch — see below. */
  const prefillFrom = useCallback(
    (ordinal: number | null): void => {
      if (ordinal === null) return;
      const option = options.find((o) => o.ordinal === ordinal);
      if (option !== undefined) setChosenFields(fieldsFromOption(option));
    },
    [options],
  );

  /*
   * THE MODE SWITCH PREFILLS, NOT ONLY THE RADIO. `onChange` fires only when a radio's checked state
   * CHANGES, so a founder who picked option 2 in `select` mode and then switched to `edit` left the already
   * -checked radio untouched: no change event, no prefill, and sixteen empty REQUIRED boxes under a control
   * claiming a base option was chosen. The prefill has to hang off whichever action makes it newly relevant.
   */
  const changeMode = useCallback(
    (next: StrategySelectionMode): void => {
      setMode(next);
      setProblem(null);
      if (next === 'edit') prefillFrom(selectedOrdinal);
    },
    [prefillFrom, selectedOrdinal],
  );

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
      setOutcome({ source: 'selection', result });
      if (result.persisted === true || result.persisted === null) await reread();
    } catch {
      setOutcome({ source: 'selection', result: networkFailure('selection') });
    } finally {
      setBusy(false);
    }
  }, [base, view.generationId, mode, selectedOrdinal, chosenFields, phaseScope, reasons, reread]);

  const hardenDecision = useCallback(async (): Promise<void> => {
    const selectionId = view.selection?.selectionId;
    if (view.generationId === null || selectionId === undefined) return;
    /*
     * NEVER HARDEN AGAINST A SELECTION THIS PAGE IS NO LONGER SURE OF. A decision is IMMUTABLE, so a
     * `selectionId` left over from before a failed re-read would permanently harden the wrong choice. When
     * the page knows its own view is stale, the honest move is to refuse locally and make the founder reload.
     */
    if (readError !== null) {
      setProblem('This page could not confirm the current state after the last request, so it will not record a decision against what it is showing. Reload first — a decision is immutable, and hardening the wrong choice cannot be undone.');
      return;
    }
    if (rationale.length > RATIONALE_MAX_DECISION) {
      // Bounded HERE as well as on the server, because the server's refusal for an over-long rationale is the
      // same opaque 400 as every other `invalid` and names no field.
      setProblem(`The reason is too long — ${String(rationale.length)} characters against a limit of ${String(RATIONALE_MAX_DECISION)}. It is optional, so shortening it or clearing it both work.`);
      return;
    }
    setProblem(null);
    setOutcome(null);
    setBusy(true);
    try {
      const res = await fetch(`${base}/decisions`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        // `rationale` is OPTIONAL and a missing one must never block the record (CDR-038 §6-G2). A blank box
        // therefore OMITS the key entirely rather than sending an empty string the domain would have to judge.
        body: JSON.stringify(rationale.trim() === '' ? { generationId: view.generationId, selectionId } : { generationId: view.generationId, selectionId, rationale: rationale.trim() }),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        /* status decides */
      }
      const result = outcomeFor(res.status, body, res.headers.get('retry-after'), 'decision');
      setOutcome({ source: 'decision', result });
      if (result.persisted === true || result.persisted === null) await reread();
    } catch {
      setOutcome({ source: 'decision', result: networkFailure('decision') });
    } finally {
      setBusy(false);
    }
  }, [base, view.generationId, view.selection?.selectionId, rationale, readError, reread]);

  /*
   * GENERATE and RECOMMEND. Both are metered against a per-company ceiling and both are owner-only, and the
   * ceiling is debited only AFTER that authorization (ACBP-API-008 `2046c69`) — so a refused caller has spent
   * nothing, and `generate-outcome.ts` is careful never to imply otherwise.
   *
   * `strategy/generate` takes NO body: everything it needs (the confirmed understanding, the approved phase)
   * the domain reads for itself, and a body here would be a second, forgeable source for facts the server
   * already owns. `strategy/recommend` takes exactly one field, the generation to recommend over.
   */
  const generate = useCallback(
    async (what: GenerateVerb): Promise<void> => {
      setGenOutcome(null);
      setBusy(true);
      try {
        const url = what === 'strategy' ? `${base}/strategy/generate` : `${base}/strategy/recommend`;
        const init: RequestInit =
          what === 'strategy'
            ? { method: 'POST', headers: { accept: 'application/json' } }
            : { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ generationId: view.generationId }) };
        const res = await fetch(url, init);
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          /* the status decides */
        }
        const result = generateOutcomeFor(res.status, body, res.headers.get('retry-after'), what);
        setGenOutcome(result);
        // Re-read on success AND on unknown: a 500 can fail either side of the write, so looking is the only
        // way to find out what actually exists.
        if (result.produced === true || result.produced === null) await reread();
      } catch {
        setGenOutcome(generateNetworkFailure(what));
      } finally {
        setBusy(false);
      }
    },
    [base, view.generationId, reread],
  );
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
          Generating options is a model-driven step. It is metered against a per-company ceiling, and it reads the CONFIRMED understanding — so if the interview has not produced one, or it has not been confirmed, the
          server will say which of those applies rather than failing vaguely.
        </p>
        <div className="cs-control-row">
          <button type="button" className="cs-btn cs-btn--primary" onClick={() => void generate('strategy')} disabled={busy}>
            {busy ? 'Generating…' : 'Generate strategy options'}
          </button>
        </div>
        <div aria-live="polite" className="cs-outcome-region">
          {genOutcome === null ? null : <GenerateBlock outcome={genOutcome} />}
        </div>
      </section>
    );
  }

  // A generation with NO options is a real response shape (`fewer_than_three` has no floor at 1). `select`
  // and `edit` both need one to point at, so they are refused with a reason rather than offered as controls
  // that cannot be completed.
  const noOptions = options.length === 0;
  const modeUnavailable = (m: StrategySelectionMode): boolean => noOptions && (m === 'select' || m === 'edit');
  const effectiveMode: StrategySelectionMode = modeUnavailable(mode) ? 'combine' : mode;

  return (
    <>
      <StrategyCaveats view={view} />
      <RecommendationCard view={view} onRecommend={() => void generate('recommendation')} busy={busy} genOutcome={genOutcome} />
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
        {noOptions ? (
          <p className="cs-help">
            This generation carries no options, so “choose one” and “start from one” have nothing to point at and are not offered. Building a new option from scratch, or rejecting the generation, both still work.
          </p>
        ) : null}

        <div className="cs-form">
          <fieldset className="cs-field">
            <legend className="cs-label">What do you want to do?</legend>
            <div className="cs-choices">
              {SELECTION_MODES.filter((m) => !modeUnavailable(m)).map((m) => (
                <label key={m} className="cs-choice">
                  <input type="radio" name="cs-st-mode" value={m} checked={effectiveMode === m} onChange={() => changeMode(m)} disabled={busy} />
                  <span>{MODE_LABEL[m]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {effectiveMode === 'select' || effectiveMode === 'edit' ? (
            <fieldset className="cs-field">
              <legend className="cs-label">{effectiveMode === 'select' ? 'Which option?' : 'Which option do you want to start from? (optional)'}</legend>
              <div className="cs-choices">
                {effectiveMode === 'edit' ? (
                  <label className="cs-choice">
                    <input type="radio" name="cs-st-option" checked={selectedOrdinal === null} onChange={() => setSelectedOrdinal(null)} disabled={busy} />
                    <span>Start from nothing</span>
                  </label>
                ) : null}
                {options.map((o) => (
                  <label key={o.optionId} className="cs-choice">
                    <input
                      type="radio"
                      name="cs-st-option"
                      checked={selectedOrdinal === o.ordinal}
                      onChange={() => {
                        setSelectedOrdinal(o.ordinal);
                        // PREFILL FROM THE BASE, for an edit only. An edit starting from a blank grid would
                        // make "change one thing" mean retyping sixteen.
                        if (effectiveMode === 'edit') prefillFrom(o.ordinal);
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

          {effectiveMode === 'edit' || effectiveMode === 'combine' ? (
            <fieldset className="cs-field">
              <legend className="cs-label">The option you are recording</legend>
              <p className="cs-help">
                All {STRATEGY_OPTION_FIELDS.length} fields are required. Write “{UNKNOWN_FIELD}” where you genuinely do not know — that is recorded as undetermined rather than as a guess, and it is the same marker
                the model uses.
              </p>
              <div className="cs-strat-grid">
                {STRATEGY_OPTION_FIELDS.map((f) => (
                  <label key={f} className="cs-field">
                    <span className="cs-label">{labelForField(f)}</span>
                    <textarea className="cs-input cs-textarea" rows={2} value={chosenFields[f] ?? ''} onChange={(e) => setChosenFields((prev) => ({ ...prev, [f]: e.target.value }))} disabled={busy} />
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {effectiveMode === 'reject' ? (
            <label className="cs-field">
              <span className="cs-label">Why does none of these fit?</span>
              <textarea className="cs-input cs-textarea" rows={4} value={reasons} onChange={(e) => setReasons(e.target.value)} disabled={busy} />
              <span className="cs-help">A rejection is recorded with its reasons, and those reasons are what a later generation is steered by.</span>
            </label>
          ) : (
            /* PHASE SCOPE IS NOT OFFERED ON A REJECTION, because the validator refuses a reject that carries
               one — "phase scope is meaningless for reject". The builder drops it as well, so a stale value
               cannot leak through this control merely being unmounted. */
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
              {busy ? 'Recording…' : 'Record this choice'}
            </button>
          </div>
        </div>

        {/* ALWAYS MOUNTED. A live region inserted into the DOM together with its text is frequently not
            announced at all; the container has to exist and be empty first, and only its CONTENT change. */}
        <div aria-live="assertive" className="cs-outcome-region">
          {problem === null ? null : <p className="cs-control-outcome cs-control-outcome--invalid">{problem}</p>}
        </div>
        <div aria-live="polite" className="cs-outcome-region">
          {outcome !== null && outcome.source === 'selection' ? <OutcomeBlock outcome={outcome.result} /> : null}
          {readError === null ? null : <p className="cs-control-outcome cs-control-outcome--error">{readError}</p>}
        </div>
      </section>

      {/* THE HARDEN STEP, REACHABLE WHENEVER THE LATEST CHOICE IS NOT THE ONE A DECISION COVERS — not merely
          when no decision exists at all. See the file header for the defect that wording replaced. */}
      {view.selection !== null && !view.decisionCoversLatestSelection ? (
        <section className="cs-card" aria-labelledby="cs-st-harden-h">
          <div className="cs-card-h">
            <h2 className="cs-card-t" id="cs-st-harden-h">
              Harden this choice into a decision
            </h2>
          </div>
          <p className="cs-help">
            {view.decision === null
              ? 'A choice is recorded; the immutable DECISION over it is a second, separate step, and it is the one the planning gate reads. Until it exists, this choice does not affect planning.'
              : 'The decision on record hardened an EARLIER choice than the one above. Recording a decision over the latest choice replaces which one the planning gate reads.'}
          </p>
          <label className="cs-field">
            <span className="cs-label">Why? (optional)</span>
            <textarea className="cs-input cs-textarea" rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} disabled={busy} />
            <span className="cs-help">
              Leaving this blank never blocks the record. At most {String(RATIONALE_MAX_DECISION)} characters.
            </span>
          </label>
          <div className="cs-control-row">
            <button type="button" className="cs-btn cs-btn--primary" onClick={() => void hardenDecision()} disabled={busy}>
              {busy ? 'Recording…' : 'Record the decision'}
            </button>
          </div>
          <div aria-live="polite" className="cs-outcome-region">
            {outcome !== null && outcome.source === 'decision' ? <OutcomeBlock outcome={outcome.result} /> : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

function OutcomeBlock({ outcome }: { outcome: Outcome }): React.JSX.Element {
  return (
    <div className={`cs-control-outcome cs-control-outcome--${outcome.kind}`} data-kind={outcome.kind}>
      <strong>{outcome.title}</strong> <span>{outcome.detail}</span>
    </div>
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

function RecommendationCard({ view, onRecommend, busy, genOutcome }: { view: StrategyView; onRecommend: () => void; busy: boolean; genOutcome: GenerateOutcome | null }): React.JSX.Element {
  const rec = view.recommendation;
  // The recommendation names an option BY ID; the badge shows the option's own position. If the id resolves
  // to nothing in this generation, "option 0" would be a number no option has — so it says so instead.
  const target = rec === null ? undefined : view.options.find((o) => o.optionId === rec.recommendedOptionId);
  return (
    <section className="cs-card" aria-labelledby="cs-st-rec-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-st-rec-h">
          Advisory recommendation
        </h2>
        {rec === null ? (
          <span className="cs-badge cs-badge--muted">none recorded</span>
        ) : target === undefined ? (
          <span className="cs-badge cs-badge--warning">names an option not in this generation</span>
        ) : (
          <span className="cs-badge cs-badge--primary">option {String(target.ordinal + 1)}</span>
        )}
      </div>
      <p className="cs-help">{view.recommendationNote}</p>
      {/* ASKING IS A SEPARATE, METERED CALL. It never selects anything — the decision below stays the owner's,
          which is why the button says "ask for" rather than "get". */}
      <div className="cs-control-row">
        <button type="button" className="cs-btn" onClick={onRecommend} disabled={busy}>
          {busy ? 'Asking…' : rec === null ? 'Ask for a recommendation' : 'Ask again'}
        </button>
      </div>
      <div aria-live="polite" className="cs-outcome-region">
        {genOutcome === null ? null : <GenerateBlock outcome={genOutcome} />}
      </div>
      {rec === null ? null : (
        <>
          <p className="cs-item-body">{rec.rationale}</p>
          {/* SENSITIVITIES ARE SHOWN, NOT COLLAPSED. They are the half that says what would change the
              recommendation, and a recommendation without them reads as more certain than it is. */}
          <p className="cs-help">What would change this: {rec.sensitivities}</p>
        </>
      )}
    </section>
  );
}

function ComparisonCard({ view }: { view: StrategyView }): React.JSX.Element {
  /*
   * THE "YOUR CHOICE" MARKER IS ONLY HONEST FOR A `select`. On an `edit` the selection also carries a
   * `selectedOptionId` — the BASE the founder started from and then changed — so badging that column as the
   * choice labels the option they moved away from. On `combine` there is no id at all. The recorded content
   * for edit/combine is shown by {@link DecisionRecordCard} instead, where it can be labelled correctly.
   */
  const selectedId = view.selection !== null && view.selection.mode === 'select' ? view.selection.selectedOptionId : null;
  return (
    <section className="cs-card" aria-labelledby="cs-st-cmp-h">
      <div className="cs-card-h">
        <h2 className="cs-card-t" id="cs-st-cmp-h">
          The options, compared
        </h2>
        <span className="cs-badge cs-badge--muted">generated from understanding v{String(view.understandingVersion ?? 0)}</span>
      </div>
      {view.options.length === 0 ? (
        <p className="cs-empty">This generation carries no options to compare.</p>
      ) : (
        /* Horizontal scroll lives on the wrapper, so a wide table never makes the PAGE scroll sideways. It is
           focusable and labelled because a scroll container that only a mouse can reach strands a keyboard
           user at whatever columns happen to fit. */
        <div className="cs-table-scroll" tabIndex={0} role="region" aria-label="Strategy options compared field by field. Scrollable horizontally.">
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
      )}
    </section>
  );
}

function OptionCell({ option, row }: { option: OptionView; row: number }): React.JSX.Element {
  const cell = option.cells[row];
  if (cell === undefined) return <td />;
  // AN UNDETERMINED FIELD IS MARKED, NOT PRINTED AS CONTENT. The contract requires the model to write a
  // labelled sentinel where it cannot determine a field precisely so this can be shown as a gap.
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
      </div>

      {/* NOT A "PLANNING UNLOCKED" BADGE. This read carries only the decision for the DISPLAYED generation,
          while the planning gate reads the company's latest decision across ALL generations, so a badge
          claiming the gate's answer could contradict the server in either direction. The sentence says
          exactly what is known and names what is not. */}
      <p className="cs-help">
        {view.generationDecisionAllowsPlanning
          ? 'The decision recorded against this generation is one that permits planning. Whether planning is actually open also depends on the company’s most recent decision across every generation, which this page does not read — so treat this as being about this generation, not as the platform’s answer.'
          : 'No decision permitting planning is recorded against this generation. The company may still have a permitting decision on a different generation; this page does not read that, and does not guess.'}
      </p>

      {view.decisionState === 'none' ? (
        <p className="cs-empty">No choice has been recorded over this generation yet.</p>
      ) : (
        <ul className="cs-list">
          {selection === null ? null : (
            <li className="cs-item cs-stack">
              <span className="cs-item-title">Latest choice: {selection.mode}</span>
              <span className="cs-help">
                {selection.phaseScope === null ? 'No phase scope was stated.' : PHASE_LABEL[selection.phaseScope]} · recorded {selection.createdAt}
              </span>
              {selection.reasons === null ? null : <span className="cs-item-body">{selection.reasons}</span>}
              {/* THE AUTHORED OPTION, WHICH IS THE WHOLE CONTENT OF AN edit OR combine. Without it, two
                  selections carrying completely different strategies render identically — as the single
                  word "edit" — and the company's actual recorded strategy appears nowhere on this screen. */}
              {selection.chosenFields === null ? null : <ChosenFields fields={selection.chosenFields} />}
            </li>
          )}
          {decision === null ? (
            <li className="cs-item cs-stack">
              <span className="cs-item-title">Not yet hardened into a decision</span>
              <span className="cs-help">A choice on its own does not affect planning; the immutable decision record is what the gate reads.</span>
            </li>
          ) : (
            <li className="cs-item cs-stack">
              {/* THE MODE COMES FROM THE DECISION, NEVER FROM THE LATEST SELECTION. The DTO carries it
                  snapshot at record time precisely because the two can differ. */}
              <span className="cs-item-title">Decision recorded: {decision.mode}</span>
              <span className="cs-help">
                Over {String(decision.optionsConsideredCount)} options, at understanding v{String(decision.understandingVersion)} · {decision.createdAt}
              </span>
              {decision.rationale === null ? null : <span className="cs-item-body">{decision.rationale}</span>}
              {decision.mode === 'reject' ? <span className="cs-help">A rejection is a real decision, and it deliberately does not permit planning.</span> : null}
            </li>
          )}
          {view.decisionCoversLatestSelection ? null : (
            <li className="cs-item cs-stack cs-strat-caveat cs-strat-caveat--warning">
              The recorded decision hardened an EARLIER choice than the latest one shown above. The newer choice is not what the planning gate reads — the control below records a decision over it.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** The 16 authored fields of an `edit` or `combine` selection, rendered through the same cell mapper as the
 *  comparison table so the sentinel is handled identically in both places. */
function ChosenFields({ fields }: { fields: StrategyOptionFields }): React.JSX.Element {
  const cells = fieldCellsFor(fields);
  return (
    <details className="cs-strat-chosen">
      <summary>The option you recorded, in full</summary>
      <dl className="cs-co-meta cs-co-meta--wide">
        {cells.map((c) => (
          <div key={c.field}>
            <dt>{c.label}</dt>
            <dd className={c.determined ? undefined : 'cs-strat-undetermined'}>{c.determined ? c.text : <em>Not determined</em>}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** One outcome block for the generate/recommend controls. Same vocabulary as the decision outcomes. */
function GenerateBlock({ outcome }: { outcome: GenerateOutcome }): React.JSX.Element {
  return (
    <div className={`cs-control-outcome cs-control-outcome--${outcome.kind}`} data-kind={outcome.kind}>
      <strong>{outcome.title}</strong> <span>{outcome.detail}</span>
    </div>
  );
}